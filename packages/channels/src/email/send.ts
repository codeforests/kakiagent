/**
 * The email reply (CHN-04, NFR-18; FEAT-036 §5.1 `send.ts`). Threads with In-Reply-To and
 * References, `Re:` once, `Auto-Submitted: auto-replied` on AI and system replies only
 * (RFC 3834), from the verified custom address or else the forwarding address (D4).
 * Idempotent on the message: an `out` row for it means it was already sent.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, schema, type Tx } from '@kaki/db';
import { smtpCode, type Mailer } from '@kaki/platform';
import type { SendResult } from '../adapter.js';
import type { ChannelSender } from '../deliver.js';
import { EMAIL_CAPABILITIES } from './capabilities.js';
import { replySubject } from './thread.js';

export interface EmailSenderConfig {
  mailer: Mailer;
  /** `in.<platform domain>`: the forwarding addresses and our Message-IDs. */
  inboundDomain: string;
  /** SES replaces our Message-ID with `<SES id>@<this>`; both are stored (§8). */
  sesMessageIdDomain: string;
}

const { emailMessages, emailThreads, emailSettings, contacts } = schema;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quoteName = (s: string) => `"${s.replace(/["\\\r\n]/g, '')}"`;

/** SMTP reply codes → the adapter's failure kinds (ADR-011). */
export function classifySmtp(err: unknown): Exclude<SendResult, { ok: true }> {
  const code = smtpCode(err);
  if (code === 530 || code === 535 || code === 454)
    return { ok: false, failed: 'auth', status: code };
  if (code !== null && code >= 500) return { ok: false, failed: 'permanent', status: code };
  return { ok: false, failed: 'transient', ...(code !== null ? { status: code } : {}) };
}

export function emailSender(cfg: EmailSenderConfig): ChannelSender {
  const domain = cfg.inboundDomain.toLowerCase();
  return {
    capabilities: EMAIL_CAPABILITIES,
    async send(tx: Tx, input) {
      const { tenantId, conversation, message, text, businessName } = input;
      const [already] = await tx
        .select({ id: emailMessages.rfcMessageId })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, tenantId),
            eq(emailMessages.messageId, message.id),
            eq(emailMessages.direction, 'out'),
          ),
        )
        .limit(1);
      if (already) return { ok: true, externalId: already.id };
      const [thread] = await tx
        .select()
        .from(emailThreads)
        .where(
          and(
            eq(emailThreads.tenantId, tenantId),
            eq(emailThreads.conversationId, conversation.id),
          ),
        );
      const [contact] = conversation.contactId
        ? await tx
            .select({ email: contacts.email })
            .from(contacts)
            .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, conversation.contactId)))
        : [];
      const [settings] = await tx
        .select()
        .from(emailSettings)
        .where(eq(emailSettings.tenantId, tenantId));
      if (!thread || !contact?.email || !settings) return { ok: false, failed: 'permanent' };
      const replyFrom =
        settings.domainState === 'verified' && settings.domainAddress
          ? settings.domainAddress
          : `${settings.forwardingLocal}@${domain}`;
      const ours = `<${randomUUID()}@${domain}>`;
      const references = thread.references.slice(-20);
      const headers: Record<string, string> = { 'X-Kaki-Message': message.id };
      if (thread.lastInboundId) headers['In-Reply-To'] = thread.lastInboundId;
      if (references.length) headers.References = references.join(' ');
      if (message.author !== 'staff') headers['Auto-Submitted'] = 'auto-replied';
      let providerId: string | null;
      try {
        const sent = await cfg.mailer.send({
          from: `${quoteName(businessName)} <${replyFrom}>`,
          to: contact.email,
          subject: replySubject(thread.subject),
          text,
          html: `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`,
          headers,
          messageId: ours,
        });
        providerId = sent?.providerId ?? null;
      } catch (err) {
        return classifySmtp(err);
      }
      const ids = [ours, ...(providerId ? [`<${providerId}@${cfg.sesMessageIdDomain}>`] : [])];
      await tx
        .insert(emailMessages)
        .values(
          ids.map((rfcMessageId) => ({
            tenantId,
            rfcMessageId,
            conversationId: conversation.id,
            messageId: message.id,
            direction: 'out' as const,
          })),
        )
        .onConflictDoNothing();
      await tx
        .update(emailThreads)
        .set({ references: [...references, ours].slice(-20), updatedAt: new Date() })
        .where(
          and(
            eq(emailThreads.tenantId, tenantId),
            eq(emailThreads.conversationId, conversation.id),
          ),
        );
      return { ok: true, externalId: providerId ?? ours };
    },
  };
}
