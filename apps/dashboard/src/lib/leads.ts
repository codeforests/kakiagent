import type { LeadFieldKey, LeadFieldMode, LeadSettings, LeadSettingsBody } from '@kaki/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.ts';
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
  /** FEAT-050: carried through until the Qualification card edits it (T8). */
  qualification: LeadSettings['qualification'];
}

export type LeadErrors = Partial<Record<'email' | 'marketingEn', string>>;

/** The form's starting values; an empty opt-in wording starts on the default. */
export function leadDraftOf(s: LeadSettings, business: string): LeadDraft {
  return {
    fields: s.fields.map((f) => ({ ...f })),
    marketing: {
      enabled: s.marketing.enabled,
      en: s.marketing.text.en || MARKETING_DEFAULT(business),
      zh: s.marketing.text.zh ?? '',
    },
    qualification: { ...s.qualification, keywords: [...s.qualification.keywords] },
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
    qualification: d.qualification,
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
  return lines;
}

/** "Version 3 · saved 18 Nov 2026" for the saved opt-in wording, else null. */
export const wordingCaption = (w: LeadSettings['marketing']['wording']) =>
  w ? formatSaved(w) : null;
