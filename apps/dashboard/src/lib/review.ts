import type { Fact, FactType, ReviewFact, ReviewScopeQuery, SkipReason } from '@kaki/contracts';
import { factValue, GST_LABEL, sgd } from './facts.ts';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { POLL_MS, useVisible } from './sources.ts';

/** Review display rules shared by SCR-APP-019, SCR-APP-008 and the shell (FEAT-013 ui-design). */

/** KB-16 order: prices, policies and promotions first. */
export const GROUPS: { type: FactType; label: string; one: string }[] = [
  { type: 'product', label: 'Prices', one: 'Price' },
  { type: 'policy', label: 'Policies', one: 'Policy' },
  { type: 'promotion', label: 'Promotions', one: 'Promotion' },
  { type: 'faq', label: 'FAQs', one: 'FAQ' },
];
export const GROUP = Object.fromEntries(GROUPS.map((g) => [g.type, g])) as Record<
  FactType,
  (typeof GROUPS)[number]
>;

/** The value line (title-sm, prices tabular): "S$55.00 · GST incl." (ui-design cross-screen). */
export function valueLine(f: Fact): string | null {
  switch (f.type) {
    case 'product':
      return f.gstTreatment === 'unknown'
        ? sgd(f.value.price)
        : `${sgd(f.value.price)} · ${GST_LABEL[f.gstTreatment]}`;
    case 'promotion':
      return factValue(f) || null;
    case 'faq':
      return f.value.answer;
    case 'policy':
      return f.value.details;
  }
}

/** A price the owner must give a GST treatment before approving it (KB-15). */
export const gstUnknown = (f: ReviewFact) => f.gstTreatment === 'unknown';

const DAY = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Singapore',
});
/** "21 Oct 2026" (NFR-10). */
export const dayOf = (iso: string) => DAY.format(new Date(iso));

/** "kakibakery.sg/cakes" for a page URL. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

/** The page-head button: "Approve all…", scoped to the filters (KB-16 by source or type). */
export function approveAllLabel(scope: ReviewScopeQuery, sourceName: string | null): string {
  const what = scope.type ? `Approve all ${GROUP[scope.type].label.toLowerCase()}` : 'Approve all';
  return scope.sourceId && sourceName ? `${what} from ${sourceName}…` : `${what}…`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The toast line for a selection's skipped facts (ui-design cross-screen copy). */
export function skipMessage(skipped: { reason: SkipReason }[]): string {
  const choose = skipped.filter((s) => s.reason === 'gst_unknown' || s.reason === 'conflicted');
  const changed = skipped.length - choose.length;
  const parts: string[] = [];
  if (choose.length)
    parts.push(
      `${choose.length} need${choose.length === 1 ? 's' : ''} your choice first: set the GST treatment or resolve the conflict.`,
    );
  if (changed === 1) parts.push('1 changed since you loaded it and was skipped.');
  if (changed > 1) parts.push(`${changed} changed since you loaded them and were skipped.`);
  return parts.join(' ');
}

/**
 * The review counts (tab, nav badge, empty state, the setup's "still extracting"),
 * refetched every 2 s while a source is still being read and the tab is visible.
 */
export function useReviewSummary(enabled = true) {
  const visible = useVisible();
  return useQuery({
    queryKey: ['review-summary'],
    queryFn: api.reviewSummary,
    enabled,
    refetchInterval: (q) => (visible && (q.state.data?.sourcesBusy ?? 0) > 0 ? POLL_MS : false),
  });
}
