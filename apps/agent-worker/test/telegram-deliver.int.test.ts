/**
 * Outbound delivery on Telegram (CHN-05, CHN-12, NFR-17; FEAT-037 §5.3 step 3, §5.4; AC-2,
 * AC-4, AC-5) against real Postgres with a fake Bot API: replies, notices, blocks, a revoked
 * token, Telegram's 429, and service replies.
 */
import { randomBytes } from 'node:crypto';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { requestEscalation } from '@kaki/inbox';
import { localSealer } from '@kaki/platform/secrets';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deliverMessage,
  sealTelegram,
  sendServiceJob,
  ServiceRetryError,
  telegramSender,
  type DeliverDeps,
} from '@kaki/channels';
import { fakeBotApi, fixtureToken } from '@kaki/channels/telegram-fake';

const BOT = 930001;
const PRIVACY = 'Kaki Bakery · Privacy notice: https://kakibakery.test/privacy';
let tdb: TestDatabase;
let owner: pg.Client;
let deps: DeliverDeps;
let connectionId: string;
const sealer = localSealer(randomBytes(32));
const fake = fakeBotApi();
const api = { base: fake.base, fetch: fake.fetch };
let chatSeq = 8_000_000;

async function seal(token: string) {
  const s = await sealTelegram(sealer, connectionId, { token, webhookSecret: 'secret' });
  await owner.query(
    `update channel_connections set credential_ciphertext = $2, credential_key_ref = $3, health = 'ok', health_reason = null, degraded_since = null where id = $1`,
    [connectionId, Buffer.from(s.ciphertext), s.keyRef],
  );
}

/** A Telegram conversation with its contact and chat, as receive leaves it. */
async function chat() {
  const chatId = ++chatSeq;
  const contact = (
    await owner.query<{ id: string }>(
      `insert into contacts (tenant_id, name, telegram_id) values ($1, 'Mei', $2) returning id`,
      [TENANT_A, chatId],
    )
  ).rows[0]!.id;
  const conv = (
    await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id, contact_id) values ($1, 'telegram', gen_random_uuid(), $2) returning id`,
      [TENANT_A, contact],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into telegram_chats (tenant_id, chat_id, bot_id, contact_id, conversation_id) values ($1, $2, $3, $4, $5)`,
    [TENANT_A, chatId, BOT, contact, conv],
  );
  return { conv, chatId };
}

async function message(
  conv: string,
  author: 'agent' | 'staff' | 'system',
  body: string,
  extra: { disclosure?: string; notice?: [string, string] } = {},
) {
  const { rows } = await owner.query<{ id: string }>(
    `insert into messages (tenant_id, conversation_id, author, body, disclosure, notice, notice_kind)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      TENANT_A,
      conv,
      author,
      body,
      extra.disclosure ?? null,
      extra.notice?.[1] ?? null,
      extra.notice?.[0] ?? null,
    ],
  );
  return rows[0]!.id;
}
const delivery = async (messageId: string) =>
  (
    await owner.query(
      `select status, failed_reason, attempts, next_attempt_at from message_deliveries where message_id = $1`,
      [messageId],
    )
  ).rows[0];
const escalations = async (conv: string) =>
  (await owner.query(`select source from escalations where conversation_id = $1`, [conv])).rows.map(
    (r) => r.source,
  );
const health = async () =>
  (
    await owner.query(`select health, health_reason from channel_connections where id = $1`, [
      connectionId,
    ])
  ).rows[0];
const sentTo = (chatId: number) =>
  fake.sent.filter((s) => s.chatId === chatId).map((s) => s.text ?? s.method);
const deliver = (messageId: string) => deliverMessage(deps, { tenantId: TENANT_A, messageId });

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  connectionId = (
    await owner.query<{ id: string }>(
      `insert into channel_connections (tenant_id, kind, state, offline_mode, health)
       values ($1, 'telegram', 'live', 'hidden', 'ok') returning id`,
      [TENANT_A],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into telegram_settings (tenant_id, connection_id, bot_id, bot_username, bot_name, webhook_secret_hash)
     values ($1, $2, $3, 'kaki_bot', 'Kaki', $4)`,
    [TENANT_A, connectionId, BOT, Buffer.alloc(32, 1)],
  );
  deps = {
    zdb: tdb.zone('visitor'),
    senders: { telegram: telegramSender({ sealer, api }) },
    footer: async () => ({
      businessName: 'Kaki Bakery',
      privacyUrl: 'https://kakibakery.test/privacy',
    }),
    escalate: async (tx, tenantId, conversationId, source) => {
      await requestEscalation(tx, { tenantId, conversationId, source, hours: null });
    },
  };
});
beforeEach(async () => {
  await seal(fixtureToken(BOT));
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('deliverMessage on Telegram (FEAT-037 §5.4)', () => {
  it('sends the first AI reply with the disclosure and the privacy line, the next without; a staff reply; not staff_joined; once per job', async () => {
    const { conv, chatId } = await chat();
    const first = await message(conv, 'agent', 'Yes, we deliver.', {
      disclosure: "I'm Kaki Bakery's AI assistant.",
    });
    expect((await deliver(first)).outcome).toBe('sent');
    const second = await message(conv, 'agent', 'Delivery is $5.');
    await deliver(second);
    const staff = await message(conv, 'staff', 'Hi Mei, Ah Kow here.');
    await deliver(staff);
    const joined = await message(conv, 'system', '', {
      notice: ['staff_joined', 'Ah Kow joined the chat'],
    });
    expect((await deliver(joined)).outcome).toBe('not_sent');
    expect(sentTo(chatId)).toEqual([
      `I'm Kaki Bakery's AI assistant.\n\nYes, we deliver.\n\n${PRIVACY}`,
      'Delivery is $5.',
      'Hi Mei, Ah Kow here.',
    ]);
    expect((await deliver(first)).outcome).toBe('already_done');
    expect(sentTo(chatId)).toHaveLength(3);
    expect(await delivery(first)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('a customer who blocked the bot: failed/blocked and one delivery_failed escalation', async () => {
    const { conv, chatId } = await chat();
    fake.blocked.add(chatId);
    const m = await message(conv, 'agent', 'Your order is ready.');
    expect((await deliver(m)).outcome).toBe('failed');
    expect(await delivery(m)).toMatchObject({ status: 'failed', failed_reason: 'blocked' });
    expect(await escalations(conv)).toEqual(['delivery_failed']);
    const [c] = (
      await owner.query(`select blocked_at from telegram_chats where chat_id = $1`, [chatId])
    ).rows;
    expect(c.blocked_at).toBeInstanceOf(Date);
    // The next one fails at once, without a call.
    const calls = fake.calls.length;
    const again = await message(conv, 'agent', 'Still there?');
    await deliver(again);
    expect(fake.calls.length).toBe(calls);
    expect(await delivery(again)).toMatchObject({ failed_reason: 'blocked' });
  });

  it('a bot disconnected since the reply was queued: failed/rejected, and the channel is not degraded', async () => {
    const { conv, chatId } = await chat();
    // disconnectTelegram clears the credential and resets health.
    await owner.query(
      `update channel_connections set credential_ciphertext = null, credential_key_ref = null, health = 'unknown' where id = $1`,
      [connectionId],
    );
    const m = await message(conv, 'agent', 'Your cake is ready.');
    expect((await deliver(m)).outcome).toBe('failed');
    expect(await delivery(m)).toMatchObject({ status: 'failed', failed_reason: 'rejected' });
    expect(await escalations(conv)).toEqual(['delivery_failed']);
    expect(await health()).toEqual({ health: 'unknown', health_reason: null });
    expect(sentTo(chatId)).toEqual([]);
  });

  it('a revoked token degrades the channel and the reply is retried; a 429 waits as asked', async () => {
    const { conv } = await chat();
    await seal(`${BOT}:revokedxxxxxxxxxxxxxxxxxxxxxxxxxxxx`);
    const m = await message(conv, 'agent', 'Hello');
    expect((await deliver(m)).outcome).toBe('retry');
    expect(await health()).toEqual({ health: 'degraded', health_reason: 'send_rejected' });
    expect(await delivery(m)).toMatchObject({ status: 'pending', attempts: 1 });
    const alerts = await owner.query(
      `select count(*)::int as n from notifications where kind = 'channel_degraded' and subject_id = $1`,
      [connectionId],
    );
    expect(alerts.rows[0].n).toBeGreaterThan(0);

    await seal(fixtureToken(BOT));
    const n = await message(conv, 'agent', 'Hello again');
    fake.failNext('sendMessage', 429, 'Too Many Requests: retry after 600', 600);
    const before = Date.now();
    expect((await deliver(n)).outcome).toBe('retry');
    const d = await delivery(n);
    expect(d.next_attempt_at.getTime() - before).toBeGreaterThanOrEqual(599_000);
  });
});

describe('service replies (FEAT-037 §5.3 step 3)', () => {
  const job = (chatId: number, extra: Record<string, unknown> = {}) => ({
    type: 'service' as const,
    tenantId: TENANT_A,
    connectionId,
    chatId,
    text: 'I only answer private messages.',
    queuedAt: new Date().toISOString(),
    ...extra,
  });
  const svc = { zdb: () => tdb.zone('visitor'), sealer, api };
  const send = (j: ReturnType<typeof job>) => sendServiceJob({ zdb: svc.zdb(), sealer, api }, j);

  it('sends the text and leaves a group', async () => {
    const group = -++chatSeq;
    expect(await send(job(group, { leave: true }))).toBe('sent');
    expect(sentTo(group)).toEqual(['I only answer private messages.', 'leaveChat']);
  });

  it('a transient failure is retried until 24 hours after queueing, then dropped; a permanent one is dropped', async () => {
    const chatId = ++chatSeq;
    fake.failNext('sendMessage', 502);
    await expect(send(job(chatId))).rejects.toBeInstanceOf(ServiceRetryError);
    fake.failNext('sendMessage', 502);
    expect(
      await send(job(chatId, { queuedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() })),
    ).toBe('dropped');
    fake.blocked.add(chatId);
    expect(await send(job(chatId))).toBe('dropped');
  });
});
