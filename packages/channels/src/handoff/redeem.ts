import { and, asc, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import type { InboxPort } from '../email/receive.js';
import { buildRecap, RECAP_EMAIL_MESSAGES } from './recap.js';
import { survivorOf } from './request.js';
import { openHandoff, type HandoffLinkChannel } from './token.js';

/**
 * Redeeming a handoff link (CHN-07, UC-26 step 4, 1a, 4a; FEAT-038 §5.3, §5.4). The adapter
 * proves the identifier (a Telegram `/start`, an email confirm); this file checks the link and
 * moves the same conversation, with the recap as its first message on the new channel.
 */
export type HandoffLink = typeof schema.handoffLinks.$inferSelect;

export const MOVED_NOTICE: Record<HandoffLinkChannel, Record<'en' | 'zh', string>> = {
  telegram: {
    en: 'This chat continues on Telegram.',
    zh: '此聊天将在 Telegram 上继续。',
  },
  email: { en: 'This chat continues by email.', zh: '此聊天将通过电子邮件继续。' },
};

/**
 * The link a code names, locked, when it can still be used: the MAC is right for this tenant,
 * the row is for this channel, unused, unexpired, and its conversation is open and still on
 * the widget. Otherwise null (the expired reply or page, UC-26 4a).
 */
export async function lockLink(
  tx: Tx,
  input: {
    tenantId: string;
    code: string;
    secret: string;
    channel: HandoffLinkChannel;
    now: Date;
  },
): Promise<HandoffLink | null> {
  const opened = openHandoff(input.secret, input.tenantId, input.code);
  if (!opened || opened.channel !== input.channel) return null;
  const l = schema.handoffLinks;
  const [link] = await tx
    .select()
    .from(l)
    .where(and(eq(l.tenantId, input.tenantId), eq(l.id, opened.linkId)))
    .for('update');
  if (!link || link.channel !== input.channel || link.usedAt || link.expiresAt <= input.now)
    return null;
  const c = schema.conversations;
  const [conv] = await tx
    .select({ channel: c.channel, status: c.status })
    .from(c)
    .where(and(eq(c.tenantId, input.tenantId), eq(c.id, link.conversationId)));
  if (!conv || conv.channel !== 'widget' || conv.status === 'closed') return null;
  return link;
}

/** Marks the link used and returns the contact to attach to (a merged-away one's survivor). */
export async function useLink(
  tx: Tx,
  link: HandoffLink,
  now: Date,
  chatId: number | null = null,
): Promise<string> {
  const l = schema.handoffLinks;
  await tx
    .update(l)
    .set({ usedAt: now, usedChatId: chatId })
    .where(and(eq(l.tenantId, link.tenantId), eq(l.id, link.id)));
  return survivorOf(tx, link.tenantId, link.contactId);
}

export type RedeemInboxPort = Pick<InboxPort, 'moveConversation' | 'appendSystemNotice'>;

/**
 * Moves the link's conversation (§5.5) and stores the recap (§5.6) as a `handoff_recap`
 * notice, which the delivery trigger sends on the new channel. Audited `handoff.completed`.
 * `beforeRecap` runs between the two (the email path's thread row).
 */
export async function finishHandoff(
  tx: Tx,
  input: {
    link: HandoffLink;
    inbox: RedeemInboxPort;
    texts: { businessName: string; assistantName: string };
    movedCard: Record<string, unknown>;
    mergedFrom: string | null;
    beforeRecap?: () => Promise<void>;
  },
) {
  const { link } = input;
  const channel = link.channel;
  const moved = await input.inbox.moveConversation(tx, {
    tenantId: link.tenantId,
    conversationId: link.conversationId,
    to: channel,
    notice: (l) => MOVED_NOTICE[channel][l],
    card: input.movedCard,
  });
  if (!moved) throw new Error('handoff: the conversation moved under its lock');
  await input.beforeRecap?.();
  const m = schema.messages;
  const history = await tx
    .select({
      author: m.author,
      body: m.body,
      authorName: m.authorName,
      createdAt: m.createdAt,
      noticeKind: m.noticeKind,
    })
    .from(m)
    .where(and(eq(m.tenantId, link.tenantId), eq(m.conversationId, link.conversationId)))
    .orderBy(asc(m.seq));
  const language = moved.notice.language === 'zh' ? 'zh' : 'en';
  const text = buildRecap({
    channel,
    language,
    businessName: input.texts.businessName,
    assistantName: input.texts.assistantName,
    messages: history.slice(-RECAP_EMAIL_MESSAGES * 2),
  });
  const recap = await input.inbox.appendSystemNotice(tx, {
    tenantId: link.tenantId,
    conversationId: link.conversationId,
    kind: 'handoff_recap',
    text: () => text,
  });
  await audit.append(tx, link.tenantId, {
    action: 'handoff.completed',
    actorType: 'visitor',
    subjectType: 'conversation',
    subjectId: link.conversationId,
    ...(input.mergedFrom ? { related: [{ type: 'contact', id: input.mergedFrom }] } : {}),
    payload: {
      conversationId: auditId(link.conversationId),
      channel: auditCode(channel),
      merged: input.mergedFrom !== null,
    },
  });
  return { conversation: moved.conversation, moved: moved.notice, recap };
}

/** For a definer lookup by link ID (the confirm page, §5.4): the tenant, or null. */
export async function linkTenant(tx: Tx, linkId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ t: string | null }>(
    sql`select handoff_link_tenant(${linkId}::uuid) as t`,
  );
  return rows[0]?.t ?? null;
}
