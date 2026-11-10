/**
 * The Telegram setup routes over HTTP (FEAT-037 §3, §5.2; AC-1, AC-5, AC-7): connect, replace,
 * disconnect, "Check again" and who may use them, against the fake Bot API.
 */
import { fakeBotApi, fixtureToken } from '@kaki/channels/telegram-fake';
import { TelegramChannelResponse } from '@kaki/contracts';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

type App = Awaited<ReturnType<typeof buildApp>>;

let tdb: TestDatabase;
let owner: pg.Client;
let app: App;
let ownerCookie: string;
let agentCookie: string;
let ownerBCookie: string;
const fake = fakeBotApi();
const URL = '/api/v1/channels/telegram';
const BOT = 820001;
const req = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  cookie: string,
  payload?: object,
) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const view = async (cookie = ownerCookie) =>
  TelegramChannelResponse.parse((await req('GET', URL, cookie)).json());

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { telegram: { api: { base: fake.base, fetch: fake.fetch } } });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ownerCookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  ownerBCookie = await sessionCookie(tdb, 'owner@second-tenant.test');
  const agent = (
    await owner.query<{ id: string }>(
      `insert into users (email) values ('tg-staff@a.test') returning id`,
    )
  ).rows[0]!.id;
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    agent,
  ]);
  agentCookie = await sessionCookie(tdb, 'tg-staff@a.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('Telegram setup routes (FEAT-037 §3)', () => {
  it('Owners and Admins only; staff get 403 and no session 401', async () => {
    expect((await req('GET', URL, agentCookie)).statusCode).toBe(403);
    expect((await req('POST', URL, agentCookie, { token: fixtureToken(BOT) })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
    expect(await view()).toMatchObject({ connected: false, connection: null, bot: null });
  });

  it('422 invalid_format and token_rejected; 422 invalid_body for a bad version', async () => {
    let res = await req('POST', URL, ownerCookie, { token: 'nope' });
    expect([res.statusCode, res.json().error]).toEqual([422, 'invalid_format']);
    fake.revoke(fixtureToken(BOT, 'z'));
    res = await req('POST', URL, ownerCookie, { token: fixtureToken(BOT, 'z') });
    expect([res.statusCode, res.json().error]).toEqual([422, 'token_rejected']);
    res = await req('PUT', `${URL}/token`, ownerCookie, {
      token: fixtureToken(BOT),
      settingsVersion: 'x',
    });
    expect([res.statusCode, res.json().error]).toEqual([422, 'invalid_body']);
  });

  it('201 connects offline and hidden with the webhook on the hook URL; 409 already_connected', async () => {
    const res = await req('POST', URL, ownerCookie, { token: fixtureToken(BOT) });
    expect(res.statusCode).toBe(201);
    const v = TelegramChannelResponse.parse(res.json());
    expect(v).toMatchObject({
      connected: true,
      connection: { state: 'offline' },
      bot: { id: String(BOT), link: expect.stringMatching(/^https:\/\/t\.me\//) },
    });
    expect(fake.webhooks.get(BOT)?.url).toMatch(new RegExp(`/hooks/telegram/${v.connection!.id}$`));
    // The token never comes back.
    expect(JSON.stringify(v)).not.toContain('fixture');
    const again = await req('POST', URL, ownerCookie, { token: fixtureToken(BOT, 'b') });
    expect([again.statusCode, again.json().error]).toEqual([409, 'already_connected']);
    // Another business can't connect the same bot.
    const b = await req('POST', URL, ownerBCookie, { token: fixtureToken(BOT, 'c') });
    expect([b.statusCode, b.json().error]).toEqual([409, 'bot_in_use']);
  });

  it('replace: 422 different_bot, 409 stale, 200 for a new token of the same bot', async () => {
    const v = await view();
    let res = await req('PUT', `${URL}/token`, ownerCookie, {
      token: fixtureToken(BOT + 1),
      settingsVersion: v.settingsVersion,
    });
    expect([res.statusCode, res.json().error]).toEqual([422, 'different_bot']);
    res = await req('PUT', `${URL}/token`, ownerCookie, {
      token: fixtureToken(BOT, 'b'),
      settingsVersion: v.settingsVersion - 1,
    });
    expect([res.statusCode, res.json().error]).toEqual([409, 'stale']);
    res = await req('PUT', `${URL}/token`, ownerCookie, {
      token: fixtureToken(BOT, 'b'),
      settingsVersion: v.settingsVersion,
    });
    expect(res.statusCode).toBe(200);
    expect(TelegramChannelResponse.parse(res.json()).settingsVersion).toBe(v.settingsVersion + 1);
  });

  it('Check again on the Channels page: a revoked token is degraded, credential_revoked', async () => {
    const v = await view();
    fake.revoke(fixtureToken(BOT, 'b'));
    await owner.query(`update channel_connections set health_checked_at = null where id = $1`, [
      v.connection!.id,
    ]);
    const res = await req('POST', `/api/v1/channels/${v.connection!.id}/check`, ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ health: 'degraded', healthReason: 'credential_revoked' });
  });

  it('the Channels page lists Telegram', async () => {
    const res = await req('GET', '/api/v1/channels', ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain('"telegram"');
  });

  it('disconnect: 409 stale, then 200 not connected and the webhook removed', async () => {
    const v = await view();
    let res = await req('DELETE', URL, ownerCookie, { settingsVersion: v.settingsVersion + 5 });
    expect([res.statusCode, res.json().error]).toEqual([409, 'stale']);
    res = await req('DELETE', URL, ownerCookie, { settingsVersion: v.settingsVersion });
    expect(res.statusCode).toBe(200);
    expect(TelegramChannelResponse.parse(res.json())).toMatchObject({ connected: false });
    const again = await req('DELETE', URL, ownerCookie, { settingsVersion: 1 });
    expect([again.statusCode, again.json().error]).toEqual([409, 'not_connected']);
  });
});
