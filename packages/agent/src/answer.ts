import {
  composeReply,
  type ComposeDeps,
  type ComposeInput,
  type ComposeOutcome,
  type ComposeResult,
} from './compose.js';
import type { ReplyKey } from './dispatch.js';
import type { TurnPlan } from './plan.js';
import { textsFor } from './texts.js';

/**
 * The turn's reply decision (AGT-04; ADR-025 decision 3; FEAT-023 §5.3, D1, D9), shared
 * by the worker and the eval runner so both run the same code.
 */

/** `refused` (FEAT-025): an injection, impersonation, advice or illegal-request text. */
export type AnswerOutcome = ComposeOutcome | 'out_of_scope' | 'unsure' | 'refused';

export interface ReplyPlan {
  /** Call the reply model. */
  compose: boolean;
  /** The fixed text that replaces the model's reply, if any. */
  lead: ReplyKey | 'unsure' | null;
  /** System texts released after the verified reply (or after `lead`). */
  closing: ReplyKey[];
}

/** The triage flags' refusals (FEAT-025 §5.3), ahead of any task's text. */
function flagKeys(plan: TurnPlan): ReplyKey[] {
  return [
    ...(plan.flags.injection ? (['injection'] as const) : []),
    ...(plan.flags.impersonation ? (['impersonation'] as const) : []),
  ];
}

export function replyPlan(input: {
  plan: TurnPlan;
  factCount: number;
  /** The tenant's routing knob (FEAT-004 D10): below it, triage is unsure. */
  minConfidence: number;
  replies: ReplyKey[];
}): ReplyPlan {
  const { plan, replies } = input;
  const hasAnswer = plan.tasks.some((t) => t.kind === 'answer');
  const flags = flagKeys(plan);
  // 1. Nothing to answer, and a task or a flag said what to say: no model call. A task's
  // text leads (FEAT-023 kept); a flag's text, which already offers help with the
  // business, stands alone.
  if (!hasAnswer && replies.length)
    return { compose: false, lead: replies[0]!, closing: replies.slice(1) };
  if (!hasAnswer && flags.length) return { compose: false, lead: flags[0]!, closing: [] };
  // 2. A flagged message with nothing public to give (UC-20 3d): the flag's text (FEAT-025).
  if (hasAnswer && flags.length && input.factCount === 0)
    return { compose: false, lead: flags[0]!, closing: [] };
  // 3. Unsure and nothing in the KB: say so rather than guess.
  const lowConfidence = plan.fallback || plan.confidence < input.minConfidence;
  if (hasAnswer && input.factCount === 0 && lowConfidence)
    return { compose: false, lead: 'unsure', closing: replies };
  // 4. A grounded, verified reply, then any task texts. The flags reach the model's tail.
  return { compose: true, lead: null, closing: replies };
}

/** The outcome of a fixed lead text (FEAT-023, FEAT-025). */
function leadOutcome(lead: ReplyKey | 'unsure'): AnswerOutcome {
  // A blocked topic (FEAT-054) is a business's own out-of-scope line.
  if (lead === 'blocked_topic') return 'out_of_scope';
  return lead === 'out_of_scope' || lead === 'unsure' ? lead : 'refused';
}

export interface AnswerInput extends ComposeInput {
  plan: TurnPlan;
  replies: ReplyKey[];
  minConfidence: number;
}

export type AnswerResult = Omit<ComposeResult, 'outcome'> & {
  outcome: AnswerOutcome;
  /** False when no reply-model call was made. */
  composed: boolean;
};

function render(key: ReplyKey | 'unsure', input: AnswerInput): string {
  const t = textsFor(input.language ?? 'en', input.persona);
  const b = input.businessName;
  switch (key) {
    case 'unsure':
      return t.unsure;
    case 'out_of_scope':
      return t.outOfScope(b);
    case 'advice':
      return t.advice(b);
    case 'illegal':
      return t.illegal(b);
    case 'blocked_topic':
      return t.blockedTopic(b);
    case 'injection':
      return t.injection(b);
    case 'impersonation':
      return t.impersonation(b);
  }
}

/** Runs `replyPlan`, then a fixed text or the verified-segment pipeline, plus the closing texts. */
export async function answerTurn(input: AnswerInput, deps: ComposeDeps): Promise<AnswerResult> {
  const now = deps.now ?? (() => performance.now());
  const decided = replyPlan({
    plan: input.plan,
    factCount: input.facts.length,
    minConfidence: input.minConfidence,
    replies: input.replies,
  });
  if (!decided.compose) {
    const start = now();
    const text = [decided.lead!, ...decided.closing].map((k) => render(k, input)).join(' ');
    const open = await deps.gateOpen();
    if (open) await deps.publish({ seq: 0, text });
    const ms = Math.round(now() - start);
    return {
      outcome: open ? leadOutcome(decided.lead!) : 'gate_closed',
      composed: false,
      text: open ? text : '',
      segments: open ? [text] : [],
      factIds: [],
      slots: [],
      violations: [],
      attempts: 0,
      emojiRemoved: false,
      models: [],
      timings: { firstSegmentMs: open ? ms : null, totalMs: ms },
    };
  }
  const composed = await composeReply(
    {
      ...input,
      outOfScope: input.replies.some((k) => k !== 'injection' && k !== 'impersonation'),
      injection: input.plan.flags.injection,
      impersonation: input.plan.flags.impersonation,
    },
    deps,
  );
  const result: AnswerResult = { ...composed, composed: true };
  if (
    decided.closing.length &&
    (composed.outcome === 'answered' || composed.outcome === 'escalated')
  ) {
    const text = decided.closing.map((k) => render(k, input)).join(' ');
    if (await deps.gateOpen()) {
      await deps.publish({ seq: composed.segments.length, text });
      result.segments = [...composed.segments, text];
      result.text = [composed.text, text].filter(Boolean).join(' ');
    } else result.outcome = 'gate_closed';
  }
  return result;
}
