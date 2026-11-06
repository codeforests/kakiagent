/**
 * Approvals (SCR-APP-017, SCR-APP-018; FEAT-055 ui-design): pure helpers for the queue and
 * the decision page (SLA chips, decided lines, the draft editor's validation) and the hooks
 * that read the list and the detail. Totals come from the Zod-free `@kaki/contracts/quote`,
 * the same arithmetic the server uses (D2).
 */
import {
  APPROVAL_LIMITS,
  type ApprovalDetail,
  type ApprovalKind,
  type ApprovalLine,
  type ApprovalStatus,
  type ApprovalSummary,
  type ApprovalTerms,
} from '@kaki/contracts';
import { totalsOf, type GstNote, type QuoteTotals } from '@kaki/contracts/quote';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api.ts';

export { formatSgd, totalsOf } from '@kaki/contracts/quote';

export type ApprovalView = 'pending' | 'decided';
export const approvalsKey = (view: ApprovalView) => ['approvals', view] as const;
export const approvalKey = (id: string) => ['approval', id] as const;
/** The nav badge's count: the first page of the pending list carries `pendingCount`. */
export const APPROVAL_COUNT_KEY = ['approvals', 'count'] as const;

export const KIND_LABEL: Record<ApprovalKind, string> = {
  quote: 'Quote',
  discount: 'Discount',
  commitment: 'Promise',
};

export const STATUS_LABEL: Record<ApprovalStatus, { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'pending' },
  approved: { label: 'Approved', tone: 'success' },
  edited_approved: { label: 'Approved with edits', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  undeliverable: { label: 'Not delivered', tone: 'danger' },
};

const TZ = 'Asia/Singapore';
const clock = new Intl.DateTimeFormat('en-SG', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: TZ,
});
const weekday = new Intl.DateTimeFormat('en-SG', { weekday: 'short', timeZone: TZ });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const longDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: TZ,
});

/** "2:30 pm" (SGT). */
export const timeOf = (iso: string) => clock.format(new Date(iso));
/** "25 Nov 2026" (SGT). */
export const dateOf = (iso: string) => longDate.format(new Date(iso));

/** "25 min", "1 h 20 min", "3 h". */
export function durationText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export interface Chip {
  text: string;
  tone: 'pending' | 'warning' | 'danger';
}

/**
 * The SLA chip on a pending approval (ui-design SCR-APP-017): "Due in 1 h 20 min" (pending),
 * under 30 minutes "Due in 25 min" (warning, urgent), past due "Overdue by 10 min" (danger,
 * "· escalated" once the server escalated it). After hours, on another day: "Due Mon 10:00 am".
 */
export function slaChip(
  a: Pick<ApprovalSummary, 'slaDueAt' | 'breached' | 'afterHours'>,
  now = new Date(),
): Chip {
  const due = new Date(a.slaDueAt);
  const left = Math.ceil((due.getTime() - now.getTime()) / 60_000);
  if (left <= 0 || a.breached) {
    const over = Math.max(0, -left);
    return {
      text: `Overdue by ${durationText(over)}${a.breached ? ' · escalated' : ''}`,
      tone: 'danger',
    };
  }
  if (a.afterHours && dayKey.format(due) !== dayKey.format(now))
    return { text: `Due ${weekday.format(due)} ${clock.format(due)}`, tone: 'pending' };
  return { text: `Due in ${durationText(left)}`, tone: left < 30 ? 'warning' : 'pending' };
}

const VERB: Partial<Record<ApprovalStatus, string>> = {
  approved: 'approved',
  edited_approved: 'approved with edits',
  undeliverable: 'approved',
  rejected: 'rejected',
};

/** A decided row's meta (SCR-APP-017): "by Mei Ling · 2:31 pm". */
export function decidedMeta(d: Pick<ApprovalDetail, 'decision'>): string | null {
  if (!d.decision) return null;
  return `by ${d.decision.by?.name || 'a team member'} · ${timeOf(d.decision.at)}`;
}

/**
 * The decided-state line on SCR-APP-018: someone else (409 or live) "Already approved by Mei
 * Ling at 2:02 pm"; mine "You approved this at 2:02 pm"; expired and not-delivered texts.
 */
export function decisionText(
  d: Pick<ApprovalDetail, 'status' | 'decision' | 'expiresAt'>,
  meId: string | null,
): string | null {
  if (d.status === 'pending') return null;
  if (d.status === 'expired')
    return `This request expired on ${dateOf(d.decision?.at ?? d.expiresAt)}. The visitor was told your team will contact them.`;
  if (d.status === 'undeliverable')
    return "Approved, but we couldn't reach the visitor: their chat has ended and they left no email or phone.";
  const verb = VERB[d.status] ?? 'decided';
  const at = d.decision ? ` at ${timeOf(d.decision.at)}` : '';
  if (d.decision?.by && d.decision.by.userId === meId)
    return d.status === 'edited_approved'
      ? `You approved this with edits${at}.`
      : `You ${verb} this${at}.`;
  return `Already ${verb} by ${d.decision?.by?.name || 'a team member'}${at}.`;
}

export const headingOf = (d: Pick<ApprovalSummary, 'kind' | 'contactName'>) =>
  `${d.kind === 'quote' ? 'Quote' : d.kind === 'discount' ? 'Discount' : 'Promise'} for ${
    d.contactName || 'Website visitor'
  }`;

// ---- Draft editor ------------------------------------------------------------------------

/** One editable line: the inputs as typed, plus what the fact snapshot carried. */
export interface EditLine {
  key: string;
  factId: string | null;
  factVersion: number | null;
  unit: string | null;
  label: string;
  quantity: string;
  price: string;
}

export interface EditDraft {
  lines: EditLine[];
  discount: string;
  note: string;
}

let lineSeq = 0;
export const newLineKey = () => `l${++lineSeq}`;

const centsText = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

export function editDraftOf(t: ApprovalTerms): EditDraft {
  return {
    lines: t.lines.map((l) => ({
      key: newLineKey(),
      factId: l.factId,
      factVersion: l.factVersion,
      unit: l.unit,
      label: l.label,
      quantity: String(l.quantity),
      price: centsText(l.unitPriceCents),
    })),
    discount: String(t.discountPct),
    note: t.note,
  };
}

const INT = /^\d+$/;
const PRICE = /^\d+(\.\d{1,2})?$/;

function centsOf(price: string): number | null {
  const s = price.trim().replace(/^S\$/i, '').replace(/,/g, '');
  if (!PRICE.test(s)) return null;
  const [d, c = ''] = s.split('.');
  const cents = Number(d) * 100 + Number(c.padEnd(2, '0'));
  return cents <= 100_000_000 ? cents : null;
}

export type TermsErrors = Record<string, string>;

/**
 * The edit form's validation (ui-design SCR-APP-018) and the terms it sends. Error keys are
 * `label-<key>`, `quantity-<key>`, `price-<key>`, `discount`, `note` and `form` (nothing to send).
 */
export function termsError(
  d: EditDraft,
): { ok: true; terms: ApprovalTerms } | { ok: false; errors: TermsErrors } {
  const errors: TermsErrors = {};
  const lines: ApprovalLine[] = [];
  for (const l of d.lines) {
    const label = l.label.trim();
    if (!label || label.length > 120)
      errors[`label-${l.key}`] = 'Enter what this line is, up to 120 characters';
    const q = l.quantity.trim();
    const quantity = INT.test(q) ? Number(q) : NaN;
    if (!(quantity >= 1 && quantity <= 100_000))
      errors[`quantity-${l.key}`] = 'Enter a quantity from 1 to 100,000';
    const cents = centsOf(l.price);
    if (cents === null) errors[`price-${l.key}`] = 'Enter a price like 3.50';
    if (cents !== null && quantity >= 1 && label)
      lines.push({
        factId: l.factId,
        factVersion: l.factVersion,
        label,
        unit: l.unit,
        quantity,
        unitPriceCents: cents,
      });
  }
  const disc = d.discount.trim();
  const discountPct = disc === '' ? 0 : INT.test(disc) ? Number(disc) : NaN;
  if (!(discountPct >= 0 && discountPct <= 100))
    errors.discount = 'Enter a whole number from 0 to 100';
  if (d.note.length > APPROVAL_LIMITS.note)
    errors.note = `Keep the note to ${APPROVAL_LIMITS.note} characters`;
  if (d.lines.length === 0 && !d.note.trim()) errors.form = 'Add a line or a note before sending';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, terms: { lines, discountPct, note: d.note.trim() } };
}

/** Live totals while editing: lines that don't parse yet count as zero. */
export function liveTotals(d: EditDraft, gst: GstNote): QuoteTotals {
  const lines = d.lines.map((l) => ({
    quantity: INT.test(l.quantity.trim()) ? Number(l.quantity.trim()) : 0,
    unitPriceCents: centsOf(l.price) ?? 0,
  }));
  const pct = Number(d.discount.trim());
  return totalsOf({ lines, discountPct: INT.test(d.discount.trim()) && pct <= 100 ? pct : 0 }, gst);
}

export const GST_TEXT: Record<GstNote, string | null> = {
  inclusive: 'Prices include GST',
  exclusive: 'Prices before GST',
  none: null,
};

/** The toast after my decision. */
export const decidedToast = (action: 'approve' | 'edit_approve' | 'reject') =>
  action === 'reject' ? 'Request rejected. The visitor was told.' : 'Quote sent to the visitor';

// ---- Hooks ---------------------------------------------------------------------------------

export function useApprovals(view: ApprovalView) {
  return useInfiniteQuery({
    queryKey: approvalsKey(view),
    queryFn: ({ pageParam }) => api.approvals({ view, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** The nav and tab badge: pending count from a one-row read of the pending list. */
export function usePendingApprovals(enabled = true) {
  return useQuery({
    queryKey: APPROVAL_COUNT_KEY,
    queryFn: () => api.approvals({ view: 'pending' }),
    select: (l) => l.pendingCount,
    enabled,
  });
}

export function useApproval(id: string) {
  return useQuery({ queryKey: approvalKey(id), queryFn: () => api.approval(id) });
}

/** Re-renders every 30 s so SLA chips count down without a refetch. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
