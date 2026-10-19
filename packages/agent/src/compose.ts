import type { VisitorFact } from '@kaki/kb';
import { route, type GenerateRequest, type LlmGateway } from '@kaki/llm-gateway';
import { buildVisitorPrompt, type HistoryMessage } from './prompt.js';
import { renderSegment } from './render.js';
import { Segmenter } from './segment.js';
import { assignRefs } from './slots.js';
import { texts } from './texts.js';
import { verifySegment, type Violation } from './verify.js';

/** One regeneration from the released prefix, then escalate (ADR-008 decision 5; D2). */
export const MAX_REGENERATIONS = 1;

export type ComposeOutcome = 'answered' | 'escalated' | 'gate_closed' | 'unavailable';

export interface ComposeInput {
  /** This turn's retrieved facts, best first: the only values the reply may contain. */
  facts: VisitorFact[];
  /** Earlier messages, oldest first, ending with the visitor's current message. */
  history: HistoryMessage[];
  businessName: string;
  gstRegistered: boolean;
  meta: GenerateRequest['meta'];
}

export interface ComposeDeps {
  llm: LlmGateway;
  /** The send gate (ADR-013 decision 3), re-checked before each segment is released. */
  gateOpen: () => Promise<boolean>;
  /** Releases one verified segment to the channel. Nothing else is ever published. */
  publish: (segment: { seq: number; text: string }) => Promise<void>;
  now?: () => number;
}

export interface ComposeResult {
  outcome: ComposeOutcome;
  /** What the visitor has been shown, joined: the message to store. */
  text: string;
  segments: string[];
  factIds: string[];
  /** Every guardrail failure, for the audit log (GOV-01). */
  violations: Violation[];
  attempts: number;
  timings: { firstSegmentMs: number | null; totalMs: number };
}

type Step = { kind: 'ok' } | { kind: 'fail'; violations: Violation[] } | { kind: 'closed' };

/**
 * The verified-segment pipeline (ADR-008): stream → hold back → segment → render slots
 * → verify → gate → release. Pure apart from its deps, so the worker and the eval
 * runner share it.
 */
export async function composeReply(input: ComposeInput, deps: ComposeDeps): Promise<ComposeResult> {
  const now = deps.now ?? (() => performance.now());
  const start = now();
  let firstSegmentAt: number | null = null;
  const facts = assignRefs(input.facts);
  const visitorTexts = input.history.filter((m) => m.role === 'user').map((m) => m.content);
  const released: string[] = [];
  const factIds = new Set<string>();
  const violations: Violation[] = [];

  const result = (outcome: ComposeOutcome, attempts: number): ComposeResult => ({
    outcome,
    text: released.join(' '),
    segments: [...released],
    factIds: [...factIds],
    violations,
    attempts,
    timings: {
      firstSegmentMs: firstSegmentAt === null ? null : Math.round(firstSegmentAt - start),
      totalMs: Math.round(now() - start),
    },
  });

  async function release(text: string): Promise<boolean> {
    if (!(await deps.gateOpen())) return false;
    await deps.publish({ seq: released.length, text });
    if (firstSegmentAt === null) firstSegmentAt = now();
    released.push(text);
    return true;
  }

  async function handle(raw: string): Promise<Step> {
    const rendered = renderSegment(raw, facts, input.gstRegistered);
    if (!rendered.ok) return { kind: 'fail', violations: rendered.violations };
    const verdict = verifySegment(rendered.text, rendered.spans, visitorTexts);
    if (!verdict.ok) return { kind: 'fail', violations: verdict.violations };
    if (!(await release(rendered.text))) return { kind: 'closed' };
    for (const id of rendered.factIds) factIds.add(id);
    return { kind: 'ok' };
  }

  let lastFailure: Violation[] = [];
  for (let attempt = 0; attempt <= MAX_REGENERATIONS; attempt++) {
    const req = buildVisitorPrompt({
      businessName: input.businessName,
      gstRegistered: input.gstRegistered,
      facts,
      ordered: input.facts,
      history: input.history,
      regeneration:
        attempt === 0
          ? undefined
          : {
              prefix: released.join(' '),
              violations: lastFailure.map((v) => `${v.kind} "${v.text}"`),
            },
      meta: input.meta,
      model: route('reply'),
    });
    const segmenter = new Segmenter();
    let step: Step = { kind: 'ok' };
    try {
      outer: for await (const chunk of deps.llm.stream(req)) {
        if (chunk.type !== 'text') continue;
        for (const raw of segmenter.push(chunk.text)) {
          step = await handle(raw);
          if (step.kind !== 'ok') break outer;
        }
      }
      if (step.kind === 'ok') {
        const rest = segmenter.flush();
        if (rest) step = await handle(rest);
      }
    } catch {
      // NFR-04: the provider failed. Whatever was already verified stays; the turn
      // closes with the fallback text.
      return result('unavailable', attempt + 1);
    }
    if (step.kind === 'closed') return result('gate_closed', attempt + 1);
    if (step.kind === 'ok') {
      if (released.length) return result('answered', attempt + 1);
      step = { kind: 'fail', violations: [{ kind: 'slot_syntax', text: '(empty reply)' }] };
    }
    violations.push(...step.violations);
    lastFailure = step.violations;
  }
  // UC-20 6a: verification failed twice. The visitor is told the team will confirm.
  const shown = await release(texts.escalation);
  return result(shown ? 'escalated' : 'gate_closed', MAX_REGENERATIONS + 1);
}
