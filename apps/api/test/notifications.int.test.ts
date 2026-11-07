/**
 * Notification preferences and the test alert over HTTP (FEAT-052 §5.4; AC-5, AC-6, AC-9, AC-11).
 */
import { NotificationPrefs } from '@kaki/contracts';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { memoryRateLimiter } from '@kaki/platform';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let tdb: TestDatabase;
let owner: pg.Client;
let app: App;
let ownerA: string;
let ownerCookie: string;
let agentCookie: string;
let approverCookie: string;
let ownerBCookie: string;

const URL = '/api/v1/me/notifications';
const req = (method: 'GET' | 'PUT' | 'POST', url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const quiet = { enabled: true, start: '22:00', end: '08:00' };

async function member(email: string, approvalRights: boolean) {
  const id = (
    await owner.query<{ id: string }>(`insert into users (email) values ($1) returning id`, [email])
  ).rows[0]!.id;
  await owner.query(
    `insert into memberships (tenant_id, user_id, role, approval_rights) values ($1, $2, 'agent', $3)`,
    [TENANT_A, id, approvalRights],
  );
  return sessionCookie(tdb, email);
}

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
  agentCookie = await member('agent@a.test', false);
  approverCookie = await member('approver@a.test', true);
});
afterEach(async () => {
  await owner.query(`delete from notifications`);
  await owner.query(`delete from notification_prefs`);
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('GET/PUT /api/v1/me/notifications (AC-5, AC-6)', () => {
  it('defaults: every event on, quiet hours 22:00–08:00 Singapore time', async () => {
    const res = await req('GET', URL, ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(NotificationPrefs.parse(res.json())).toEqual({
      channels: ['email'],
      events: [
        { event: 'escalation', email: true },
        { event: 'approval_pending', email: true },
        { event: 'hot_lead', email: true },
        { event: 'consent_withdrawn', email: true },
      ],
      quietHours: quiet,
      timeZone: 'Asia/Singapore',
      sendTo: { email: 'owner@kaki-bakery.test' },
    });
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
  });

  it('PUT persists, GET reflects it, and unlisted events keep their setting', async () => {
    const put = await req('PUT', URL, ownerCookie, {
      events: [{ event: 'escalation', email: false }],
      quietHours: { enabled: true, start: '23:30', end: '06:15' },
    });
    expect(put.statusCode).toBe(200);
    await req('PUT', URL, ownerCookie, {
      events: [{ event: 'hot_lead', email: false }],
      quietHours: { enabled: false, start: '23:30', end: '06:15' },
    });
    const got = (await req('GET', URL, ownerCookie)).json();
    expect(got.events).toEqual([
      { event: 'escalation', email: false },
      { event: 'approval_pending', email: true },
      { event: 'hot_lead', email: false },
      { event: 'consent_withdrawn', email: true },
    ]);
    expect(got.quietHours).toEqual({ enabled: false, start: '23:30', end: '06:15' });
  });

  it('422 for the same start and end, a duplicate or unknown event, or extra fields', async () => {
    const same = await req('PUT', URL, ownerCookie, {
      events: [],
      quietHours: { enabled: true, start: '08:00', end: '08:00' },
    });
    expect(same.statusCode).toBe(422);
    expect(same.json()).toMatchObject({
      error: 'invalid_preferences',
      fields: { 'quietHours.end': 'same_time' },
    });
    const dup = await req('PUT', URL, ownerCookie, {
      events: [
        { event: 'hot_lead', email: true },
        { event: 'hot_lead', email: false },
      ],
      quietHours: quiet,
    });
    expect(dup.json()).toMatchObject({ fields: { events: 'duplicate_event' } });
    const unknown = await req('PUT', URL, ownerCookie, {
      events: [{ event: 'test', email: false }],
      quietHours: quiet,
    });
    expect(unknown.statusCode).toBe(422);
    const extra = await req('PUT', URL, ownerCookie, {
      events: [],
      quietHours: quiet,
      tenantId: TENANT_B,
    });
    expect(extra.statusCode).toBe(422);
  });

  it('approval alerts only for members who can approve (D9)', async () => {
    const agent = (await req('GET', URL, agentCookie)).json();
    expect(agent.events.map((e: { event: string }) => e.event)).toEqual([
      'escalation',
      'hot_lead',
      'consent_withdrawn',
    ]);
    const forbidden = await req('PUT', URL, agentCookie, {
      events: [{ event: 'approval_pending', email: false }],
      quietHours: quiet,
    });
    expect(forbidden.statusCode).toBe(403);
    const approver = await req('PUT', URL, approverCookie, {
      events: [{ event: 'approval_pending', email: false }],
      quietHours: quiet,
    });
    expect(approver.statusCode).toBe(200);
    expect(approver.json().events).toContainEqual({ event: 'approval_pending', email: false });
  });
});

describe('POST /api/v1/me/notifications/test (AC-11, D11)', () => {
  it('202 writes one urgent test alert to the caller; a second within 60 s is 429', async () => {
    const res = await req('POST', `${URL}/test`, ownerCookie);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sentTo: 'owner@kaki-bakery.test' });
    const rows = await owner.query(`select tenant_id, user_id, kind, urgent from notifications`);
    expect(rows.rows).toEqual([
      { tenant_id: TENANT_A, user_id: ownerA, kind: 'test', urgent: true },
    ]);
    const again = await req('POST', `${URL}/test`, ownerCookie);
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 60 });
    expect((await owner.query(`select 1 from notifications`)).rowCount).toBe(1);
  });
});

describe('isolation (AC-9)', () => {
  it("tenant B's member can't read or change tenant A's preferences", async () => {
    await req('PUT', URL, ownerCookie, {
      events: [{ event: 'escalation', email: false }],
      quietHours: quiet,
    });
    const b = (await req('GET', URL, ownerBCookie)).json();
    expect(b.events[0]).toEqual({ event: 'escalation', email: true });
    expect(b.sendTo.email).toBe('owner@second-tenant.test');
    await req('PUT', URL, ownerBCookie, {
      events: [{ event: 'hot_lead', email: false }],
      quietHours: quiet,
    });
    const rows = await owner.query(
      `select tenant_id, email_muted from notification_prefs order by tenant_id = $1 desc`,
      [TENANT_A],
    );
    expect(rows.rows).toEqual([
      { tenant_id: TENANT_A, email_muted: ['escalation'] },
      { tenant_id: TENANT_B, email_muted: ['hot_lead'] },
    ]);
  });

  it("the same user's preferences differ per business", async () => {
    await owner.query(
      `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'admin')`,
      [TENANT_B, ownerA],
    );
    try {
      await req('PUT', URL, ownerCookie, {
        events: [{ event: 'escalation', email: false }],
        quietHours: quiet,
      });
      const cookie = await sessionCookie(tdb, 'owner@kaki-bakery.test');
      const switched = await req('POST', `/api/v1/workspaces/${TENANT_B}/switch`, cookie);
      expect(switched.statusCode).toBe(200);
      const onB = (await req('GET', URL, cookie)).json();
      expect(onB.events[0]).toEqual({ event: 'escalation', email: true });
      expect((await req('GET', URL, ownerCookie)).json().events[0]).toEqual({
        event: 'escalation',
        email: false,
      });
    } finally {
      await owner.query(`delete from memberships where tenant_id = $1 and user_id = $2`, [
        TENANT_B,
        ownerA,
      ]);
    }
  });
});
