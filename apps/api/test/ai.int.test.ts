/**
 * Kill switch (GOV-08, UC-31; FEAT-057 §3, §5.4; AC-1, AC-4, AC-5, AC-7): the status and
 * pause/resume routes, the `ai_status` nudge, and the widget config while paused.
 */
import type { RealtimeEvent } from '@kaki/contracts';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

const DEFAULT_FALLBACK_EN = expect.stringMatching(/\S/);

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asAdmin: string;
let asAgent: string;
let asB: string;
let ownerA: string;
let published: { channel: string; event: RealtimeEvent }[] = [];

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    publisher: {
      publish: async (channel, event) => void published.push({ channel, event }),
      close: async () => {},
    },
  });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  for (const [email, role] of [
    ['admin@kaki-bakery.test', 'admin'],
    ['staff@kaki-bakery.test', 'agent'],
  ]) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email) values ($1) returning id`,
      [email],
    );
    await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [
      TENANT_A,
      u.rows[0]!.id,
      role,
    ]);
  }
  ownerA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`))
    .rows[0].id;
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asAdmin = await sessionCookie(tdb, 'admin@kaki-bakery.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  published = [];
  await owner.query(
    `update tenants set ai_paused = false, ai_paused_at = null, ai_paused_by = null,
       allowed_origins = '{http://localhost:5175}'`,
  );
  await owner.query(`update channel_connections set state = 'live'`);
  await owner.query(`delete from assistant_settings`);
});

const call = (method: 'GET' | 'POST', url: string, who: string) =>
  app.inject({ method, url, headers: { cookie: who } });
const status = async (who = asA) => (await call('GET', '/api/v1/ai/status', who)).json().status;
const aiEntries = async (tenantId = TENANT_A) =>
  (
    await owner.query(
      `select event_type, actor_ref, payload::text as p from audit_entries
       where tenant_id = $1 and event_type like 'ai.%' order by seq`,
      [tenantId],
    )
  ).rows;
const config = () =>
  app.inject({
    method: 'GET',
    url: '/widget/v1/config?key=wk_dev_bakery',
    headers: { origin: 'http://localhost:5175' },
  });

describe('GET /api/v1/ai/status', () => {
  it('works for every role and returns the session tenant only (AC-7)', async () => {
    for (const who of [asA, asAdmin, asAgent]) {
      const res = await call('GET', '/api/v1/ai/status', who);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toEqual({
        paused: false,
        pausedAt: null,
        liveChannels: 1,
        fallback: { en: DEFAULT_FALLBACK_EN, zh: expect.stringMatching(/\S/) },
      });
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/ai/status' })).statusCode).toBe(401);
    await call('POST', '/api/v1/ai/pause', asA);
    expect((await status(asB)).paused).toBe(false);
    expect((await status(asAgent)).paused).toBe(true);
  });

  it("resolves the tenant's own fallback wording", async () => {
    await owner.query(
      `insert into assistant_settings (tenant_id, fallback_en) values ($1, 'Mei will reply soon.')`,
      [TENANT_A],
    );
    expect((await status()).fallback.en).toBe('Mei will reply soon.');
  });
});

describe('POST /api/v1/ai/pause and /resume (AC-1, AC-2)', () => {
  it('Owner pauses, a repeat changes nothing, Admin resumes; one nudge and one entry per change', async () => {
    const before = (await aiEntries()).length;
    const res = await call('POST', '/api/v1/ai/pause', asA);
    expect(res.statusCode).toBe(200);
    const paused = res.json().status;
    expect(paused).toMatchObject({ paused: true, liveChannels: 1 });
    expect(Date.parse(paused.pausedAt)).not.toBeNaN();
    const again = await call('POST', '/api/v1/ai/pause', asAdmin);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toEqual(paused);
    expect(published).toEqual([
      { channel: expect.stringContaining(TENANT_A), event: { type: 'ai_status', paused: true } },
    ]);

    const resumed = await call('POST', '/api/v1/ai/resume', asAdmin);
    expect(resumed.json().status).toMatchObject({ paused: false, pausedAt: null });
    expect((await call('POST', '/api/v1/ai/resume', asA)).statusCode).toBe(200);
    expect(published.map((p) => p.event)).toEqual([
      { type: 'ai_status', paused: true },
      { type: 'ai_status', paused: false },
    ]);
    const added = (await aiEntries()).slice(before);
    expect(added.map((e) => e.event_type)).toEqual(['ai.paused', 'ai.resumed']);
    expect(added[0]).toMatchObject({ actor_ref: ownerA, p: '{}' });
    const row = await owner.query(`select ai_paused_at, ai_paused_by from tenants where id = $1`, [
      TENANT_A,
    ]);
    expect(row.rows[0]).toEqual({ ai_paused_at: null, ai_paused_by: null });
  });

  it('an Agent gets 403 and nothing changes', async () => {
    for (const action of ['pause', 'resume']) {
      const res = await call('POST', `/api/v1/ai/${action}`, asAgent);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('forbidden');
    }
    expect((await status()).paused).toBe(false);
    expect(published).toEqual([]);
  });

  it("pausing tenant A leaves tenant B's AI running (AC-7)", async () => {
    await call('POST', '/api/v1/ai/pause', asA);
    const b = await owner.query(`select ai_paused from tenants where id = $1`, [TENANT_B]);
    expect(b.rows[0].ai_paused).toBe(false);
    expect((await aiEntries(TENANT_B)).length).toBe(0);
  });
});

describe('the widget while paused (AC-4, AC-5)', () => {
  it('config carries the fallback and contacts while paused, null after resume', async () => {
    expect((await config()).json().aiPaused).toBeNull();
    await call('POST', '/api/v1/ai/pause', asA);
    const paused = (await config()).json();
    expect(paused.availability).toEqual({ live: true });
    expect(paused.aiPaused).toEqual({
      message: { en: DEFAULT_FALLBACK_EN, zh: expect.stringMatching(/\S/) },
      contact: { email: 'hello@kaki-bakery.test', phone: expect.any(String) },
    });
    expect(paused.aiPaused.message.en).toBe((await status()).fallback.en);
    await owner.query(
      `insert into assistant_settings (tenant_id, fallback_en, fallback_zh)
       values ($1, 'Mei will reply soon.', '美玲会尽快回复。')`,
      [TENANT_A],
    );
    expect((await config()).json().aiPaused.message).toEqual({
      en: 'Mei will reply soon.',
      zh: '美玲会尽快回复。',
    });
    await call('POST', '/api/v1/ai/resume', asA);
    expect((await config()).json().aiPaused).toBeNull();
  });

  it('a visitor can still start a conversation and write while paused', async () => {
    await call('POST', '/api/v1/ai/pause', asA);
    const { token } = (await config()).json();
    const headers = { authorization: `Bearer ${token}`, origin: 'http://localhost:5175' };
    const start = await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers });
    expect(start.statusCode).toBe(201);
    const { conversationId } = start.json();
    const sent = await app.inject({
      method: 'POST',
      url: `/widget/v1/conversations/${conversationId}/messages`,
      headers,
      payload: { text: 'Is anyone there?', clientMessageId: 'kill-switch-1' },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().message).toMatchObject({ author: 'visitor', body: 'Is anyone there?' });
  });
});
