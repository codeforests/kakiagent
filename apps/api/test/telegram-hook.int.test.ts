/**
 * The Telegram webhook (CHN-05, CHN-01, NFR-17; FEAT-037 §5.3; AC-2–AC-4, AC-7): the generic
 * `/hooks/:kind/:connectionId` route, the secret header, idempotency, groups, unsupported
 * messages, `/start`, contacts and conversations.
 */
import { createHash } from 'node:crypto';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let connectionId: string;
const SECRET = 'the-webhook-secret-for-tenant-a';
const BOT = 920001;
let updateId = 5000;
let chatSeq = 7_000_000;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
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
    [TENANT_A, connectionId, BOT, createHash('sha256').update(SECRET).digest()],
  );
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const user = (id: number) => ({
  id,
  is_bot: false,
  first_name: 'Mei',
  last_name: 'Tan',
  username: `mei${id}`,
  language_code: 'en',
});
const privateMessage = (chat: number, fields: Record<string, unknown>) => ({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    from: user(chat),
    chat: { id: chat, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    ...fields,
  },
});
const post = (body: unknown, opts: { secret?: string | null; id?: string; kind?: string } = {}) =>
  app.inject({
    method: 'POST',
    url: `/hooks/${opts.kind ?? 'telegram'}/${opts.id ?? connectionId}`,
    headers:
      opts.secret === null ? {} : { 'x-telegram-bot-api-secret-token': opts.secret ?? SECRET },
    payload: body as Record<string, unknown>,
  });
const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await owner.query<T>(text, values)).rows;
const conversationsOf = (chat: number) =>
  q<{ id: string; contact_id: string; status: string; channel: string }>(
    `select c.id, c.contact_id, c.status, c.channel from conversations c
     join contacts k on k.tenant_id = c.tenant_id and k.id = c.contact_id
     where k.telegram_id = $1 order by c.created_at`,
    [chat],
  );
const messagesOf = (conversationId: string) =>
  q<{ author: string; body: string; notice_kind: string | null }>(
    `select author, body, notice_kind from messages where conversation_id = $1 order by seq`,
    [conversationId],
  );
const turnJobs = (conversationId: string) =>
  q(`select 1 from outbox where topic = 'conversation-turns' and group_key = $1`, [conversationId]);
const serviceJobs = (chat: number) =>
  q<{ payload: { type: string; text: string; leave?: boolean; chatId: number } }>(
    `select payload from outbox where topic = 'channel-send' and group_key = $1 order by created_at`,
    [`tg:${chat}`],
  );

let chat: number;
beforeEach(() => {
  chat = ++chatSeq;
});

describe('Telegram webhook (FEAT-037 §5.3)', () => {
  it('a private text creates the conversation, contact and turn job; a redelivery creates nothing; a second message joins', async () => {
    const first = privateMessage(chat, { text: 'Do you deliver to Tampines? NRIC S1234567D' });
    expect((await post(first)).statusCode).toBe(200);
    const [conv] = await conversationsOf(chat);
    expect(conv).toMatchObject({ channel: 'telegram', status: 'ai' });
    const [contact] = await q<{ name: string; telegram_username: string }>(
      `select name, telegram_username from contacts where id = $1`,
      [conv!.contact_id],
    );
    expect(contact).toEqual({ name: 'Mei Tan', telegram_username: `mei${chat}` });
    const msgs = await messagesOf(conv!.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain('Do you deliver to Tampines?');
    expect(msgs[0]!.body).not.toContain('S1234567D');
    expect(await turnJobs(conv!.id)).toHaveLength(1);
    const [tchat] = await q(
      `select bot_id, conversation_id from telegram_chats where chat_id = $1`,
      [chat],
    );
    expect(tchat).toEqual({ bot_id: String(BOT), conversation_id: conv!.id });

    expect((await post(first)).statusCode).toBe(200);
    expect(await messagesOf(conv!.id)).toHaveLength(1);
    expect(await turnJobs(conv!.id)).toHaveLength(1);

    await post(privateMessage(chat, { text: 'And on Sunday?' }));
    expect(await conversationsOf(chat)).toHaveLength(1);
    expect(await messagesOf(conv!.id)).toHaveLength(2);
    const [settings] = await q<{ last_received_at: Date | null }>(
      `select last_received_at from telegram_settings where tenant_id = $1`,
      [TENANT_A],
    );
    expect(settings!.last_received_at).toBeInstanceOf(Date);
  });

  it('8 days after a close starts a new conversation with the same contact', async () => {
    await post(privateMessage(chat, { text: 'Hello' }));
    const [conv] = await conversationsOf(chat);
    await owner.query(
      `update conversations set status = 'closed', close_reason = 'inactive', closed_at = now() - interval '8 days' where id = $1`,
      [conv!.id],
    );
    await post(privateMessage(chat, { text: 'Hello again' }));
    const both = await conversationsOf(chat);
    expect(both).toHaveLength(2);
    expect(both[1]!.contact_id).toBe(conv!.contact_id);
    expect(both[1]!.id).not.toBe(conv!.id);
  });

  it('a group message and being added to a group get one reply and a leave each, and no conversation', async () => {
    const group = -++chatSeq;
    const groupMessage = {
      update_id: ++updateId,
      message: {
        message_id: 1,
        from: user(chat),
        chat: { id: group, type: 'group' },
        date: 1,
        text: 'hi bot',
      },
    };
    expect((await post(groupMessage)).statusCode).toBe(200);
    const added = {
      update_id: ++updateId,
      my_chat_member: {
        chat: { id: group, type: 'supergroup' },
        from: user(chat),
        date: 1,
        old_chat_member: { status: 'left' },
        new_chat_member: { status: 'member' },
      },
    };
    expect((await post(added)).statusCode).toBe(200);
    const jobs = await serviceJobs(group);
    expect(jobs).toHaveLength(2);
    for (const j of jobs)
      expect(j.payload).toMatchObject({
        type: 'service',
        chatId: group,
        leave: true,
        text: 'I only answer private messages. Message me here: https://t.me/kaki_bakery_bot',
      });
    expect(await conversationsOf(chat)).toEqual([]);
    const [ignored] = await q<{ n: number }>(
      `select count(*)::int as n from inbound_events where connection_id = $1 and ignore_reason = 'group'`,
      [connectionId],
    );
    expect(ignored!.n).toBeGreaterThanOrEqual(2);
  });

  it('a sticker is "[Sticker]" with no turn and one text-only notice in 24 hours', async () => {
    const sticker = () => privateMessage(chat, { sticker: { file_id: 'x', file_unique_id: 'y' } });
    await post(sticker());
    await post(privateMessage(chat, { voice: { file_id: 'v', file_unique_id: 'w', duration: 1 } }));
    const [conv] = await conversationsOf(chat);
    const msgs = await messagesOf(conv!.id);
    expect(msgs.filter((m) => m.author === 'visitor').map((m) => m.body)).toEqual([
      '[Sticker]',
      '[Voice message]',
    ]);
    expect(msgs.filter((m) => m.notice_kind === 'text_only')).toHaveLength(1);
    expect(await turnJobs(conv!.id)).toEqual([]);
    // The notice goes out through the delivery trigger like any system message.
    const [delivery] = await q<{ n: number }>(
      `select count(*)::int as n from message_deliveries where conversation_id = $1`,
      [conv!.id],
    );
    expect(delivery!.n).toBe(1);
  });

  it('/start queues the greeting and creates no conversation', async () => {
    await post(privateMessage(chat, { text: '/start' }));
    expect(await conversationsOf(chat)).toEqual([]);
    const jobs = await serviceJobs(chat);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.text).toMatch(/AI/);
    expect(jobs[0]!.payload.leave).toBeUndefined();
  });

  it('a wrong or missing secret is 401 and an unknown connection or kind 404, storing nothing', async () => {
    const before = await q<{ n: number }>(`select count(*)::int as n from inbound_events`);
    const body = privateMessage(chat, { text: 'Hello' });
    expect((await post(body, { secret: 'guess' })).statusCode).toBe(401);
    expect((await post(body, { secret: null })).statusCode).toBe(401);
    expect((await post(body, { id: '00000000-0000-4000-8000-000000000099' })).statusCode).toBe(404);
    expect((await post(body, { kind: 'email' })).statusCode).toBe(404);
    expect((await post(body, { id: 'not-a-uuid' })).statusCode).toBe(404);
    expect(await q<{ n: number }>(`select count(*)::int as n from inbound_events`)).toEqual(before);
    expect(await conversationsOf(chat)).toEqual([]);
  });

  it('no name or text outside contacts and messages (ADR-015)', async () => {
    await post(privateMessage(chat, { text: 'Secret cake order for Ah Kow' }));
    const dump = JSON.stringify(
      await q(
        `select (select json_agg(e) from inbound_events e) as events,
                (select json_agg(t) from telegram_chats t) as chats,
                (select json_agg(o.payload) from outbox o where o.topic <> 'channel-send') as jobs,
                (select json_agg(a.payload) from audit_entries a) as audits`,
      ),
    );
    expect(dump).not.toContain('Ah Kow');
    expect(dump).not.toContain('Mei Tan');
  });
});
