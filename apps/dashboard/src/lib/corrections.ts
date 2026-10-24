import {
  WEEKDAY_NAMES,
  WEEKDAYS,
  type CorrectionEdit,
  type CorrectionItem,
  type CorrectionReplay,
  type CorrectionReplayTurn,
  type CorrectionSource,
  type Fact,
  type FactType,
  type FactValueView,
  type ProposedChange,
  type ReviewIntervals,
} from '@kaki/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { diffRows, type DiffRow } from './coach.ts';
import { timesLabel } from './coverage.ts';
import { fromFact, hasPrice, valueOf, type Draft } from './fact-draft.ts';
import { dateLabel } from './replay.ts';

/** Correction queue display rules for SCR-APP-021 and SCR-APP-022 (FEAT-018 ui-design). */

/** The origin chip's text. */
export const SOURCE_LABEL: Record<CorrectionSource, string> = {
  coaching: 'Coaching',
  stale: 'Overdue for review',
  thumbs_down: 'Visitor 👎',
  staff_reply: 'Staff reply',
  staff_edit: 'Staff edit',
  oversight: 'Oversight',
  coverage_gap: 'Coverage gap',
};

/** The chip's colour: overdue items are warning-soft, the rest neutral. */
export const sourceTone = (s: CorrectionSource) => (s === 'stale' ? 'warning' : 'neutral');

/** What an accepted item applied: the edited fix when there was one (D7). */
export const effectiveChange = (c: CorrectionItem): ProposedChange => c.acceptedChange ?? c.change;

/** Whole months from `iso` to `now`. */
export function monthsSince(iso: string, now = new Date()): number {
  const from = new Date(iso);
  let months =
    (now.getUTCFullYear() - from.getUTCFullYear()) * 12 + now.getUTCMonth() - from.getUTCMonth();
  if (now.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "7 months ago", or the days under a month. */
export function agoLabel(iso: string, now = new Date()): string {
  const months = monthsSince(iso, now);
  if (months > 0) return `${plural(months, 'month')} ago`;
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
  return days === 0 ? 'today' : `${plural(days, 'day')} ago`;
}

/** The proposal's diff rows (re-confirm items have none). */
export const correctionRows = (change: ProposedChange): DiffRow[] => diffRows(change);

/**
 * The one-line fix summary: "Price of Chocolate fudge 1 kg: S$52.00 → S$58.00", "New FAQ: …",
 * "Opening hours for Sat, Sun", "Re-confirm: …, last confirmed 7 months ago".
 */
export function fixSummary(change: ProposedChange, now = new Date()): string {
  switch (change.kind) {
    case 'edit_fact': {
      const rows = diffRows(change);
      const [row] = rows;
      if (rows.length === 1 && row)
        return row.was
          ? `${row.label} of ${change.label}: ${row.was} → ${row.now}`
          : `${row.label} of ${change.label}: ${row.now}`;
      return `Change ${change.label}`;
    }
    case 'add_faq':
      return `New FAQ: ${change.question}`;
    case 'edit_hours':
      return `Opening hours for ${WEEKDAYS.filter((d) => change.after[d] !== undefined)
        .map((d) => WEEKDAY_NAMES[d].slice(0, 3))
        .join(', ')}`;
    case 'reconfirm':
      return `Re-confirm: ${change.label}, last confirmed ${agoLabel(change.lastConfirmedAt, now)}`;
    case 'answer_gap':
      return 'Customers asked something your assistant couldn’t answer';
  }
}

/** A coverage gap item reads as the customers' question while it is open (FEAT-019). */
export const isGap = (c: CorrectionItem) => c.change.kind === 'answer_gap';

/** The item's one-line summary: "Customers asked: “…”" for an open gap, else the fix. */
export function itemSummary(c: CorrectionItem, now = new Date()): string {
  if (c.status === 'open' && isGap(c) && c.gap) return `Customers asked: “${c.gap.question}”`;
  return fixSummary(effectiveChange(c), now);
}

/** The gap row's meta: "5 times"; null for other items. */
export const gapMeta = (c: CorrectionItem): string | null =>
  isGap(c) && c.gap ? timesLabel(c.gap.asksTotal) : null;

/** The closed list's decision chip. */
export function decisionLabel(c: CorrectionItem): string {
  switch (c.status) {
    case 'accepted':
      return 'Accepted';
    case 'edited_and_accepted':
      return isGap(c) ? 'FAQ added' : 'Edited and accepted';
    case 'dismissed':
      return c.closedBySystem ? 'Closed automatically' : 'Closed';
    case 'open':
      return 'Open';
  }
}

/** The success banner after accepting; `original` is the item's proposal. */
export const acceptedLine = (change: ProposedChange, original: ProposedChange = change) =>
  original.kind === 'answer_gap'
    ? 'FAQ added. Your assistant now uses it.'
    : change.kind === 'reconfirm'
      ? 'Re-confirmed. The review clock restarts today.'
      : 'Fix accepted. Your assistant now uses it.';

/** The closed banner: why it closed, and that nothing changed. */
export function closedLine(c: CorrectionItem, decidedAgo: string | null): string {
  if (c.closedBySystem)
    return isGap(c)
      ? 'Closed automatically: the chats it came from were deleted.'
      : 'Closed automatically: the fact was confirmed or changed since.';
  return `Closed${decidedAgo ? ` ${decidedAgo}` : ''}. Nothing in your knowledge changed.`;
}

/** Why an accepted item has no comparison (D3); null when it should have one. */
export function noReplayCaption(change: ProposedChange): string | null {
  switch (change.kind) {
    case 'add_faq':
    case 'answer_gap':
      return "No past answers used this yet, so there's nothing to compare.";
    case 'edit_hours':
      return "Opening-hours answers aren't linked to past chats, so there's nothing to compare.";
    case 'edit_fact':
      return 'No customer has asked about this fact yet.';
    case 'reconfirm':
      return null;
  }
}

const INTERVAL_NOUN: Record<FactType, string> = {
  product: 'products',
  faq: 'FAQs',
  policy: 'policies',
  promotion: 'promotions',
};

/** "Last confirmed 21 Mar 2026, 7 months ago. Your interval for products is 6 months." */
export function staleLine(
  lastConfirmedAt: string,
  type: FactType,
  intervals: ReviewIntervals | undefined,
  now = new Date(),
): string {
  const head = `Last confirmed ${dateLabel(lastConfirmedAt)}, ${agoLabel(lastConfirmedAt, now)}.`;
  return intervals
    ? `${head} Your interval for ${INTERVAL_NOUN[type]} is ${plural(intervals[type], 'month')}.`
    : head;
}

/** "12 recent customer questions used this fact. Here's what they got and what your assistant says now." */
export const pastAnswersLede = (n: number) =>
  `${n} recent customer ${n === 1 ? 'question' : 'questions'} used this fact. Here's what they got and what your assistant says now.`;

/** "The 20 most recent of 34." when more matched than replay (D4). */
export const matchedCaption = (r: CorrectionReplay): string | null =>
  r.matched > r.turns.length ? `The ${r.turns.length} most recent of ${r.matched}.` : null;

/** "Replaying 3 of 12…" */
export function correctionProgress(turns: CorrectionReplayTurn[]): string {
  const done = turns.filter((t) => t.status === 'done').length;
  return `Replaying ${done} of ${turns.length}…`;
}

/** "Replay complete. 2 answers changed." */
export function correctionCompleteLine(turns: CorrectionReplayTurn[]): string {
  const k = turns.filter((t) => t.answerChanged === true).length;
  return `Replay complete. ${k} ${k === 1 ? 'answer' : 'answers'} changed.`;
}

export const correctionPending = (r: CorrectionReplay) =>
  r.turns.some((t) => t.status === 'pending');

/** The replay with one turn swapped for its answered version. */
export function withCorrectionTurn(
  r: CorrectionReplay,
  turn: CorrectionReplayTurn,
): CorrectionReplay {
  const turns = r.turns.map((t) => (t.messageId === turn.messageId ? turn : t));
  return {
    ...r,
    turns,
    status: turns.some((t) => t.status === 'pending') ? 'replaying' : 'complete',
  };
}

/** The edit dialog's draft from a fact value as a correction shows it. */
export function draftOf(type: FactType, v: FactValueView): Draft {
  return fromFact({
    type,
    value: v.value,
    status: 'approved',
    gstTreatment: v.gstTreatment ?? 'unknown',
    validFrom: v.validFrom,
    validUntil: v.validUntil,
  } as unknown as Fact);
}

/** The accept body's edit from the dialog's draft; `base` keeps what the form doesn't edit. */
export function factEdit(d: Draft, base: FactValueView): CorrectionEdit {
  const promotion = d.type === 'promotion';
  return {
    kind: 'edit_fact',
    after: {
      value: valueOf(d) as Record<string, unknown>,
      gstTreatment: hasPrice(d) ? d.gst || base.gstTreatment : base.gstTreatment,
      validFrom: promotion ? d.validFrom || null : base.validFrom,
      validUntil: promotion ? d.validUntil || null : base.validUntil,
    },
  };
}

/** The intervals dialog's fields, in KB-16 order. */
export const INTERVAL_FIELDS: { type: keyof ReviewIntervals; label: string }[] = [
  { type: 'product', label: 'Products' },
  { type: 'faq', label: 'FAQs' },
  { type: 'policy', label: 'Policies' },
  { type: 'promotion', label: 'Promotions' },
];

/** "Enter 1 to 24 months." unless the field is a whole number in range. */
export function intervalError(raw: string): string | undefined {
  return /^\d{1,2}$/.test(raw.trim()) && Number(raw) >= 1 && Number(raw) <= 24
    ? undefined
    : 'Enter 1 to 24 months.';
}

/** Invalidates what a decision on an item changes: the lists, the item, the counts, Coverage. */
export function useCorrectionsChanged() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['corrections'] });
    void queryClient.invalidateQueries({ queryKey: ['review-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['coverage'] });
  };
}
