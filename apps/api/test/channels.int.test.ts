/**
 * Channels (ONB-10, CHN-12; FEAT-034 §3, §5.4; AC-2–AC-5, AC-7, AC-8): the dashboard routes,
 * the widget config's availability and the 409 on a new conversation while offline.
 */
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asAgent: string;
let widgetA: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb);
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const staff = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    staff.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  const { rows } = await owner.query(
    `select id from channel_connections where tenant_id = $1 and kind = 'widget'`,
    [TENANT_A],
  );
  widgetA = rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`update tenants set allowed_origins = '{http://localhost:5175}'`);
  await owner.query(
    `update channel_connections set state = 'live', offline_mode = 'hidden',
       offline_message_en = null, offline_message_zh = null`,
  );
});

const call = (method: 'GET' | 'PUT' | 'POST', url: string, who: string | null, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: who ? { cookie: who } : {},
    ...(payload !== undefined ? { payload: payload as string } : {}),
  });

const list = async (who = asA) => (await call('GET', '/api/v1/channels', who)).json();
const version = async () => (await list()).channels[0].version as number;
const lastAudit = async () =>
  (
    await owner.query(
      `select event_type, payload from audit_entries where tenant_id = $1 order by seq desc limit 1`,
      [TENANT_A],
    )
  ).rows[0];

describe('GET /api/v1/channels', () => {
  it('lists the widget with its defaults, nothing to connect, and no credential fields', async () => {
    const res = await call('GET', '/api/v1/channels', asA);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connectable).toEqual([]);
    expect(body.channels).toEqual([
      expect.objectContaining({
        id: widgetA,
        kind: 'widget',
        name: 'Website chat widget',
        state: 'live',
        health: 'ok',
        checksHealth: false,
        offlineModes: ['hidden', 'message'],
        offline: {
          mode: 'hidden',
          message: { en: null, zh: null },
          defaults: {
            en: "Our chat isn't open yet. Please contact us directly for now.",
            zh: '我们的在线聊天尚未开放，请先直接联系我们。',
          },
        },
      }),
    ]);
    expect(res.body).not.toContain('credential');
  });

  it('refuses no session (401) and an Agent (403) on every route', async () => {
    const routes: ['GET' | 'POST' | 'PUT', string, unknown?][] = [
      ['GET', '/api/v1/channels'],
      ['POST', `/api/v1/channels/${widgetA}/live`, { version: 1 }],
      ['POST', `/api/v1/channels/${widgetA}/offline`, { version: 1 }],
      [
        'PUT',
        `/api/v1/channels/${widgetA}/offline-settings`,
        { mode: 'message', message: { en: null, zh: null }, version: 1 },
      ],
      ['POST', `/api/v1/channels/${widgetA}/check`],
    ];
    for (const [m, url, body] of routes) {
      expect((await call(m, url, null, body)).statusCode, url).toBe(401);
      expect((await call(m, url, asAgent, body)).statusCode, url).toBe(403);
    }
  });
});

describe('go live and go offline (AC-2)', () => {
  it('round-trips with one audit entry each, kind and ID only', async () => {
    const v = await version();
    const off = await call('POST', `/api/v1/channels/${widgetA}/offline`, asA, { version: v });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ state: 'offline', version: v + 1 });
    expect(await lastAudit()).toEqual({
      event_type: 'channel.offline',
      payload: { kind: 'widget', connectionId: widgetA },
    });
    const again = await call('POST', `/api/v1/channels/${widgetA}/offline`, asA, {
      version: v + 1,
    });
    expect(again.json().version).toBe(v + 1);
    expect((await lastAudit()).event_type).toBe('channel.offline');
    const live = await call('POST', `/api/v1/channels/${widgetA}/live`, asA, { version: v + 1 });
    expect(live.json()).toMatchObject({ state: 'live', version: v + 2 });
    expect((await lastAudit()).event_type).toBe('channel.live');
  });

  it("409 on a stale version; 404 for tenant A's ID from B's session and for a bad ID", async () => {
    const v = await version();
    const stale = await call('POST', `/api/v1/channels/${widgetA}/offline`, asA, {
      version: v + 3,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('version_conflict');
    const b = await call('POST', `/api/v1/channels/${widgetA}/offline`, asB, { version: v });
    expect(b.statusCode).toBe(404);
    expect(
      (await call('POST', '/api/v1/channels/nope/offline', asA, { version: 1 })).statusCode,
    ).toBe(404);
    expect((await list()).channels[0].state).toBe('live');
  });
});

describe('offline settings (AC-5)', () => {
  it('saves trimmed text and refuses bad bodies with field errors', async () => {
    const v = await version();
    const url = `/api/v1/channels/${widgetA}/offline-settings`;
    const ok = await call('PUT', url, asA, {
      mode: 'message',
      message: { en: '  Opening 1 Nov.  ', zh: null },
      version: v,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().offline).toMatchObject({
      mode: 'message',
      message: { en: 'Opening 1 Nov.', zh: null },
    });
    const long = await call('PUT', url, asA, {
      mode: 'message',
      message: { en: 'x'.repeat(301), zh: null },
      version: v + 1,
    });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({
      error: 'invalid_body',
      fields: { 'message.en': 'max_300' },
    });
    const mode = await call('PUT', url, asA, {
      mode: 'shown',
      message: { en: null, zh: null },
      version: v + 1,
    });
    expect(mode.statusCode).toBe(400);
    expect(mode.json().fields).toHaveProperty('mode');
  });

  it('check now is 400 no_health_check for the widget', async () => {
    const res = await call('POST', `/api/v1/channels/${widgetA}/check`, asA);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_health_check');
  });
});

describe('the widget while offline (AC-3, AC-4)', () => {
  const config = () =>
    app.inject({
      method: 'GET',
      url: '/widget/v1/config?key=wk_dev_bakery',
      headers: { origin: 'http://localhost:5175' },
    });

  it('config says live for the seed, then hidden or a message with contacts once offline', async () => {
    expect((await config()).json().availability).toEqual({ live: true });
    const v = await version();
    await call('POST', `/api/v1/channels/${widgetA}/offline`, asA, { version: v });
    await owner.query(`update widget_settings set install_seen_at = null`);
    const hidden = await config();
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().token).toBeTruthy();
    expect(hidden.json().availability).toMatchObject({ live: false, mode: 'hidden' });
    const seen = await owner.query(
      `select install_seen_at from widget_settings where tenant_id = $1`,
      [TENANT_A],
    );
    expect(seen.rows[0].install_seen_at).not.toBeNull();
    await call('PUT', `/api/v1/channels/${widgetA}/offline-settings`, asA, {
      mode: 'message',
      message: { en: null, zh: '下月开张' },
      version: v + 1,
    });
    const shown = (await config()).json();
    expect(shown.availability).toEqual({
      live: false,
      mode: 'message',
      message: {
        en: "Our chat isn't open yet. Please contact us directly for now.",
        zh: '下月开张',
      },
      contact: { email: 'hello@kaki-bakery.test', phone: expect.any(String) },
    });
    expect(JSON.stringify(shown)).not.toContain('credential');
  });

  it('a new conversation is 409 not_live while offline', async () => {
    const { token } = (await config()).json();
    const start = () =>
      app.inject({
        method: 'POST',
        url: '/widget/v1/conversations',
        headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:5175' },
      });
    expect((await start()).statusCode).toBe(201);
    await owner.query(`update channel_connections set state = 'offline' where tenant_id = $1`, [
      TENANT_A,
    ]);
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_live');
  });
});
