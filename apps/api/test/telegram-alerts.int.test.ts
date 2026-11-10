/**
 * Linking Telegram for alerts over HTTP (FEAT-037 §3, §5.5, D1; AC-6, AC-7): the link code,
 * the bot linking the chat, the member's own link state, Telegram preferences, the test alert
 * and unlinking.
 */
import { NotificationPrefs, TelegramLinkStart } from '@kaki/contracts';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { memoryRateLimiter } from '@kaki/platform';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

type App = Awaited<ReturnType<typeof buildApp>>;

let tdb: TestDatabase;
let owner: pg.Client;
let app: App;
let ownerA: string;
let ownerCookie: string;
let agentCookie: string;
let ownerBCookie: string;
let connectionId: string;

const BASE = '/api/v1/me/notifications';
const LINK = `${BASE}/telegram/link`;
const req = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  cookie: string,
  payload?: object,
) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const prefs = async (cookie = ownerCookie) =>
  NotificationPrefs.parse((await req('GET', BASE, cookie)).json());
const linkRow = async () =>
  (
    await owner.query<{ code_hash: Buffer | null; chat_id: string | null }>(
      `select code_hash, chat_id from telegram_alert_links where tenant_id = $1 and user_id = $2`,
      [TENANT_A, ownerA],
    )
  ).rows;
/** The member's `/start <code>` reaching the bot's webhook (the fake chat 4242). */
const start = (code: string, updateId: number) =>
  app.inject({
    method: 'POST',
    url: `/hooks/telegram/${connectionId}`,
    headers: { 'x-telegram-bot-api-secret-token': 's' },
    payload: {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: 4242, is_bot: false, first_name: 'Mei' },
        chat: { id: 4242, first_name: 'Mei', type: 'private' },
        date: 1763445900,
        text: `/start ${code}`,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    },
  });

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { rateLimiter: memoryRateLimiter() });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ownerA = (
    await owner.query<{ id: string }>(`select id from users where email = 'owner@kaki-bakery.test'`)
  ).rows[0]!.id;
  ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  ownerBCookie = await sessionCookie(tdb, 'owner@second-tenant.test');
  const agent = (
    await owner.query<{ id: string }>(
      `insert into users (email) values ('tg-agent@a.test') returning id`,
    )
  ).rows[0]!.id;
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    agent,
  ]);
  agentCookie = await sessionCookie(tdb, 'tg-agent@a.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('Telegram alert link (FEAT-037 D1; AC-6, AC-7)', () => {
  it('409 no_bot, and no Telegram column, while the business has no bot', async () => {
    const res = await req('POST', LINK, ownerCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'no_bot' });
    const p = await prefs();
    expect(p.channels).toEqual(['email']);
    expect(p.sendTo.telegram).toBeNull();
    expect(p.events[0]).toEqual({ event: 'escalation', email: true });
  });

  it('with a bot: a Telegram column, not linked; a link code for 15 minutes, hashed at rest', async () => {
    connectionId = (
      await owner.query<{ id: string }>(
        `insert into channel_connections (tenant_id, kind, state, offline_mode, health)
         values ($1, 'telegram', 'offline', 'hidden', 'ok') returning id`,
        [TENANT_A],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into telegram_settings (tenant_id, connection_id, bot_id, bot_username, bot_name,
         webhook_secret_hash) values ($1, $2, 810077, 'kaki_bot', 'Kaki', sha256('s'))`,
      [TENANT_A, connectionId],
    );
    const p = await prefs();
    expect(p.channels).toEqual(['email', 'telegram']);
    expect(p.events[0]).toEqual({ event: 'escalation', email: true, telegram: true });
    expect(p.sendTo.telegram).toEqual({ state: 'not_linked', name: null, linkedAt: null });

    const res = await req('POST', LINK, ownerCookie);
    expect(res.statusCode).toBe(201);
    const link = TelegramLinkStart.parse(res.json());
    const m = /^https:\/\/t\.me\/kaki_bot\?start=(link-[A-Za-z0-9_-]{22})$/.exec(link.url);
    expect(m).not.toBeNull();
    const ttl = new Date(link.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    const [row] = await linkRow();
    expect(row!.code_hash!.equals(createHash('sha256').update(m![1]!).digest())).toBe(true);
    expect((await prefs()).sendTo.telegram?.state).toBe('pending');

    // A new code replaces the older one.
    await req('POST', LINK, ownerCookie);
    const rows = await linkRow();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash!.equals(row!.code_hash!)).toBe(false);
  });

  it('the bot links the chat on `/start <code>`; an expired code does not', async () => {
    const codeOf = async () => {
      const r = TelegramLinkStart.parse((await req('POST', LINK, ownerCookie)).json());
      return new URL(r.url).searchParams.get('start')!;
    };
    const expired = await codeOf();
    await owner.query(
      `update telegram_alert_links set code_expires_at = now() - interval '1 minute'
       where tenant_id = $1 and user_id = $2`,
      [TENANT_A, ownerA],
    );
    expect((await start(expired, 7001)).statusCode).toBe(200);
    expect((await prefs()).sendTo.telegram?.state).toBe('not_linked');
    expect((await start(await codeOf(), 7002)).statusCode).toBe(200);
    expect((await linkRow())[0]).toMatchObject({ chat_id: '4242', code_hash: null });
  });

  it('linked: the name shows; each member sees only their own link', async () => {
    expect((await prefs()).sendTo.telegram).toMatchObject({ state: 'linked', name: 'Mei' });
    expect((await prefs(agentCookie)).sendTo.telegram?.state).toBe('not_linked');
    // Tenant B has no bot.
    expect((await prefs(ownerBCookie)).sendTo.telegram).toBeNull();
  });

  it('PUT sets Telegram separately; an event without `telegram` keeps it', async () => {
    const quietHours = { enabled: true, start: '22:00', end: '08:00' };
    let res = await req('PUT', BASE, ownerCookie, {
      events: [{ event: 'hot_lead', email: true, telegram: false }],
      quietHours,
    });
    expect(res.statusCode).toBe(200);
    res = await req('PUT', BASE, ownerCookie, {
      events: [{ event: 'hot_lead', email: false }],
      quietHours,
    });
    const hot = NotificationPrefs.parse(res.json()).events.find((e) => e.event === 'hot_lead');
    expect(hot).toEqual({ event: 'hot_lead', email: false, telegram: false });
  });

  it('the test alert goes to the linked Telegram too', async () => {
    const res = await req('POST', `${BASE}/test`, ownerCookie);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sentTo: 'owner@kaki-bakery.test', telegram: true });
    const { rows } = await owner.query<{ channel: string }>(
      `select channel from notifications where kind = 'test' and user_id = $1 order by channel`,
      [ownerA],
    );
    expect(rows.map((r) => r.channel)).toEqual(['email', 'telegram']);
  });

  it('DELETE unlinks; the bot says "Alerts stopped" in that chat', async () => {
    const res = await req('DELETE', `${BASE}/telegram`, ownerCookie);
    expect(res.statusCode).toBe(204);
    expect(await linkRow()).toHaveLength(0);
    expect((await prefs()).sendTo.telegram?.state).toBe('not_linked');
    const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
      `select payload from outbox where topic = 'channel-send' and group_key = 'tg:4242'
         and payload->>'text' like 'Alerts stopped%'`,
    );
    expect(rows.map((r) => r.payload)).toEqual([
      expect.objectContaining({ type: 'service', connectionId, chatId: 4242 }),
    ]);
    // Unlinking again is a no-op.
    expect((await req('DELETE', `${BASE}/telegram`, ownerCookie)).statusCode).toBe(204);
  });
});
