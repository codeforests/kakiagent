/**
 * Channel handoff through the api (CHN-07, UC-26; FEAT-038 §5.2–§5.4, §5.8; AC-1–AC-8, AC-10):
 * the Telegram `/start c-…` redemption, the email confirm page and the widget routes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { requestHandoff, signHandoff } from '@kaki/channels/handoff';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { signToken } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { testApp } from './support.js';

const HANDOFF_SECRET = 'h'.repeat(32);
const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';
const HOOK_SECRET = 'the-webhook-secret-for-tenant-a';
const BOT = 930001;

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let connectionId: string;
const published: {
  channel: string;
  payload: { type: string; message?: { noticeKind?: string } };
}[] = [];
let updateId = 9000;
let chatSeq = 8_100_000;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    env: { VISITOR_TOKEN_SECRET: VISITOR_SECRET, HANDOFF_LINK_SECRET: HANDOFF_SECRET },
    publisher: {
      publish: async (channel: string, payload: unknown) =>
        void published.push({ channel, payload: payload as { type: string } }),
      close: async () => {},
    },
  });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const c = await owner.query<{ id: string }>(
    `insert into channel_connections (tenant_id, kind, state, offline_mode, health)
     values ($1, 'telegram', 'live', 'hidden', 'ok') returning id`,
    [TENANT_A],
  );
  connectionId = c.rows[0]!.id;
  await owner.query(
    `insert into telegram_settings (tenant_id, connection_id, bot_id, bot_username, bot_name, webhook_secret_hash)
     values ($1, $2, $3, 'kaki_bakery_bot', 'Kaki Bakery', $4)`,
    [TENANT_A, connectionId, BOT, createHash('sha256').update(HOOK_SECRET).digest()],
  );
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await owner.query<T>(text, values)).rows;

/** A widget conversation with two messages, as the owner. */
async function widgetChat(t = TENANT_A) {
  const visitorId = randomUUID();
  const [conv] = await q<{ id: string }>(
    `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', $2) returning id`,
    [t, visitorId],
  );
  await owner.query(
    `insert into messages (tenant_id, conversation_id, author, body, language) values
     ($1, $2, 'visitor', 'Do you have pandan cake?', 'en'), ($1, $2, 'agent', 'Yes, every day.', 'en')`,
    [t, conv!.id],
  );
  return { id: conv!.id, visitorId };
}
const telegramLink = async (c: { id: string; visitorId: string }) => {
  const r = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    requestHandoff(tx, {
      tenantId: TENANT_A,
      conversationId: c.id,
      visitorId: c.visitorId,
      body: { channel: 'telegram' },
      secret: HANDOFF_SECRET,
    }),
  );
  if (!r.ok || r.channel !== 'telegram') throw new Error(JSON.stringify(r));
  return { code: new URL(r.url).searchParams.get('start')!, linkId: r.linkId };
};

const user = (id: number) => ({
  id,
  is_bot: false,
  first_name: 'Mei',
  last_name: 'Tan',
  username: `mei${id}`,
  language_code: 'en',
});
const update = (chat: number, type: 'private' | 'group', text: string) => ({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    from: user(chat),
    chat: type === 'private' ? { id: chat, type } : { id: -chat, type, title: 'Family' },
    date: Math.floor(Date.now() / 1000),
    text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: 6 }] } : {}),
  },
});
const hook = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: `/hooks/telegram/${connectionId}`,
    headers: { 'x-telegram-bot-api-secret-token': HOOK_SECRET },
    payload: body as Record<string, unknown>,
  });
const serviceTexts = async (chat: number) =>
  (
    await q<{ payload: { text: string; leave?: boolean } }>(
      `select payload from outbox where topic = 'channel-send' and payload->>'type' = 'service'
       and group_key = $1 order by created_at`,
      [`tg:${chat}`],
    )
  ).map((r) => r.payload);

let chat: number;
beforeEach(() => {
  chat = ++chatSeq;
  published.length = 0;
});

describe('Telegram redemption (FEAT-038 §5.3; AC-3–AC-5)', () => {
  it('a valid /start moves the same conversation, verifies the Telegram ID and delivers the recap', async () => {
    const c = await widgetChat();
    const { code, linkId } = await telegramLink(c);
    expect((await hook(update(chat, 'private', `/start ${code}`))).statusCode).toBe(200);

    const [conv] = await q<{ channel: string; contact_id: string }>(
      `select channel, contact_id from conversations where id = $1`,
      [c.id],
    );
    expect(conv!.channel).toBe('telegram');
    const ids = await q(
      `select kind, value, source, verified_at is not null as verified from contact_identities where contact_id = $1`,
      [conv!.contact_id],
    );
    expect(ids).toEqual([
      { kind: 'telegram', value: String(chat), source: 'link', verified: true },
    ]);
    const [tchat] = await q(
      `select contact_id, conversation_id from telegram_chats where chat_id = $1`,
      [chat],
    );
    expect(tchat).toEqual({ contact_id: conv!.contact_id, conversation_id: c.id });
    const [link] = await q(
      `select used_at is not null as used, used_chat_id from handoff_links where id = $1`,
      [linkId],
    );
    expect(link).toEqual({ used: true, used_chat_id: String(chat) });

    const msgs = await q<{ id: string; notice_kind: string | null; notice: string | null }>(
      `select id, notice_kind, notice from messages where conversation_id = $1 order by seq`,
      [c.id],
    );
    expect(msgs.map((m) => m.notice_kind)).toEqual([null, null, 'handoff_moved', 'handoff_recap']);
    const recap = msgs[3]!;
    expect(recap.notice).toContain('You: Do you have pandan cake?');
    const deliveries = await q<{ message_id: string }>(
      `select message_id from message_deliveries where conversation_id = $1`,
      [c.id],
    );
    expect(deliveries).toEqual([{ message_id: recap.id }]);
    const audits = await q<{ event_type: string }>(
      `select event_type from audit_entries where subject_refs @> array[$1]::text[] order by seq`,
      [`conversation:${c.id}`],
    );
    expect(audits.map((a) => a.event_type)).toEqual(
      expect.arrayContaining(['handoff.requested', 'conversation.moved', 'handoff.completed']),
    );
    expect(published.map((p) => p.payload.message?.noticeKind ?? p.payload.type)).toEqual([
      'handoff_moved',
      'handoff_recap',
      'conversation',
    ]);

    // The next Telegram message joins the same conversation.
    expect((await hook(update(chat, 'private', 'Can I collect at 5pm?'))).statusCode).toBe(200);
    const after = await q<{ body: string; conversation_id: string }>(
      `select body, conversation_id from messages where author = 'visitor' and body like 'Can I collect%'`,
    );
    expect(after).toEqual([{ body: 'Can I collect at 5pm?', conversation_id: c.id }]);
  });

  it('a contact already holding that Telegram ID is merged, the older one surviving', async () => {
    // The visitor messaged the bot before: an older Telegram contact.
    expect((await hook(update(chat, 'private', 'Hello'))).statusCode).toBe(200);
    const [older] = await q<{ id: string }>(
      `select contact_id as id from contact_identities where kind = 'telegram' and value = $1`,
      [String(chat)],
    );
    const c = await widgetChat();
    const { code } = await telegramLink(c);
    await hook(update(chat, 'private', `/start ${code}`));
    const [conv] = await q<{ contact_id: string; channel: string }>(
      `select contact_id, channel from conversations where id = $1`,
      [c.id],
    );
    expect(conv).toEqual({ contact_id: older!.id, channel: 'telegram' });
    const merges = await q(`select automatic from contact_merges where survivor_id = $1`, [
      older!.id,
    ]);
    expect(merges).toEqual([{ automatic: true }]);
  });

  it('expired, used, forged, other-tenant or moved links get the expired reply and change nothing (AC-4)', async () => {
    const c = await widgetChat();
    const { code, linkId } = await telegramLink(c);
    const forged = `${code.slice(0, -3)}${code.endsWith('AAA') ? 'BBB' : 'AAA'}`;
    const otherTenant = signHandoff(HANDOFF_SECRET, TENANT_B, linkId, 'telegram');
    const unknown = signHandoff(HANDOFF_SECRET, TENANT_A, randomUUID(), 'telegram');
    for (const bad of [forged, otherTenant, unknown]) {
      await hook(update(chat, 'private', `/start ${bad}`));
    }
    await owner.query(
      `update handoff_links set expires_at = now() - interval '1 second', created_at = now() - interval '1 hour' where id = $1`,
      [linkId],
    );
    await hook(update(chat, 'private', `/start ${code}`));
    const replies = await serviceTexts(chat);
    expect(replies.filter((r) => r.text.startsWith('This link has expired'))).toHaveLength(4);
    const [conv] = await q(`select channel from conversations where id = $1`, [c.id]);
    expect(conv).toEqual({ channel: 'widget' });
    expect(await q(`select 1 from contact_identities where value = $1`, [String(chat)])).toEqual(
      [],
    );
    expect(await q(`select 1 from telegram_chats where chat_id = $1`, [chat])).toEqual([]);

    // Used: a second /start of a redeemed link.
    const d = await widgetChat();
    const fresh = await telegramLink(d);
    await hook(update(chat, 'private', `/start ${fresh.code}`));
    const other = ++chatSeq;
    await hook(update(other, 'private', `/start ${fresh.code}`));
    expect((await serviceTexts(other))[0]!.text).toContain('This link has expired');
    expect(await q(`select 1 from contact_identities where value = $1`, [String(other)])).toEqual(
      [],
    );

    // A closed conversation's link.
    const e = await widgetChat();
    const closed = await telegramLink(e);
    await owner.query(
      `update conversations set status = 'closed', closed_at = now(), close_reason = 'visitor' where id = $1`,
      [e.id],
    );
    const third = ++chatSeq;
    await hook(update(third, 'private', `/start ${closed.code}`));
    expect((await serviceTexts(third))[0]!.text).toContain('This link has expired');
    const [ec] = await q(`select channel from conversations where id = $1`, [e.id]);
    expect(ec).toEqual({ channel: 'widget' });
  });

  it('a group /start gets the private-only reply and leaves; the link still works in private (AC-5)', async () => {
    const c = await widgetChat();
    const { code } = await telegramLink(c);
    await hook(update(chat, 'group', `/start ${code}`));
    const group = await q<{ payload: { text: string; leave?: boolean } }>(
      `select payload from outbox where topic = 'channel-send' and group_key = $1`,
      [`tg:${-chat}`],
    );
    expect(group.map((g) => g.payload)).toEqual([
      expect.objectContaining({
        leave: true,
        text: expect.stringContaining('I only answer private messages'),
      }),
    ]);
    const [still] = await q(`select used_at from handoff_links where conversation_id = $1`, [c.id]);
    expect(still).toEqual({ used_at: null });
    await hook(update(chat, 'private', `/start ${code}`));
    const [conv] = await q(`select channel from conversations where id = $1`, [c.id]);
    expect(conv).toEqual({ channel: 'telegram' });
  });
});

export { ORIGIN, signToken, VISITOR_SECRET };
