import { and, eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import type { Mailer } from '@kaki/platform';
import { attachVerified } from '../contacts/identity.js';
import { classifySmtp, quoteName, replyAddressOf } from '../email/send.js';
import { maskEmail } from './recap.js';
import { finishHandoff, lockLink, useLink, type RedeemInboxPort } from './redeem.js';
import { peekHandoff, signHandoff } from './token.js';

/**
 * The email handoff (CHN-07, UC-26 1a; FEAT-038 §5.4, D3, D7): a confirmation mail from the
 * business's reply address, then a confirm page whose POST proves the address and moves the
 * conversation to email. GET never consumes, so mail scanners that prefetch links do nothing.
 */
export const CONFIRM_SUBJECT = {
  en: (b: string) => `Continue your chat with ${b}`,
  zh: (b: string) => `继续与${b}的聊天`,
};
export const THREAD_SUBJECT = {
  en: (b: string) => `Your chat with ${b}`,
  zh: (b: string) => `您与${b}的聊天`,
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface HandoffEmailDeps {
  zdb: ZoneDb;
  mailer: Mailer;
  secret: string;
  /** `in.<platform domain>`, for the forwarding address. */
  inboundDomain: string;
  /** The api's public origin: the link is `<apiUrl>/continue/<code>`. */
  apiUrl: string;
  businessName(tx: Tx): Promise<string>;
  now?: () => Date;
}

export type HandoffEmailOutcome = 'sent' | 'skipped' | 'failed';

/**
 * The `handoff_email` job (agent-worker). Idempotent: a used, expired or unknown link is
 * skipped. A permanent failure is dropped (the widget's "Send again" covers it); a transient
 * one throws, so the queue retries it.
 */
export async function sendHandoffEmail(
  deps: HandoffEmailDeps,
  job: { tenantId: string; linkId: string },
): Promise<HandoffEmailOutcome> {
  const now = deps.now?.() ?? new Date();
  return withTenant(deps.zdb, job.tenantId, async (tx) => {
    const l = schema.handoffLinks;
    const [link] = await tx
      .select()
      .from(l)
      .where(and(eq(l.tenantId, job.tenantId), eq(l.id, job.linkId)));
    if (!link || link.channel !== 'email' || !link.email || link.usedAt || link.expiresAt <= now)
      return 'skipped';
    const [settings] = await tx
      .select()
      .from(schema.emailSettings)
      .where(eq(schema.emailSettings.tenantId, job.tenantId));
    if (!settings) return 'skipped';
    const language = await conversationLanguage(tx, job.tenantId, link.conversationId);
    const business = await deps.businessName(tx);
    const url = `${deps.apiUrl.replace(/\/+$/, '')}/continue/${signHandoff(deps.secret, job.tenantId, link.id, 'email')}`;
    const text =
      language === 'zh'
        ? `您在${business}网站上的聊天中要求通过电子邮件继续。确认此地址即可继续：\n\n${url}\n\n此链接 24 小时内有效。如果这不是您本人的请求，请忽略此邮件。`
        : `You asked to continue your chat with ${business} by email. Confirm this address to carry on:\n\n${url}\n\nIt works for 24 hours. If you didn't ask for this, ignore this email.`;
    try {
      await deps.mailer.send({
        from: `${quoteName(business)} <${replyAddressOf(settings, deps.inboundDomain)}>`,
        to: link.email,
        subject: CONFIRM_SUBJECT[language](business),
        text,
        html: `<div style="white-space:pre-wrap">${escapeHtml(text).replace(
          escapeHtml(url),
          `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`,
        )}</div>`,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } catch (err) {
      const kind = classifySmtp(err);
      if (kind.failed === 'transient') throw err;
      return 'failed';
    }
    return 'sent';
  });
}

async function conversationLanguage(tx: Tx, tenantId: string, conversationId: string) {
  const { rows } = await tx.execute<{ language: string | null }>(
    sql`select language from messages where tenant_id = ${tenantId} and conversation_id = ${conversationId}
        and author in ('agent', 'system') and language is not null order by seq desc limit 1`,
  );
  return rows[0]?.language === 'zh' ? ('zh' as const) : ('en' as const);
}

/** What the confirm page shows (§5.4): the business, the masked address, the language. */
export interface HandoffPageView {
  tenantId: string;
  sentTo: string;
  language: 'en' | 'zh';
}

/**
 * The tenant a confirm code belongs to, by the link's definer lookup; null for a malformed
 * code or an unknown link. The MAC is checked against that tenant afterwards.
 */
export async function confirmCodeTenant(zdb: ZoneDb, code: string): Promise<string | null> {
  const peeked = peekHandoff(code);
  if (!peeked || peeked.channel !== 'email') return null;
  const { rows } = await zdb.db.execute<{ t: string | null }>(
    sql`select handoff_link_tenant(${peeked.linkId}::uuid) as t`,
  );
  return rows[0]?.t ?? null;
}

/** The confirm page's GET: the link is checked but never consumed. Null: the expired page. */
export async function viewEmailHandoff(
  tx: Tx,
  input: { tenantId: string; code: string; secret: string; now: Date },
): Promise<HandoffPageView | null> {
  const link = await lockLink(tx, { ...input, channel: 'email' });
  if (!link?.email) return null;
  return {
    tenantId: input.tenantId,
    sentTo: maskEmail(link.email),
    language: await conversationLanguage(tx, input.tenantId, link.conversationId),
  };
}

/**
 * The confirm page's POST (§5.4): the address is proven. It joins the conversation's contact
 * as a verified `link` identity (merging a contact that already held it), becomes the contact's
 * display email (D7: the email adapter sends there), and the same conversation moves to email
 * with a new thread whose first email is the transcript. Null: the expired page, nothing changed.
 */
export async function confirmEmailHandoff(
  tx: Tx,
  input: {
    tenantId: string;
    code: string;
    secret: string;
    inbox: RedeemInboxPort;
    texts: { businessName: string; assistantName: string };
    now: Date;
  },
) {
  const link = await lockLink(tx, { ...input, channel: 'email' });
  if (!link?.email) return null;
  const email = link.email;
  const linked = await useLink(tx, link, input.now);
  const { contactId, mergedFrom } = await attachVerified(tx, input.tenantId, linked, {
    kind: 'email',
    value: email,
    source: 'link',
    verified: true,
  });
  await tx
    .update(schema.contacts)
    .set({ email, updatedAt: input.now })
    .where(and(eq(schema.contacts.tenantId, input.tenantId), eq(schema.contacts.id, contactId)));
  const language = await conversationLanguage(tx, input.tenantId, link.conversationId);
  const done = await finishHandoff(tx, {
    link,
    inbox: input.inbox,
    texts: input.texts,
    movedCard: { kind: 'moved', channel: 'email', url: null, sentTo: maskEmail(email) },
    mergedFrom,
    beforeRecap: async () => {
      await tx
        .insert(schema.emailThreads)
        .values({
          tenantId: input.tenantId,
          conversationId: link.conversationId,
          subject: THREAD_SUBJECT[language](input.texts.businessName).slice(0, 200),
        })
        .onConflictDoNothing();
    },
  });
  return { ...done, language };
}
