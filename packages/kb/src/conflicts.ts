import { createHash } from 'node:crypto';
import type { schema } from '@kaki/db';
import type { FactInput, GstTreatment } from './types.js';

/**
 * Conflicts (KB-06; FEAT-014 §5.1, §5.2): which facts are about the same entity, whether
 * two of them agree, and what a source's promote does with its findings. Pure: the
 * stores call it with the rows they have locked.
 */

type FactStatus = (typeof schema.FACT_STATUSES)[number];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The entity a fact is about: type plus normalised name and unit, question or title.
 * Staging's `dedupe_key` (FEAT-012) and detection share it.
 */
export function entityKey(input: FactInput): string {
  switch (input.type) {
    case 'product':
      return `product:${norm(input.value.name)}|${norm(input.value.unit ?? '')}`;
    case 'faq':
      return `faq:${norm(input.value.question)}`;
    case 'policy':
    case 'promotion':
      return `${input.type}:${norm(input.value.title)}`;
  }
}

/** A conflict's ID: stable while its facts share the key (D1). */
export const conflictId = (key: string) =>
  createHash('sha256').update(key).digest('hex').slice(0, 16);

/** `unknown` agrees with either treatment; inclusive and exclusive disagree (D2). */
const gstAgrees = (a: GstTreatment | null, b: GstTreatment | null) =>
  a === b || a === 'unknown' || b === 'unknown';

const time = (d: Date | null | undefined) => d?.getTime() ?? null;

/**
 * Whether two facts about one entity tell a visitor the same thing (D2): prices, GST
 * basis and promotion dates exactly; policy and FAQ texts up to case and whitespace.
 */
export function sameValue(a: FactInput, b: FactInput): boolean {
  if (a.type !== b.type || entityKey(a) !== entityKey(b)) return false;
  switch (a.type) {
    case 'product': {
      const o = b as typeof a;
      return a.value.priceCents === o.value.priceCents && gstAgrees(a.gstTreatment, o.gstTreatment);
    }
    case 'promotion': {
      const o = b as typeof a;
      return (
        a.value.priceCents === o.value.priceCents &&
        gstAgrees(a.gstTreatment, o.gstTreatment) &&
        time(a.validity.validFrom) === time(o.validity.validFrom) &&
        time(a.validity.validUntil) === time(o.validity.validUntil) &&
        norm(a.value.details) === norm(o.value.details)
      );
    }
    case 'policy': {
      const o = b as typeof a;
      return a.value.kind === o.value.kind && norm(a.value.details) === norm(o.value.details);
    }
    case 'faq': {
      const o = b as typeof a;
      return norm(a.value.answer) === norm(o.value.answer);
    }
  }
}

/** The statuses that take part in a conflict; rejected and disabled facts never do (D3). */
export const LIVE_STATUSES: readonly FactStatus[] = ['approved', 'needs_review', 'conflicted'];

export interface ExistingFact {
  id: string;
  status: FactStatus;
  version: number;
  input: FactInput;
}

export interface PromotionPlan<C> {
  /** The candidates to write, in their given order, with the status to write them in. */
  insert: { candidate: C; status: 'needs_review' | 'conflicted' }[];
  /** Live facts not yet conflicted that a new finding disagrees with. */
  flag: ExistingFact[];
}

/** Whether every pair of facts agrees. */
export const allAgree = (inputs: FactInput[]) =>
  inputs.every((a, i) => inputs.slice(i + 1).every((b) => sameValue(a, b)));

/**
 * What a promote writes (FEAT-014 §5.2). `candidates` come in confidence order, then crawl
 * order; `existing` are the tenant's facts with their keys, any status.
 * 1. Within the run, a candidate agreeing with one kept before it is dropped.
 * 2. A candidate agreeing with an existing fact of any status is a duplicate (D3).
 * 3. Per key: if the kept candidates and the live facts don't all agree, the candidates
 *    are written `conflicted` and the live facts flagged; otherwise `needs_review`.
 */
export function planPromotion<C extends { input: FactInput }>(
  candidates: readonly C[],
  existing: readonly ExistingFact[],
): PromotionPlan<C> {
  const byKey = new Map<string, ExistingFact[]>();
  for (const e of existing) {
    const k = entityKey(e.input);
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const kept = new Map<string, C[]>();
  const order: C[] = [];
  for (const c of candidates) {
    const k = entityKey(c.input);
    const run = kept.get(k) ?? [];
    if (run.some((r) => sameValue(r.input, c.input))) continue;
    if ((byKey.get(k) ?? []).some((e) => sameValue(e.input, c.input))) continue;
    kept.set(k, [...run, c]);
    order.push(c);
  }
  const conflicted = new Set<string>();
  const flag: ExistingFact[] = [];
  for (const [k, run] of kept) {
    const live = (byKey.get(k) ?? []).filter((e) => LIVE_STATUSES.includes(e.status));
    if (allAgree([...run.map((r) => r.input), ...live.map((e) => e.input)])) continue;
    conflicted.add(k);
    flag.push(...live.filter((e) => e.status !== 'conflicted'));
  }
  return {
    insert: order.map((candidate) => ({
      candidate,
      status: conflicted.has(entityKey(candidate.input)) ? 'conflicted' : 'needs_review',
    })),
    flag,
  };
}

/** A stored row's content as a `FactInput`, for the comparisons above. */
export function inputOf(row: {
  type: FactInput['type'];
  value: unknown;
  gstTreatment: GstTreatment | null;
  validFrom: Date | null;
  validUntil: Date | null;
}): FactInput {
  return {
    type: row.type,
    value: row.value,
    gstTreatment: row.gstTreatment,
    validity: { validFrom: row.validFrom, validUntil: row.validUntil },
  } as FactInput;
}
