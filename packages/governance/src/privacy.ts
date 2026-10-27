import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { z } from 'zod';
import { audit } from './audit.js';
import { auditCode } from './payload.js';
import { canonicalJson } from './canonical.js';

const { privacySettings, wordingVersions } = schema;

/**
 * Privacy notice and PDPA purpose statement (GOV-14, LED-02; FEAT-058 §5.1). Every saved
 * wording is an immutable, numbered `wording_versions` row (D3); `privacy_settings` only
 * points at the current ones, with an optimistic `version` like assistant settings. A
 * consent record (FEAT-049) will name the wording row, so its content is self-contained.
 */

export const PRIVACY_TEMPLATE_VERSION = '2026-10-27';
export const CONSENT_WORDING_VERSION = '2026-10-27';

export interface LocalText {
  en: string;
  zh: string | null;
}

/** The default purpose statement (ui-design SCR-APP-047). Shown, but not saved, until reviewed (D6). */
export const DEFAULT_PURPOSE = {
  en: "We'll use your name and contact details to reply to your enquiry and follow up about it. We won't use them for anything else without asking.",
  zh: '我们会使用您的姓名和联系方式回复您的询问并跟进。未经您同意，我们不会将其用于其他用途。',
} as const;

/** The platform's question around the purpose statement (D4): the same for every business. */
export const CONSENT_PROMPT = {
  en: 'Is it OK for us to use your details for this?',
  zh: '可以为此使用您的资料吗？',
} as const;

const LocalTextContent = z.object({ en: z.string().min(1), zh: z.string().nullable() });

export const NoticeTemplateFields = z.object({
  contactName: z.string().min(1),
  contactEmail: z.string().min(1),
  contactPhone: z.string().nullable(),
  address: z.string().nullable(),
  extra: z.string().nullable(),
});
export type NoticeTemplateFields = z.infer<typeof NoticeTemplateFields>;

export const NoticeContent = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('link'), url: z.string().min(1) }),
  z.object({
    mode: z.literal('template'),
    templateVersion: z.string(),
    fields: NoticeTemplateFields,
  }),
]);
export type NoticeContent = z.infer<typeof NoticeContent>;

export const PurposeContent = z.object({
  purpose: LocalTextContent,
  consentPrompt: z.object({ en: z.string(), zh: z.string() }),
  wordingVersion: z.string(),
});
export type PurposeContent = z.infer<typeof PurposeContent>;

/** What a save takes: a notice without the template version, which this module stamps. */
export type NoticeInput =
  { mode: 'link'; url: string } | { mode: 'template'; fields: NoticeTemplateFields };

export interface WordingRef {
  id: string;
  seq: number;
  createdAt: Date;
}

export type NoticeState =
  | { mode: 'none' }
  | { mode: 'link'; url: string; wording: WordingRef }
  | {
      mode: 'template';
      fields: NoticeTemplateFields;
      templateVersion: string;
      wording: WordingRef;
    };

export interface PrivacySettings {
  /** 0 until the first save. */
  version: number;
  notice: NoticeState;
  /** The saved purpose statement, or the default (`wording` null) until one is saved. */
  purpose: { text: LocalText; wording: WordingRef | null };
}

export class PrivacyConflictError extends Error {
  override name = 'PrivacyConflictError';
}

type Kind = (typeof schema.WORDING_KINDS)[number];

async function loadWording(tx: Tx, tenantId: string, id: string | null) {
  if (!id) return null;
  const [row] = await tx
    .select()
    .from(wordingVersions)
    .where(and(eq(wordingVersions.tenantId, tenantId), eq(wordingVersions.id, id)));
  return row ?? null;
}

const refOf = (row: { id: string; seq: number; createdAt: Date }): WordingRef => ({
  id: row.id,
  seq: row.seq,
  createdAt: row.createdAt,
});

export async function getPrivacySettings(tx: Tx, tenantId: string): Promise<PrivacySettings> {
  const [row] = await tx
    .select()
    .from(privacySettings)
    .where(eq(privacySettings.tenantId, tenantId));
  const noticeRow = await loadWording(tx, tenantId, row?.noticeWordingId ?? null);
  const purposeRow = await loadWording(tx, tenantId, row?.purposeWordingId ?? null);
  let notice: NoticeState = { mode: 'none' };
  if (noticeRow) {
    const c = NoticeContent.parse(noticeRow.content);
    notice =
      c.mode === 'link'
        ? { mode: 'link', url: c.url, wording: refOf(noticeRow) }
        : {
            mode: 'template',
            fields: c.fields,
            templateVersion: c.templateVersion,
            wording: refOf(noticeRow),
          };
  }
  const purpose = purposeRow
    ? { text: PurposeContent.parse(purposeRow.content).purpose, wording: refOf(purposeRow) }
    : { text: { ...DEFAULT_PURPOSE }, wording: null };
  return { version: row?.version ?? 0, notice, purpose };
}

/**
 * Saves a new wording of `kind` if it differs from the current one, and points the settings
 * at it, if `version` is still current: 0 inserts the first row, n updates version n.
 * Identical content writes nothing (D3). A stale version raises `PrivacyConflictError`
 * before anything is written; a lost race raises it after, and the caller's transaction
 * rolls the new wording back.
 */
async function saveWording(
  tx: Tx,
  input: { tenantId: string; userId: string; version: number },
  kind: Kind,
  content: NoticeContent | PurposeContent,
  mode: string | null,
): Promise<PrivacySettings> {
  const { tenantId, userId, version } = input;
  const [row] = await tx
    .select()
    .from(privacySettings)
    .where(eq(privacySettings.tenantId, tenantId));
  const currentId = kind === 'privacy_notice' ? row?.noticeWordingId : row?.purposeWordingId;
  const current = await loadWording(tx, tenantId, currentId ?? null);
  if (current && canonicalJson(current.content) === canonicalJson(content)) {
    return getPrivacySettings(tx, tenantId);
  }
  if ((row?.version ?? 0) !== version) throw new PrivacyConflictError('privacy settings changed');

  const [{ next }] = (
    await tx.execute<{ next: number }>(
      sql`select coalesce(max(seq), 0)::int + 1 as next from wording_versions
          where tenant_id = ${tenantId} and kind = ${kind}`,
    )
  ).rows as [{ next: number }];
  const [wording] = await tx
    .insert(wordingVersions)
    .values({ tenantId, kind, seq: next, content, createdBy: userId })
    .returning();
  if (!wording) throw new Error('privacy: wording not inserted');

  const pointer =
    kind === 'privacy_notice' ? { noticeWordingId: wording.id } : { purposeWordingId: wording.id };
  const [saved] =
    version === 0
      ? await tx
          .insert(privacySettings)
          .values({ tenantId, ...pointer })
          .onConflictDoNothing()
          .returning()
      : await tx
          .update(privacySettings)
          .set({ ...pointer, version: sql`${privacySettings.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(privacySettings.tenantId, tenantId), eq(privacySettings.version, version)))
          .returning();
  if (!saved) throw new PrivacyConflictError('privacy settings changed');

  await audit.append(tx, tenantId, {
    action:
      kind === 'privacy_notice'
        ? 'settings.privacy_notice_updated'
        : 'settings.purpose_statement_updated',
    actorType: 'user',
    actorId: userId,
    subjectType: 'wording_version',
    subjectId: wording.id,
    payload: {
      version: saved.version,
      seq: wording.seq,
      ...(mode ? { mode: auditCode(mode) } : {}),
    },
  });
  return getPrivacySettings(tx, tenantId);
}

export function savePrivacyNotice(
  tx: Tx,
  input: { tenantId: string; userId: string; version: number; notice: NoticeInput },
): Promise<PrivacySettings> {
  const { notice } = input;
  const content: NoticeContent =
    notice.mode === 'link'
      ? { mode: 'link', url: notice.url }
      : {
          mode: 'template',
          templateVersion: PRIVACY_TEMPLATE_VERSION,
          fields: {
            ...notice.fields,
            contactPhone: notice.fields.contactPhone || null,
            address: notice.fields.address || null,
            extra: notice.fields.extra || null,
          },
        };
  return saveWording(tx, input, 'privacy_notice', content, notice.mode);
}

export function savePurposeStatement(
  tx: Tx,
  input: { tenantId: string; userId: string; version: number; purpose: LocalText },
): Promise<PrivacySettings> {
  const content: PurposeContent = {
    purpose: { en: input.purpose.en, zh: input.purpose.zh || null },
    consentPrompt: { ...CONSENT_PROMPT },
    wordingVersion: CONSENT_WORDING_VERSION,
  };
  return saveWording(tx, input, 'purpose_statement', content, null);
}

/**
 * The privacy items of the readiness check (ONB-09, UC-03 10a; D6): true once a notice and a
 * purpose statement have been saved. Showing the default doesn't count.
 */
export async function privacyReadiness(
  tx: Tx,
  tenantId: string,
): Promise<{ privacyNotice: boolean; purposeStatement: boolean }> {
  const [row] = await tx
    .select()
    .from(privacySettings)
    .where(eq(privacySettings.tenantId, tenantId));
  return {
    privacyNotice: !!row?.noticeWordingId,
    purposeStatement: !!row?.purposeWordingId,
  };
}

export interface VisitorPrivacy {
  notice: NoticeContent | null;
  noticeWordingId: string | null;
  noticeSavedAt: Date | null;
  purpose: PurposeContent | null;
  purposeWordingId: string | null;
  businessName: string;
  uen: string | null;
}

interface VisitorPrivacyRow extends Record<string, unknown> {
  notice: unknown;
  notice_wording_id: string | null;
  notice_saved_at: Date | string | null;
  purpose: unknown;
  purpose_wording_id: string | null;
  business_name: string;
  uen: string | null;
}

/** The current wordings for the visitor zone, via `visitor_privacy()` (no table grants). */
export async function visitorPrivacy(tx: Tx): Promise<VisitorPrivacy | null> {
  const { rows } = await tx.execute<VisitorPrivacyRow>(sql`select * from visitor_privacy()`);
  const r = rows[0];
  if (!r) return null;
  return {
    notice: r.notice ? NoticeContent.parse(r.notice) : null,
    noticeWordingId: r.notice_wording_id,
    noticeSavedAt: r.notice_saved_at ? new Date(r.notice_saved_at) : null,
    purpose: r.purpose ? PurposeContent.parse(r.purpose) : null,
    purposeWordingId: r.purpose_wording_id,
    businessName: r.business_name,
    uen: r.uen,
  };
}

/** The widget's privacy link: the tenant's own URL, the hosted template page, or none. */
export function privacyNoticeUrl(
  notice: NoticeContent | null,
  widgetKey: string,
  publicApiUrl: string,
): string | null {
  if (!notice) return null;
  if (notice.mode === 'link') return notice.url;
  return `${publicApiUrl.replace(/\/+$/, '')}/privacy/${encodeURIComponent(widgetKey)}`;
}
