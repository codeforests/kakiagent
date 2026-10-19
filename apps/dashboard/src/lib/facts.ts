import type { Fact, FactStatus } from '@kaki/contracts';

/** Fact display rules shared by SCR-APP-027 and SCR-APP-028 (FEAT-022 ui-design). */

export const STATUS_LABEL: Record<FactStatus, string> = {
  approved: 'Approved',
  needs_review: 'Needs review',
  disabled: 'Disabled',
  rejected: 'Rejected',
  conflicted: 'Conflicted',
};

/** Disabled reuses the rejected colours: both mean "not used in answers" (ui-design decision). */
export const STATUS_TONE: Record<FactStatus, 'approved' | 'review' | 'rejected' | 'conflict'> = {
  approved: 'approved',
  needs_review: 'review',
  disabled: 'rejected',
  rejected: 'rejected',
  conflicted: 'conflict',
};

export const GST_LABEL = { inclusive: 'GST incl.', exclusive: 'GST excl.', unknown: 'GST unknown' };

/** `S$55.00`, as typed and stored (design.md §6, NFR-10). */
export const sgd = (price: string) => `S$${price}`;

export function factTitle(f: Fact): string {
  if (f.type === 'faq') return f.value.question;
  return f.value.unit ? `${f.value.name}, ${f.value.unit}` : f.value.name;
}

export function factValue(f: Fact): string {
  if (f.type === 'product') return `${sgd(f.value.price)} · ${GST_LABEL[f.gstTreatment]}`;
  return f.value.answer.split('\n')[0]!;
}

const UPDATED = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
});

/** "19 Oct 2026, 2:30 pm". */
export const updatedLabel = (iso: string) => UPDATED.format(new Date(iso));
