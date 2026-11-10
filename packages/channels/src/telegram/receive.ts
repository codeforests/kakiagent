/**
 * Inbound Telegram (CHN-05, NFR-17; FEAT-037 §5.3, D2, D5, D10). The api's generic hook route
 * calls `receiveTelegram` per webhook: the connection gives the tenant and the secret's hash
 * (`channel_hook_route()`, never the body), the secret header is checked by hash (D3), and
 * everything else runs in one visitor-zone transaction under that tenant, locked on the chat,
 * before the webhook answers. Service replies (group notice, link confirmations, the greeting)
 * are `channel-send` jobs of `type: 'service'`, queued in the same transaction.
 */
import { createHash } from 'node:crypto';
import { and, eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { enqueue } from '@kaki/platform/outbox';
import type { InboundEvent } from '../adapter.js';
import type { InboxPort } from '../email/receive.js';
import { secretMatches } from './credential.js';
import { blockChange, telegramIgnoreReason } from './ignore.js';
import { displayName, normaliseUpdate, telegramOf, type TelegramExtensions } from './parse.js';

const { inboundEvents: ie, telegramSettings: ts, telegramChats: tc } = schema;
const links = schema.telegramAlertLinks;

type ConversationRow = typeof schema.conversations.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

/** What the business says on `/start` and in its service replies (bound by the api). */
export interface TelegramTexts {
  businessName: string;
  /** The `/start` reply: the greeting, the AI disclosure and the privacy line (D7). */
  greeting: string;
}

export interface TelegramInboxPort extends InboxPort {
  appendSystemNotice(
    tx: Tx,
    input: {
      tenantId: string;
      conversationId: string;
      kind: 'text_only';
      text: (language: 'en' | 'zh') => string;
    },
  ): Promise<MessageRow>;
  noticeSince(
    tx: Tx,
    tenantId: string,
    conversationId: string,
    kind: 'text_only',
    since: Date | null,
  ): Promise<boolean>;
}

export interface TelegramReceiveDeps {
  /** The visitor zone. */
  zdb: ZoneDb;
  inbox: TelegramInboxPort;
  texts(tx: Tx, tenantId: string, lang: 'en' | 'zh'): Promise<TelegramTexts>;
  /** The dashboard's base URL, for the links in service replies. */
  appUrl: string;
  now?: () => Date;
}

export type TelegramReceiveResult =
  | { status: 404 }
  | { status: 401 }
  | { status: 200; outcome: 'malformed' | 'duplicate' | 'unhandled' }
  | {
      status: 200;
      tenantId: string;
      outcome: 'linked' | 'link_expired' | 'unlinked' | 'blocked' | 'start' | 'accepted';
      conversation?: ConversationRow;
      message?: MessageRow;
      newConversation?: boolean;
    }
  | {
      status: 200;
      tenantId: string;
      outcome: 'ignored';
      reason: 'group' | 'unsupported' | 'staff_chat';
    };

/** A one-time alert-link code (D1): `link-` and 22 base64url characters. */
export const LINK_CODE = /^link-[A-Za-z0-9_-]{22}$/;
export const codeHash = (code: string) => createHash('sha256').update(code, 'utf8').digest();
/** The staff-chat reply at most this often (§5.3). */
const STAFF_NOTICE_MS = 60 * 60 * 1000;
/** One "text only" notice per conversation per 24 hours (§5.3). */
const TEXT_ONLY_MS = 24 * 60 * 60 * 1000;

export const TEXT_ONLY_NOTICE = {
  en: 'I can only read text messages. Please type your question.',
  zh: '我只能读取文字消息，请输入您的问题。',
} as const;

const langOf = (hint: string | null): 'en' | 'zh' =>
  hint?.toLowerCase().startsWith('zh') ? 'zh' : 'en';

/** `visitor_id` for a Telegram user: UUIDv5-shaped from `tenant:telegram:<user id>`. */
export function telegramVisitorId(tenantId: string, userId: string): string {
  const h = createHash('sha1').update(`kaki-telegram:${tenantId}:${userId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** A service reply on `channel-send` (not a conversation message; dropped after 24 hours). */
export async function queueServiceReply(
  tx: Tx,
  job: { tenantId: string; connectionId: string; chatId: number; text: string; leave?: boolean },
  now: Date = new Date(),
): Promise<void> {
  await enqueue(tx, {
    tenantId: job.tenantId,
    topic: 'channel-send',
    groupKey: `tg:${job.chatId}`,
    payload: {
      type: 'service',
      tenantId: job.tenantId,
      connectionId: job.connectionId,
      chatId: job.chatId,
      text: job.text.slice(0, 4096),
      ...(job.leave ? { leave: true } : {}),
      queuedAt: now.toISOString(),
    },
  });
}

export async function receiveTelegram(
  deps: TelegramReceiveDeps,
  req: { connectionId: string; secretHeader: string | undefined; body: unknown },
): Promise<TelegramReceiveResult> {
  const { rows } = await deps.zdb.db.execute<{ tenant_id: string; secret_hash: Buffer }>(
    sql`select tenant_id, secret_hash from channel_hook_route(${req.connectionId}::uuid, 'telegram')`,
  );
  const route = rows[0];
  if (!route) return { status: 404 };
  if (!secretMatches(req.secretHeader, route.secret_hash)) return { status: 401 };
  const tenantId = route.tenant_id;
  const event = normaliseUpdate(req.body, { tenantId, connectionId: req.connectionId });
  if (!event) return { status: 200, outcome: 'malformed' };
  const now = deps.now?.() ?? new Date();
  return withTenant(deps.zdb, tenantId, (tx) =>
    receiveInTenant(tx, deps, { tenantId, connectionId: req.connectionId, event, now }),
  );
}

interface Ctx {
  tenantId: string;
  connectionId: string;
  event: InboundEvent;
  now: Date;
}

async function receiveInTenant(
  tx: Tx,
  deps: TelegramReceiveDeps,
  c: Ctx,
): Promise<TelegramReceiveResult> {
  const t = telegramOf(c.event);
  const { tenantId, connectionId, now } = c;
  // Two updates of one chat never race (§5.3 step 2).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tg:${tenantId}:${t.chatId}`}))`);
  const [seen] = await tx
    .select({ id: ie.id })
    .from(ie)
    .where(
      and(
        eq(ie.tenantId, tenantId),
        eq(ie.connectionId, connectionId),
        eq(ie.providerEventId, String(t.updateId)),
      ),
    );
  if (seen) return { status: 200, outcome: 'duplicate' };
  const record = (
    outcome: 'accepted' | 'ignored',
    reason: 'group' | 'unsupported' | 'staff_chat' | null = null,
  ) =>
    tx.insert(ie).values({
      tenantId,
      connectionId,
      providerEventId: String(t.updateId),
      receivedAt: now,
      outcome,
      ignoreReason: reason,
    });
  const reply = (text: string, leave = false) =>
    queueServiceReply(tx, { tenantId, connectionId, chatId: t.chatId, text, leave }, now);
  const lang = langOf(c.event.localeHint);
  const app = deps.appUrl.replace(/\/+$/, '');

  const [bot] = await tx.select().from(ts).where(eq(ts.tenantId, tenantId));
  if (!bot) return { status: 200, outcome: 'unhandled' };
  const texts = () => deps.texts(tx, tenantId, lang);

  // A member linking Telegram for alerts (D1): `/start <code>`.
  if (
    t.chatType === 'private' &&
    t.command === 'start' &&
    t.startPayload &&
    LINK_CODE.test(t.startPayload)
  ) {
    await record('accepted');
    const [link] = await tx
      .select()
      .from(links)
      .where(and(eq(links.tenantId, tenantId), eq(links.codeHash, codeHash(t.startPayload))));
    if (!link || !link.codeExpiresAt || link.codeExpiresAt <= now) {
      await reply('This link has expired. Get a new one in KakiAgent.');
      return { status: 200, tenantId, outcome: 'link_expired' };
    }
    // One member per chat: a chat linked to someone else moves to this member.
    await tx
      .update(links)
      .set({ chatId: null, linkedAt: null, telegramName: null })
      .where(and(eq(links.tenantId, tenantId), eq(links.chatId, t.chatId)));
    await tx
      .update(links)
      .set({
        chatId: t.chatId,
        telegramName: t.firstName?.slice(0, 64) || null,
        linkedAt: now,
        codeHash: null,
        codeExpiresAt: null,
      })
      .where(and(eq(links.tenantId, tenantId), eq(links.userId, link.userId)));
    const { businessName } = await texts();
    await reply(
      `You'll get ${businessName} alerts here. Change them in KakiAgent: ${app}/account/notifications`,
    );
    return { status: 200, tenantId, outcome: 'linked' };
  }

  // Groups: say it once, then leave (CHN-05, D2).
  const ignore = telegramIgnoreReason(c.event);
  if (ignore === 'group') {
    await record('ignored', 'group');
    await reply(
      `I only answer private messages. Message me here: https://t.me/${bot.botUsername}`,
      true,
    );
    return { status: 200, tenantId, outcome: 'ignored', reason: 'group' };
  }
  if (t.chatType !== 'private') {
    await record('accepted');
    return { status: 200, tenantId, outcome: 'unhandled' } as TelegramReceiveResult;
  }

  // A member's own alerts chat is never a customer conversation (§5.3).
  const [member] = await tx
    .select()
    .from(links)
    .where(and(eq(links.tenantId, tenantId), eq(links.chatId, t.chatId)));
  if (member) {
    await record('ignored', 'staff_chat');
    if (blockChange(c.event) === 'blocked' || t.command === 'stop') {
      await tx
        .delete(links)
        .where(and(eq(links.tenantId, tenantId), eq(links.userId, member.userId)));
      if (t.command === 'stop') await reply('Alerts stopped. Link Telegram again in KakiAgent.');
      return { status: 200, tenantId, outcome: 'unlinked' };
    }
    if (
      c.event.kind === 'message' &&
      (!member.staffNoticeAt || now.getTime() - member.staffNoticeAt.getTime() >= STAFF_NOTICE_MS)
    ) {
      const { businessName } = await texts();
      await reply(
        `This chat gets your ${businessName} alerts. To answer customers, use the inbox: ${app}/inbox`,
      );
      await tx
        .update(links)
        .set({ staffNoticeAt: now })
        .where(and(eq(links.tenantId, tenantId), eq(links.userId, member.userId)));
    }
    return { status: 200, tenantId, outcome: 'ignored', reason: 'staff_chat' };
  }

  const [chat] = await tx
    .select()
    .from(tc)
    .where(and(eq(tc.tenantId, tenantId), eq(tc.chatId, t.chatId)));

  // The customer blocked or unblocked the bot.
  const block = blockChange(c.event);
  if (c.event.kind === 'postback') {
    await record('accepted');
    if (block && chat)
      await tx
        .update(tc)
        .set({ blockedAt: block === 'blocked' ? now : null })
        .where(and(eq(tc.tenantId, tenantId), eq(tc.chatId, t.chatId)));
    return {
      status: 200,
      tenantId,
      outcome: block === 'blocked' ? 'blocked' : 'accepted',
    } as TelegramReceiveResult;
  }

  let conversation = chat?.conversationId
    ? await deps.inbox.getConversation(tx, tenantId, chat.conversationId)
    : null;
  if (conversation && conversation.status === 'closed' && !deps.inbox.reopenable(conversation, now))
    conversation = null;

  // A tap on Start isn't a question: the greeting, no conversation yet (§5.3).
  if (t.command === 'start') {
    await record('accepted');
    if (!conversation || conversation.status === 'closed') await reply((await texts()).greeting);
    return { status: 200, tenantId, outcome: 'start' };
  }

  const unsupported = ignore === 'unsupported';
  await record(unsupported ? 'ignored' : 'accepted', unsupported ? 'unsupported' : null);
  const contactId = await contactFor(tx, tenantId, c.event.externalUserId, t);
  let newConversation = false;
  if (!conversation) {
    conversation = await deps.inbox.createConversation(
      tx,
      tenantId,
      telegramVisitorId(tenantId, c.event.externalUserId),
      'telegram',
    );
    await deps.inbox.setConversationContact(tx, tenantId, conversation.id, contactId);
    newConversation = true;
  } else if (!conversation.contactId) {
    await deps.inbox.setConversationContact(tx, tenantId, conversation.id, contactId);
  }
  const appended = await deps.inbox.appendVisitorMessage(tx, {
    tenantId,
    conversationId: conversation.id,
    visitorId: conversation.visitorId,
    text: unsupported ? (t.contentLabel ?? '[Message]') : c.event.text!,
    clientMessageId: `tg:${t.updateId}`,
    scheduleTurn: !unsupported,
  });
  if (unsupported) {
    const since = new Date(now.getTime() - TEXT_ONLY_MS);
    if (!(await deps.inbox.noticeSince(tx, tenantId, conversation.id, 'text_only', since)))
      await deps.inbox.appendSystemNotice(tx, {
        tenantId,
        conversationId: conversation.id,
        kind: 'text_only',
        text: (l) => TEXT_ONLY_NOTICE[l],
      });
  }
  await tx
    .insert(tc)
    .values({
      tenantId,
      chatId: t.chatId,
      botId: bot.botId,
      contactId,
      conversationId: conversation.id,
      lastInboundAt: now,
    })
    .onConflictDoUpdate({
      target: [tc.tenantId, tc.chatId],
      set: { contactId, conversationId: conversation.id, lastInboundAt: now, blockedAt: null },
    });
  if (!unsupported)
    await tx.update(ts).set({ lastReceivedAt: now }).where(eq(ts.tenantId, tenantId));
  if (unsupported) return { status: 200, tenantId, outcome: 'ignored', reason: 'unsupported' };
  return {
    status: 200,
    tenantId,
    outcome: 'accepted',
    conversation: appended.conversation,
    message: appended.message,
    newConversation,
  };
}

/** The contact by Telegram user ID (D5): one Telegram user is one contact per business. */
async function contactFor(
  tx: Tx,
  tenantId: string,
  userId: string,
  t: TelegramExtensions,
): Promise<string> {
  const id = Number(userId);
  const username = t.username?.slice(0, 32) || null;
  const inserted = await tx.execute<{ id: string }>(
    sql`insert into contacts (tenant_id, name, telegram_id, telegram_username)
        values (${tenantId}, ${displayName(t)}, ${id}, ${username})
        on conflict (tenant_id, telegram_id) where telegram_id is not null do nothing returning id`,
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const found = await tx.execute<{ id: string; telegram_username: string | null }>(
    sql`select id, telegram_username from contacts where tenant_id = ${tenantId} and telegram_id = ${id}`,
  );
  const row = found.rows[0]!;
  if (username && row.telegram_username !== username)
    await tx.execute(
      sql`update contacts set telegram_username = ${username}, updated_at = now()
          where tenant_id = ${tenantId} and id = ${row.id}`,
    );
  return row.id;
}

/** A member's link has a pending code while it is unexpired (the prefs page's `pending`). */
export function linkPending(row: { codeExpiresAt: Date | null }, now = new Date()): boolean {
  return !!row.codeExpiresAt && row.codeExpiresAt > now;
}
