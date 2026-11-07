import {
  LeadScore,
  LeadStatusFilter,
  type LeadFieldKey,
  type LeadFieldMode,
  type LeadConsentRecord,
  type LeadDetail,
  type LeadList,
  type LeadMarketing,
  type LeadScoring,
  type LeadSettings,
  type LeadSettingsBody,
  type LeadSource,
  type LeadStatus,
  type ScoreReason,
  type ScoreReasonCode,
} from '@kaki/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
import { dateTime } from './inbox.ts';
import { formatSaved } from './privacy.ts';

/** Helpers for SCR-APP-043 Leads and consent (FEAT-049 technical-design §5.7, ui-design). */

export const LEADS_KEY = ['lead-settings'];

export function useLeadSettings() {
  return useQuery({
    queryKey: LEADS_KEY,
    queryFn: () => api.leadSettings(),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
  });
}

/** Not a sensitive action (AUTH-03 list): no re-auth; the response becomes the new base. */
export function useSaveLeadSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LeadSettingsBody) => api.saveLeadSettings(body),
    onSuccess: (res) => queryClient.setQueryData(LEADS_KEY, res),
  });
}

export const FIELD_LABELS: Record<LeadFieldKey, string> = {
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  need: 'What they need',
  budget: 'Budget',
  preferredTime: 'Preferred date or time',
};

export const MODE_LABELS: Record<LeadFieldMode, string> = {
  off: 'Off',
  optional: 'Optional',
  required: 'Required',
};

export const MARKETING_DEFAULT = (business: string) =>
  `Also send me offers and news from ${business}. I can unsubscribe at any time.`;

export interface LeadDraft {
  fields: LeadSettings['fields'];
  marketing: { enabled: boolean; en: string; zh: string };
  /** FEAT-050 Qualification card: the budget as typed (whole S$, empty = no criterion). */
  qualification: { keywords: string[]; minBudget: string };
}

export type LeadErrors = Partial<Record<'email' | 'marketingEn' | 'minBudget', string>>;

export const KEYWORD_MAX = 20;
const keywordKey = (k: string) => k.normalize('NFKC').toLowerCase();

/** The Add keyword checks (ui-design SCR-APP-043), else undefined. */
export function keywordError(list: string[], value: string): string | undefined {
  const v = value.trim().replace(/\s+/g, ' ');
  if (!v) return 'Enter a keyword';
  if (v.length > 40) return 'Keep keywords to 40 characters';
  const dup = list.find((k) => keywordKey(k) === keywordKey(v));
  if (dup) return `You already added ${dup}`;
  if (list.length >= KEYWORD_MAX) return 'You can add up to 20 keywords';
  return undefined;
}

/** The minimum budget in whole S$ ("1,000" allowed): null when empty, NaN when not a number. */
export function budgetOf(value: string): number | null {
  const v = value.trim().replace(/^S\$/i, '').replace(/[,\s]/g, '');
  if (!v) return null;
  return /^\d+$/.test(v) ? Number(v) : Number.NaN;
}

export function budgetError(value: string): string | undefined {
  const n = budgetOf(value);
  if (n === null) return undefined;
  if (Number.isNaN(n)) return 'Enter a whole number of dollars';
  if (n < 1 || n > 10_000_000) return 'Enter an amount from S$1 to S$10,000,000';
  return undefined;
}

/** The form's starting values; an empty opt-in wording starts on the default. */
export function leadDraftOf(s: LeadSettings, business: string): LeadDraft {
  return {
    fields: s.fields.map((f) => ({ ...f })),
    marketing: {
      enabled: s.marketing.enabled,
      en: s.marketing.text.en || MARKETING_DEFAULT(business),
      zh: s.marketing.text.zh ?? '',
    },
    qualification: {
      keywords: [...s.qualification.keywords],
      minBudget: s.qualification.minBudget === null ? '' : String(s.qualification.minBudget),
    },
  };
}

export function leadBodyOf(d: LeadDraft, version: number): LeadSettingsBody {
  return {
    version,
    fields: d.fields,
    marketing: {
      enabled: d.marketing.enabled,
      text: { en: d.marketing.en.trim(), zh: d.marketing.zh.trim() || null },
    },
    qualification: {
      keywords: d.qualification.keywords,
      minBudget: budgetOf(d.qualification.minBudget),
    },
  };
}

/** "Keep phone or email on…" when both are off (D6), shown on the Email row. */
export function fieldsError(fields: LeadSettings['fields']): string | undefined {
  const off = (k: LeadFieldKey) => fields.find((f) => f.key === k)?.mode === 'off';
  return off('phone') && off('email')
    ? 'Keep phone or email on, so the team can reply.'
    : undefined;
}

/** The client checks, mirroring the server's 400 codes. */
export function validateLeadDraft(d: LeadDraft): LeadErrors {
  const errors: LeadErrors = {};
  const fields = fieldsError(d.fields);
  if (fields) errors.email = fields;
  if (d.marketing.enabled && !d.marketing.en.trim())
    errors.marketingEn = 'Enter the opt-in wording';
  const budget = budgetError(d.qualification.minBudget);
  if (budget) errors.minBudget = budget;
  return errors;
}

/** The 400 `invalid_lead_settings` code as the field error it belongs to. */
export function leadServerErrors(code: string): LeadErrors {
  if (code === 'phone_or_email') return { email: 'Keep phone or email on, so the team can reply.' };
  if (code === 'marketing_text') return { marketingEn: 'Enter the opt-in wording' };
  return {};
}

/** What changed between the saved settings and the draft; empty when nothing did. */
export function diffLeadSettings(before: LeadDraft, after: LeadDraft): string[] {
  const lines: string[] = [];
  for (const f of after.fields) {
    const was = before.fields.find((b) => b.key === f.key)?.mode;
    if (was !== f.mode)
      lines.push(`${FIELD_LABELS[f.key]}: ${MODE_LABELS[was ?? 'off']} → ${MODE_LABELS[f.mode]}`);
  }
  const m0 = before.marketing;
  const m1 = after.marketing;
  if (m0.enabled !== m1.enabled) lines.push(`Marketing opt-in: ${m1.enabled ? 'on' : 'off'}`);
  if (m1.enabled && (m0.en.trim() !== m1.en.trim() || m0.zh.trim() !== m1.zh.trim()))
    lines.push('Opt-in wording changed');
  const q0 = before.qualification;
  const q1 = after.qualification;
  const added = q1.keywords.filter((k) => !q0.keywords.includes(k));
  const removed = q0.keywords.filter((k) => !q1.keywords.includes(k));
  if (added.length) lines.push(`Keywords added: ${added.join(', ')}`);
  if (removed.length) lines.push(`Keywords removed: ${removed.join(', ')}`);
  if (q0.minBudget.trim() !== q1.minBudget.trim()) {
    const n = budgetOf(q1.minBudget);
    lines.push(
      n === null
        ? 'Minimum budget removed'
        : Number.isNaN(n)
          ? 'Minimum budget changed'
          : `Minimum budget: S$${n}`,
    );
  }
  return lines;
}

/** "Version 3 · saved 18 Nov 2026" for the saved opt-in wording, else null. */
export const wordingCaption = (w: LeadSettings['marketing']['wording']) =>
  w ? formatSaved(w) : null;

// ---- Leads list and lead page (SCR-APP-032, SCR-APP-033; FEAT-050 ui-design) --------------

export const leadsKey = (status: LeadStatusFilter, score: LeadScore | undefined) =>
  ['leads', status, score ?? 'any'] as const;
export const leadKey = (id: string) => ['lead', id] as const;

export interface LeadsFilter {
  status: LeadStatusFilter;
  score: LeadScore | undefined;
}

/** The list's filters from the URL (`?status=&score=`); anything unknown falls back. */
export function leadsQueryOf(search: URLSearchParams): LeadsFilter {
  const status = LeadStatusFilter.safeParse(search.get('status'));
  const score = LeadScore.safeParse(search.get('score'));
  return {
    status: status.success ? status.data : 'open',
    score: score.success ? score.data : undefined,
  };
}

/** The URL search for a filter, defaults left out. */
export function leadsSearchOf(f: LeadsFilter): string {
  const q = new URLSearchParams();
  if (f.status !== 'open') q.set('status', f.status);
  if (f.score) q.set('score', f.score);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const STATUS_TABS: { value: LeadStatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'all', label: 'All' },
];
const STATUS_FILTER_LABEL = Object.fromEntries(
  STATUS_TABS.map((t) => [t.value, t.label]),
) as Record<LeadStatusFilter, string>;

/** A tab's count from the list's per-status counts (they ignore the score filter). */
export function tabCount(counts: LeadList['counts'], tab: LeadStatusFilter): number {
  const c = (s: LeadStatus) => counts[s] ?? 0;
  if (tab === 'open') return c('new') + c('contacted');
  if (tab === 'all') return c('new') + c('contacted') + c('won') + c('lost');
  return c(tab);
}

export const SCORE_LABEL: Record<LeadScore, string> = { hot: 'Hot', warm: 'Warm', cold: 'Cold' };
/** "Hot", or "Not scored" for a lead captured before scoring. */
export const scoreLabel = (s: LeadScoring) => (s ? SCORE_LABEL[s.score] : 'Not scored');

const REASON_TEXT: Record<ScoreReasonCode, (detail: string | null) => string> = {
  keyword: (d) => `Mentions "${d ?? ''}"`,
  budget_met: (d) => `Budget meets your S$${d ?? ''} minimum`,
  budget_below: (d) => `Budget below your S$${d ?? ''} minimum`,
  wants_to_order: () => 'Asked for a quote or to order',
  both_contacts: () => 'Left phone and email',
  need_given: () => 'Said what they need',
  timing_given: () => 'Said when they need it',
  returning: () => 'Came back',
};
/** A reason in words: the same words as the CSV (leads `REASON_TEXT`). */
export const reasonText = (r: ScoreReason) => REASON_TEXT[r.code](r.detail);
/** "+2", or "−1" for a deduction. */
export const pointsText = (n: number) => (n < 0 ? `−${-n}` : `+${n}`);

/**
 * "Offers: Yes · 18 Nov 2026, 2:30 pm" / "Offers: No" / "Offers: Not asked"; FEAT-051:
 * "Offers: stopped 18 Nov 2026" after a withdrawal.
 */
export function marketingText(m: LeadMarketing): string {
  if (!m) return 'Offers: Not asked';
  if (m.withdrawn) return `Offers: stopped ${dateTime(m.at).split(',')[0]}`;
  return m.agreed ? `Offers: Yes · ${dateTime(m.at)}` : 'Offers: No';
}

// ---- Consent withdrawal (SCR-APP-033, -032; FEAT-051 ui-design) ---------------------------

/** The lead page's danger alert text once consent is withdrawn (LED-05, LED-07). */
export const withdrawnAlertText = (at: string) =>
  `On ${dateTime(at)} this person withdrew consent. Don't contact them or use their details. They're left out of exports.`;

/**
 * Where a consent entry came from: a withdrawal names its channel ("Website chat" with the
 * conversation, or "Recorded by {name}"); other entries keep FEAT-050's chat or form.
 */
export function consentWhere(c: LeadConsentRecord): {
  text: string;
  conversationId: string | null;
} {
  if (c.channel === 'dashboard')
    return { text: `Recorded by ${c.recordedBy ?? 'a team member'}`, conversationId: null };
  if (!c.conversationId) return { text: 'Contact form', conversationId: null };
  return {
    text: 'Website chat',
    conversationId: c.decision === 'withdrawn' ? c.conversationId : null,
  };
}

/** Owner and Admin record a withdrawal until consent is fully withdrawn. */
export const canRecordWithdrawal = (lead: Pick<LeadDetail, 'canManage' | 'consentWithdrawnAt'>) =>
  lead.canManage && !lead.consentWithdrawnAt;

/** "Only stop offers" is offered only when the latest marketing answer is agreed. */
export const offersWithdrawable = (lead: Pick<LeadDetail, 'marketing'>) =>
  lead.marketing?.agreed === true;

export const SOURCE_LABEL: Record<LeadSource, string> = {
  chat: 'Chat',
  contact_form: 'Contact form',
};

/** `leads-YYYY-MM-DD.csv`, the date in Singapore (the server's own name wins when sent). */
export function exportFileName(now: Date): string {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(now);
  return `leads-${d}.csv`;
}

/**
 * How many leads a leads CSV holds: its records (line breaks outside quotes; a quoted
 * "What they need" may hold its own), less the reminder line and the header.
 */
export function csvLeadCount(csv: string): number {
  let records = 0;
  let quoted = false;
  let started = false;
  for (const ch of csv) {
    if (ch === '"') quoted = !quoted;
    if (ch === '\n' && !quoted) {
      records++;
      started = false;
    } else if (ch !== '\r' && ch !== '﻿') started = true;
  }
  if (started) records++;
  return Math.max(0, records - 2);
}

/**
 * The export dialog's title. Without a score filter n is the tab's count; with one, the
 * counts don't apply, so n is the loaded rows once the list is complete, else unknown.
 */
export function exportTitle(
  f: LeadsFilter,
  counts: LeadList['counts'] | undefined,
  loaded: number,
  complete: boolean,
): string {
  const n = !f.score ? (counts ? tabCount(counts, f.status) : null) : complete ? loaded : null;
  if (n === null) return 'Export these leads?';
  return `Export ${n} ${n === 1 ? 'lead' : 'leads'}?`;
}

/** "Filters: Open · Hot" when anything but the default is set, else null. */
export function filterNote(f: LeadsFilter): string | null {
  if (f.status === 'open' && !f.score) return null;
  const parts = [STATUS_FILTER_LABEL[f.status], ...(f.score ? [SCORE_LABEL[f.score]] : [])];
  return `Filters: ${parts.join(' · ')}`;
}

export function useLeads(f: LeadsFilter) {
  return useInfiniteQuery({
    queryKey: leadsKey(f.status, f.score),
    queryFn: ({ pageParam }) =>
      api.listLeads({ status: f.status, score: f.score, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchOnWindowFocus: true,
  });
}

export function useLead(id: string) {
  return useQuery({
    queryKey: leadKey(id),
    queryFn: () => api.lead(id),
    retry: (n, err) => !(err instanceof ApiError) && n < 1,
    refetchOnWindowFocus: true,
  });
}
