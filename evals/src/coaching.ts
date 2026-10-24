import {
  candidatesOf,
  COACH_TRIAGE_SYSTEM,
  proposeChange,
  triage,
  type TurnPlan,
} from '@kaki/agent';
import { sgDayAfter, type ProposalInput, type VisitorFact } from '@kaki/kb';
import type { LlmGateway } from '@kaki/llm-gateway';
import type { WeeklyHours } from '@kaki/tenancy';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * The coaching subset (FEAT-027 §5.6, AGT-17, AC-14): an owner message through the
 * coaching triage and the propose step, on the fixture tenant's facts and hours. A case
 * passes when triage detects `correct` exactly when it should, and the proposal has the
 * right kind, fact and changed field. `realOnly` cases run with a real model only.
 */
export const CoachingExpected = z.discriminatedUnion('kind', [
  z.object({ correct: z.literal(false), kind: z.literal('none') }).strict(),
  z.object({ correct: z.literal(true), kind: z.literal('unclear') }).strict(),
  z.object({ correct: z.literal(true), kind: z.literal('add_faq') }).strict(),
  z
    .object({
      correct: z.literal(true),
      kind: z.literal('edit_fact'),
      fact: z.uuid(),
      field: z.enum([
        'name',
        'price',
        'unit',
        'question',
        'answer',
        'title',
        'details',
        'valid_until',
      ]),
      priceCents: z.int().optional(),
      validUntil: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      correct: z.literal(true),
      kind: z.literal('edit_hours'),
      days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1),
      /** Every changed day's new hours, `HH:MM-HH:MM` or `closed`. */
      hours: z.string().optional(),
    })
    .strict(),
]);
export type CoachingExpected = z.infer<typeof CoachingExpected>;

export const CoachingCase = z
  .object({
    id: z.string(),
    fast: z.boolean().default(false),
    realOnly: z.boolean().default(false),
    text: z.string().min(1),
    expected: z.preprocess(
      (v) =>
        v && typeof v === 'object' && (v as { correct?: unknown }).correct === false
          ? { kind: 'none', ...v }
          : v,
      CoachingExpected,
    ),
  })
  .strict();
export type CoachingCase = z.infer<typeof CoachingCase>;

export const MIN_COACHING_CASES = 16;

export function loadCoachingCases(path: string): CoachingCase[] {
  const file = z
    .object({ $comment: z.string().optional(), cases: z.array(CoachingCase) })
    .parse(JSON.parse(readFileSync(path, 'utf8')));
  const ids = new Set<string>();
  for (const c of file.cases) {
    if (ids.has(c.id)) throw new Error(`duplicate coaching case ${c.id}`);
    ids.add(c.id);
  }
  return file.cases;
}

export interface CoachingRun {
  plan: TurnPlan;
  proposal: ProposalInput | null;
}

/** One case through the coaching triage and, for a correction, the propose step. */
export async function runCoachingCase(
  llm: LlmGateway,
  fixture: { tenantId: string; facts: VisitorFact[]; hours: WeeklyHours | null },
  c: CoachingCase,
): Promise<CoachingRun> {
  const meta = { tenantId: fixture.tenantId };
  const plan = await triage(llm, {
    history: [{ role: 'user', content: c.text }],
    meta,
    system: COACH_TRIAGE_SYSTEM,
  });
  if (!plan.tasks.some((t) => t.kind === 'correct')) return { plan, proposal: null };
  const proposal = await proposeChange(llm, {
    ownerText: c.text,
    previousAnswer: null,
    ctx: { candidates: candidatesOf(fixture.facts), hours: fixture.hours, profileVersion: 1 },
    meta,
  });
  return { plan, proposal };
}

const FIELD_OF: Record<string, string> = { priceCents: 'price' };

/** The wire field names an edit changes, against the fact as it is. */
function changedFields(
  fact: VisitorFact,
  patch: Extract<ProposalInput, { kind: 'edit_fact' }>['patch'],
): string[] {
  const out = new Set<string>();
  const before = fact.value as unknown as Record<string, unknown>;
  const after = (patch.value ?? {}) as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (k !== 'currency' && k in after && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      out.add(FIELD_OF[k] ?? k);
  if (patch.validity?.validUntil !== undefined) out.add('valid_until');
  return [...out];
}

const rangeOf = (day: { open: string; close: string }[]) =>
  day.length ? day.map((i) => `${i.open}-${i.close}`).join(',') : 'closed';

/** The problems with a case's run; none means it passed. */
export function scoreCoaching(c: CoachingCase, facts: VisitorFact[], run: CoachingRun): string[] {
  const e = c.expected;
  const detected = run.plan.tasks.some((t) => t.kind === 'correct');
  if (!e.correct) return detected ? ['a question was triaged as a correction'] : [];
  if (!detected) return ['the correction was not detected'];
  const p = run.proposal;
  if (e.kind === 'unclear') return p ? [`proposed ${p.kind}; expected to ask for the item`] : [];
  if (!p) return [`no proposal; expected ${e.kind}`];
  if (p.kind !== e.kind) return [`proposed ${p.kind}; expected ${e.kind}`];
  const problems: string[] = [];
  if (e.kind === 'edit_fact' && p.kind === 'edit_fact') {
    if (p.factId !== e.fact) return [`edited fact ${p.factId}; expected ${e.fact}`];
    const fact = facts.find((f) => f.id === p.factId)!;
    const fields = changedFields(fact, p.patch);
    if (!fields.includes(e.field))
      problems.push(`changed ${fields.join(', ') || 'nothing'}; expected ${e.field}`);
    const cents = (p.patch.value as { priceCents?: number } | undefined)?.priceCents;
    if (e.priceCents !== undefined && cents !== e.priceCents)
      problems.push(`price ${cents}; expected ${e.priceCents}`);
    if (
      e.validUntil !== undefined &&
      p.patch.validity?.validUntil?.getTime() !== sgDayAfter(e.validUntil).getTime()
    )
      problems.push(`valid until the wrong day; expected ${e.validUntil}`);
  }
  if (e.kind === 'edit_hours' && p.kind === 'edit_hours') {
    const days = Object.keys(p.after).sort();
    if (days.join() !== [...e.days].sort().join())
      problems.push(`changed ${days.join(', ')}; expected ${[...e.days].sort().join(', ')}`);
    if (e.hours !== undefined)
      for (const [day, v] of Object.entries(p.after))
        if (rangeOf(v) !== e.hours) problems.push(`${day} ${rangeOf(v)}; expected ${e.hours}`);
  }
  return problems;
}
