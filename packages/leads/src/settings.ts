import type {
  LeadCaptureConfig,
  LeadFieldKey,
  LeadFieldMode,
  LeadSettings,
  LeadSettingsSaved,
  Qualification,
} from '@kaki/contracts';
import { LEAD_FIELD_KEYS } from '@kaki/contracts/lead-check';
import { and, eq, schema, sql, type Tx } from '@kaki/db';
import {
  audit,
  auditCode,
  auditId,
  getPrivacySettings,
  MarketingContent,
  saveMarketingWording,
  visitorPrivacy,
  wordingById,
} from '@kaki/governance';
import { coverageTemplate, INDUSTRY_TEMPLATES } from '@kaki/tenancy';
import { LeadSettingsInvalid, LeadSettingsStale } from './errors.js';
import { normaliseQualification, qualificationInForce, rescoreOpenLeads } from './rescore.js';

const { leadSettings } = schema;

export type FieldSetting = { key: LeadFieldKey; mode: LeadFieldMode };

/** Every industry without its own (FEAT-049 §5.1): name required, phone, email and need optional. */
export const DEFAULT_FIELDS: readonly FieldSetting[] = [
  { key: 'name', mode: 'required' },
  { key: 'phone', mode: 'optional' },
  { key: 'email', mode: 'optional' },
  { key: 'need', mode: 'optional' },
  { key: 'budget', mode: 'off' },
  { key: 'preferredTime', mode: 'off' },
];

const MODES = new Set<string>(['off', 'optional', 'required']);

/** Saved fields if they are well formed (every key once, in order), else null. */
function parseFields(raw: unknown): FieldSetting[] | null {
  if (!Array.isArray(raw) || raw.length !== LEAD_FIELD_KEYS.length) return null;
  const out: FieldSetting[] = [];
  for (const [i, f] of raw.entries()) {
    const v = f as { key?: unknown; mode?: unknown };
    if (v?.key !== LEAD_FIELD_KEYS[i] || typeof v.mode !== 'string' || !MODES.has(v.mode))
      return null;
    out.push({ key: v.key as LeadFieldKey, mode: v.mode as LeadFieldMode });
  }
  return out;
}

const industryFields = (industry: string | null | undefined): readonly FieldSetting[] => {
  const t = industry ? INDUSTRY_TEMPLATES[industry as keyof typeof INDUSTRY_TEMPLATES] : undefined;
  return t?.leadFields ?? DEFAULT_FIELDS;
};

const fieldCodes = (fields: readonly FieldSetting[]) =>
  fields.map((f) =>
    auditCode(`${f.key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}.${f.mode}`),
  );

/** The tenant's lead settings for SCR-APP-043 (dashboard zone): the row, or the defaults at version 0. */
export async function getLeadSettings(tx: Tx, tenantId: string): Promise<LeadSettings> {
  const [row] = await tx.select().from(leadSettings).where(eq(leadSettings.tenantId, tenantId));
  const industry = (await coverageTemplate(tx, tenantId))?.industry ?? null;
  const fields = parseFields(row?.fields) ?? industryFields(industry);
  const { qualification } = await qualificationInForce(tx, tenantId, industry);
  const wording = await wordingById(tx, tenantId, row?.marketingWordingId ?? null);
  const marketing = wording ? MarketingContent.parse(wording.content).text : null;
  const privacy = await getPrivacySettings(tx, tenantId);
  return {
    version: row?.version ?? 0,
    fields: [...fields],
    marketing: {
      enabled: row?.marketingEnabled ?? false,
      // Never saved: empty, so the dashboard prefills its default naming the business (ui-design
      // SCR-APP-043; D3). The Chinese wording is optional and has no default.
      text: marketing ?? { en: '', zh: null },
      wording: wording ? { seq: wording.seq, savedAt: wording.createdAt.toISOString() } : null,
    },
    purpose: { text: privacy.purpose.text, saved: privacy.purpose.wording !== null },
    qualification,
  };
}

/**
 * Saves fields and the marketing opt-in if `version` is still current (0 inserts the first
 * row). A non-empty opt-in text is kept as a `marketing_consent` wording (a new one only when
 * it changed), so every marketing consent names a saved wording (D3). Audited with codes.
 */
export async function saveLeadSettings(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    version: number;
    fields: readonly FieldSetting[];
    marketing: { enabled: boolean; text: { en: string; zh: string | null } };
    /** FEAT-050: scoring criteria (absent = keep); a change rescores the open leads (§5.2). */
    qualification?: Qualification;
  },
): Promise<LeadSettingsSaved> {
  const { tenantId, userId, version, marketing } = input;
  const before = (
    await qualificationInForce(
      tx,
      tenantId,
      (await coverageTemplate(tx, tenantId))?.industry ?? null,
    )
  ).qualification;
  const qualification = normaliseQualification(input.qualification ?? before);
  const en = marketing.text.en.trim();
  if (marketing.enabled && !en) throw new LeadSettingsInvalid('marketing_text');
  const [row] = await tx
    .select()
    .from(leadSettings)
    .where(eq(leadSettings.tenantId, tenantId))
    .for('update');
  if ((row?.version ?? 0) !== version) throw new LeadSettingsStale('lead settings changed');
  const wording = en
    ? await saveMarketingWording(tx, {
        tenantId,
        userId,
        text: { en, zh: marketing.text.zh?.trim() || null },
        currentId: row?.marketingWordingId ?? null,
      })
    : null;
  const values = {
    fields: input.fields.map((f) => ({ key: f.key, mode: f.mode })),
    marketingEnabled: marketing.enabled,
    marketingWordingId: wording?.id ?? row?.marketingWordingId ?? null,
    qualification,
  };
  const [saved] =
    version === 0
      ? await tx
          .insert(leadSettings)
          .values({ tenantId, ...values })
          .onConflictDoNothing()
          .returning()
      : await tx
          .update(leadSettings)
          .set({ ...values, version: sql`${leadSettings.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(leadSettings.tenantId, tenantId), eq(leadSettings.version, version)))
          .returning();
  if (!saved) throw new LeadSettingsStale('lead settings changed');
  const changed = JSON.stringify(before) !== JSON.stringify(qualification);
  const rescored = changed ? await rescoreOpenLeads(tx, tenantId, qualification) : 0;
  await audit.append(tx, tenantId, {
    action: 'settings.lead_fields_updated',
    actorType: 'user',
    actorId: userId,
    subjectType: 'tenant',
    subjectId: tenantId,
    payload: {
      version: saved.version,
      fields: fieldCodes(input.fields),
      marketing: marketing.enabled,
      ...(saved.marketingWordingId
        ? { marketingWordingId: auditId(saved.marketingWordingId) }
        : {}),
      ...(changed ? { changed: [auditCode('qualification')], rescored } : {}),
    },
  });
  return { ...(await getLeadSettings(tx, tenantId)), rescored };
}

const visitorText = (t: { en: string; zh: string | null }) => ({ en: t.en, zh: t.zh || t.en });

/**
 * What the widget needs to capture leads (visitor zone, via `visitor_privacy()`): null without
 * a saved purpose statement, so no lead can be captured before the business says why (LED-02).
 */
export async function leadCaptureConfig(tx: Tx): Promise<LeadCaptureConfig | null> {
  const p = await visitorPrivacy(tx);
  if (!p?.purpose || !p.purposeWordingId) return null;
  const fields = parseFields(p.leadFields) ?? industryFields(p.industry);
  return {
    purpose: { wordingId: p.purposeWordingId, text: visitorText(p.purpose.purpose) },
    prompt: { en: p.purpose.consentPrompt.en, zh: p.purpose.consentPrompt.zh },
    marketing:
      p.marketing && p.marketingWordingId
        ? { wordingId: p.marketingWordingId, text: visitorText(p.marketing.text) }
        : null,
    fields: fields.flatMap((f) => (f.mode === 'off' ? [] : [{ key: f.key, mode: f.mode }])),
  };
}
