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

export type AnswerOutcome = ComposeOutcome | 'out_of_scope' | 'unsure';

export interface ReplyPlan {
  /** Call the reply model. */
  compose: boolean;
  /** The fixed text that replaces the model's reply, if any. */
  lead: 'out_of_scope' | 'unsure' | null;
  /** System texts released after the verified reply (or after `lead`). */
  closing: ReplyKey[];
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
  // 1. Nothing to answer, and a task said what to say: no model call.
  if (!hasAnswer && replies.length)
    return { compose: false, lead: 'out_of_scope', closing: replies.slice(1) };
  // 2. Unsure and nothing in the KB: say so rather than guess.
  const lowConfidence = plan.fallback || plan.confidence < input.minConfidence;
  if (hasAnswer && input.factCount === 0 && lowConfidence)
    return { compose: false, lead: 'unsure', closing: replies };
  // 3. A grounded, verified reply, then any task texts.
  return { compose: true, lead: null, closing: replies };
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
  const t = textsFor(input.language ?? 'en');
  return key === 'unsure' ? t.unsure : t.outOfScope(input.businessName);
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
      outcome: open ? decided.lead! : 'gate_closed',
      composed: false,
      text: open ? text : '',
      segments: open ? [text] : [],
      factIds: [],
      slots: [],
      violations: [],
      attempts: 0,
      models: [],
      timings: { firstSegmentMs: open ? ms : null, totalMs: ms },
    };
  }
  const composed = await composeReply(
    { ...input, outOfScope: input.replies.includes('out_of_scope') },
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
