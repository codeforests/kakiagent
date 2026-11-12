/**
 * Page tracking routes (CHN-03, UC-20 1a; FEAT-029 §3, §5.1, §5.3, §5.4; AC-1, AC-3, AC-4).
 */
import { randomUUID } from 'node:crypto';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { signToken } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asStaff: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { env: { VISITOR_TOKEN_SECRET: VISITOR_SECRET } });
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
  asStaff = await sessionCookie(tdb, 'staff@kaki-bakery.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`delete from visitor_events`);
  await owner.query(`delete from visitor_tracking_choices`);
  await setMode(true, false);
});

const setMode = (enabled: boolean, consent: boolean, t = TENANT_A) =>
  owner.query(
    `update widget_settings set tracking_enabled = $2, tracking_consent_mode = $3 where tenant_id = $1`,
    [t, enabled, consent],
  );
const token = (visitorId: string, t = TENANT_A, o = ORIGIN) =>
  signToken({ t, o, v: visitorId, exp: Math.floor(Date.now() / 1000) + 600 }, VISITOR_SECRET);
const view = () => ({
  type: 'view',
  id: randomUUID(),
  sessionId: randomUUID(),
  path: '/menu',
  at: new Date().toISOString(),
});
const beacon = (body: unknown, origin = ORIGIN) =>
  app.inject({
    method: 'POST',
    url: '/widget/v1/events',
    headers: { origin, 'content-type': 'text/plain;charset=UTF-8' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
const stored = async (visitorId: string) =>
  (await owner.query(`select tenant_id from visitor_events where visitor_id = $1`, [visitorId]))
    .rows;
const choice = (visitorId: string, c: string) =>
  app.inject({
    method: 'POST',
    url: '/widget/v1/tracking-choice',
    headers: { origin: ORIGIN, authorization: `Bearer ${token(visitorId)}` },
    payload: { choice: c },
  });

describe('POST /widget/v1/events (FEAT-029 §5.3)', () => {
  it('204 and stored in on (text/plain); dropped in off and unconsented consent mode', async () => {
    const v = randomUUID();
    expect((await beacon({ token: token(v), events: [view()] })).statusCode).toBe(204);
    expect(await stored(v)).toHaveLength(1);
    await setMode(false, false);
    expect((await beacon({ token: token(v), events: [view()] })).statusCode).toBe(204);
    await setMode(true, true);
    expect((await beacon({ token: token(v), events: [view()] })).statusCode).toBe(204);
    expect(await stored(v)).toHaveLength(1);
  });

  it('401 on a wrong origin or a bad token; 400 on a bad body', async () => {
    const v = randomUUID();
    expect(
      (await beacon({ token: token(v), events: [view()] }, 'https://evil.test')).statusCode,
    ).toBe(401);
    expect((await beacon({ token: 'x.y', events: [view()] })).statusCode).toBe(401);
    expect((await beacon('not json')).statusCode).toBe(400);
    expect(
      (await beacon({ token: token(v), events: [{ ...view(), path: 'menu' }] })).statusCode,
    ).toBe(400);
    expect((await beacon({ token: token(v), events: Array(21).fill(view()) })).statusCode).toBe(
      400,
    );
    expect(await stored(v)).toEqual([]);
  });

  it('429 past 120 events per visitor in 10 minutes', async () => {
    const v = randomUUID();
    for (let i = 0; i < 6; i++)
      expect(
        (await beacon({ token: token(v), events: Array.from({ length: 20 }, view) })).statusCode,
      ).toBe(204);
    expect((await beacon({ token: token(v), events: [view()] })).statusCode).toBe(429);
    expect(await stored(v)).toHaveLength(120);
  });

  it("tenant B's token stores under B only, never A", async () => {
    const v = randomUUID();
    await beacon({ token: token(v, TENANT_B), events: [view()] });
    expect((await stored(v)).map((r) => r.tenant_id)).not.toContain(TENANT_A);
  });
});

describe('POST /widget/v1/tracking-choice (FEAT-029 §5.4)', () => {
  it('409 outside consent mode; 204 and recorded in it', async () => {
    const v = randomUUID();
    const off = await choice(v, 'accepted');
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe('not_consent_mode');
    await setMode(true, true);
    expect((await choice(v, 'accepted')).statusCode).toBe(204);
    expect((await beacon({ token: token(v), events: [view()] })).statusCode).toBe(204);
    expect(await stored(v)).toHaveLength(1);
    expect((await choice(v, 'declined')).statusCode).toBe(204);
    expect(await stored(v)).toEqual([]);
    expect((await choice(v, 'maybe')).statusCode).toBe(400);
  });
});

describe('widget config, messages and dashboard settings (FEAT-029 §5.1)', () => {
  it('config returns the mode', async () => {
    await setMode(true, true);
    const res = await app.inject({
      method: 'GET',
      url: '/widget/v1/config?key=wk_dev_bakery',
      headers: { origin: ORIGIN },
    });
    expect(res.json().tracking).toEqual({ mode: 'consent' });
  });

  it('a message with page stores it, masked', async () => {
    const v = randomUUID();
    const { rows } = await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', $2) returning id`,
      [TENANT_A, v],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/widget/v1/conversations/${rows[0]!.id}/messages`,
      headers: { origin: ORIGIN, authorization: `Bearer ${token(v)}` },
      payload: { text: 'how much?', clientMessageId: randomUUID(), page: '/u/S1234567D/cake' },
    });
    expect(res.statusCode).toBe(201);
    const { rows: m } = await owner.query<{ page_path: string }>(
      `select page_path from messages where conversation_id = $1`,
      [rows[0]!.id],
    );
    expect(m[0]!.page_path.startsWith('/u/')).toBe(true);
    expect(m[0]!.page_path).not.toContain('S1234567D');
  });

  it('PUT /api/v1/widget/tracking: staff 403; owner changes the mode, audited', async () => {
    const put = (cookie: string, mode: string) =>
      app.inject({
        method: 'PUT',
        url: '/api/v1/widget/tracking',
        headers: { cookie, origin: 'http://localhost:5173' },
        payload: { mode },
      });
    expect((await put(asStaff, 'off')).statusCode).toBe(403);
    const res = await put(asA, 'off');
    expect(res.statusCode).toBe(200);
    expect(res.json().tracking.mode).toBe('off');
    expect(res.json().tracking.updatedAt).not.toBeNull();
    expect((await put(asA, 'sometimes')).statusCode).toBe(422);
    const got = await app.inject({
      method: 'GET',
      url: '/api/v1/widget',
      headers: { cookie: asA },
    });
    expect(got.json().tracking.mode).toBe('off');
    const { rows } = await owner.query(
      `select 1 from audit_entries where tenant_id = $1 and event_type = 'widget.tracking_changed'`,
      [TENANT_A],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the inbox sidebar web context (FEAT-029 §5.7; AC-8)', () => {
  const thread = async (id: string) =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${id}`,
        headers: { cookie: asA },
      })
    ).json().sidebar.web;
  async function chat(visitorId: string, channel = 'widget', createdAt = 'now()') {
    const { rows } = await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id, created_at) values ($1, $2, $3, ${createdAt}) returning id`,
      [TENANT_A, channel, visitorId],
    );
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body, page_path) values ($1, $2, 'visitor', 'hi', $3)`,
      [TENANT_A, rows[0]!.id, channel === 'widget' ? '/cakes/premium' : null],
    );
    return rows[0]!.id;
  }

  it('full: current page, viewed with dwell, source and returning; off: current page only; email: nulls', async () => {
    const v = randomUUID();
    await chat(v, 'widget', `now() - interval '3 days'`);
    const e = view();
    await beacon({
      token: token(v),
      events: [{ ...e, path: '/cakes', utm: { source: 'ig' }, referrer: 'instagram.com' }],
    });
    await beacon({
      token: token(v),
      events: [{ type: 'engage', id: e.id, dwellMs: 42000, scroll: 80 }],
    });
    const id = await chat(v);
    const web = await thread(id);
    expect(web).toMatchObject({
      scope: 'full',
      currentPage: '/cakes/premium',
      viewed: [{ path: '/cakes', dwellMs: 42000 }],
      source: { utm: { source: 'ig' }, referrer: 'instagram.com' },
      returning: true,
    });
    await setMode(false, false);
    expect(await thread(id)).toEqual({
      scope: 'page_only',
      currentPage: '/cakes/premium',
      viewed: [],
      source: null,
      returning: false,
    });
    const mail = await chat(randomUUID(), 'email');
    expect(await thread(mail)).toMatchObject({ currentPage: null, viewed: [], source: null });
  });
});
