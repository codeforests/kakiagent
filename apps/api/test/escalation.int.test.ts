/**
 * Escalation routes (CHN-13, INB-05; FEAT-044 §3, §5.6; AC-1, AC-3–AC-7, AC-9): the widget's
 * Talk to a person, the routing settings on Team, and escalated rows in the inbox.
 */
import { randomUUID } from 'node:crypto';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { withTenant } from '@kaki/db';
import { messagesSince } from '@kaki/inbox';
import { channels, signToken } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';
const ALWAYS = [{ open: '00:00', close: '24:00' }];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
const cookies: Record<'owner' | 'mei' | 'other', string> = { owner: '', mei: '', other: '' };
const ids: Record<string, string> = {};
const published: { channel: string; payload: Record<string, unknown> }[] = [];

async function member(email: string, displayName: string | null, role: string, tenant = TENANT_A) {
  const u = await owner.query(
    `insert into users (email, display_name) values ($1, $2) returning id`,
    [email, displayName],
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [
    tenant,
    u.rows[0].id,
    role,
  ]);
  return u.rows[0].id as string;
}
const setHours = (hours: Record<string, unknown>) =>
  owner.query(`update business_profiles set hours = $2 where tenant_id = $1`, [TENANT_A, hours]);

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    env: { VISITOR_TOKEN_SECRET: VISITOR_SECRET },
    publisher: {
      publish: async (channel: string, payload: unknown) =>
        void published.push({ channel, payload: payload as Record<string, unknown> }),
      close: async () => {},
    },
  });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  ids.owner = (
    await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)
  ).rows[0].id;
  ids.mei = await member('mei@kaki-bakery.test', 'Mei Ling', 'agent');
  ids.otherOwner = (
    await owner.query(`select id from users where email = 'owner@second-tenant.test'`)
  ).rows[0].id;
  cookies.owner = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  cookies.mei = await sessionCookie(tdb, 'mei@kaki-bakery.test');
  cookies.other = await sessionCookie(tdb, 'owner@second-tenant.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await setHours(Object.fromEntries(DAYS.map((d) => [d, ALWAYS])));
  await owner.query(`delete from escalation_routing`);
  // Every escalation goes to Mei, so the assignee is known.
  await owner.query(
    `insert into escalation_routing (tenant_id, mode, person_user_id) values ($1, 'person', $2)`,
    [TENANT_A, ids.mei],
  );
});

const visitorHeaders = (tenant = TENANT_A, visitorId = randomUUID()) => ({
  origin: ORIGIN,
  authorization: `Bearer ${signToken(
    { t: tenant, o: ORIGIN, v: visitorId, exp: Math.floor(Date.now() / 1000) + 600 },
    VISITOR_SECRET,
  )}`,
});

async function chat(tenant = TENANT_A) {
  const h = visitorHeaders(tenant);
  const conv = await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers: h });
  const { conversationId } = conv.json<{ conversationId: string }>();
  return { id: conversationId, h };
}
const escalate = (c: { id: string; h: Record<string, string> }) =>
  app.inject({ method: 'POST', url: `/widget/v1/conversations/${c.id}/escalate`, headers: c.h });
type Who = keyof typeof cookies;
const call = (method: 'GET' | 'PUT' | 'POST', url: string, who: Who, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie: cookies[who] },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const alerts = async (id: string) =>
  (
    await owner.query(
      `select user_id, kind, urgent, status from notifications where subject_id = $1 order by created_at`,
      [id],
    )
  ).rows;

describe('Talk to a person (AC-1, AC-4, AC-6)', () => {
  it('escalates, alerts the assignee urgently in hours, stores and publishes the notice', async () => {
    const c = await chat();
    published.length = 0;
    const res = await escalate(c);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('escalated');
    expect(body.notice).toMatchObject({
      author: 'system',
      noticeKind: 'escalated',
      notice: expect.stringMatching(/^I've asked the team to join\./),
    });
    expect(await alerts(c.id)).toEqual([
      { user_id: ids.mei, kind: 'escalation', urgent: true, status: 'pending' },
    ]);
    expect(published.map((p) => [p.channel, p.payload.type])).toEqual([
      [channels.conversation(TENANT_A, c.id), 'message'],
      [channels.inbox(TENANT_A), 'message'],
      [channels.inbox(TENANT_A), 'conversation'],
    ]);
    expect(published[2]!.payload.conversation).toMatchObject({
      status: 'escalated',
      escalation: { assignee: { userId: ids.mei, name: 'Mei Ling' }, source: 'visitor_button' },
    });
    const replay = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      messagesSince(tx, { tenantId: TENANT_A, conversationId: c.id, afterSeq: 0 }),
    );
    expect(replay.at(-1)).toMatchObject({ noticeKind: 'escalated' });
    // A second press: no second escalation, notice or alert.
    const again = await escalate(c);
    expect(again.json()).toEqual({ status: 'already_escalated', notice: null });
    expect(await alerts(c.id)).toHaveLength(1);
  });

  it('after hours: not urgent, and the notice gives the next opening', async () => {
    // Open one minute a day, so it is closed now (barring the first minute after midnight).
    await setHours(Object.fromEntries(DAYS.map((d) => [d, [{ open: '00:00', close: '00:01' }]])));
    const c = await chat();
    const res = await escalate(c);
    expect(res.json().notice.notice).toMatch(
      // The next opening can be days away when public holidays fall next (e.g. Deepavali).
      /We're closed now, so they'll reply (from today|from tomorrow|on \w{3} \d{1,2} \w{3}) at /,
    );
    expect(await alerts(c.id)).toEqual([
      expect.objectContaining({ user_id: ids.mei, urgent: false }),
    ]);
  });

  it('with a person: with_person; closed: 409; another visitor or tenant: 404', async () => {
    const c = await chat();
    await call('POST', `/api/v1/conversations/${c.id}/takeover`, 'mei', { version: 0 });
    expect((await escalate(c)).json()).toEqual({ status: 'with_person', notice: null });
    const ended = await chat();
    await app.inject({
      method: 'POST',
      url: `/widget/v1/conversations/${ended.id}/end`,
      headers: ended.h,
    });
    const closed = await escalate(ended);
    expect(closed.statusCode).toBe(409);
    const other = await chat();
    expect((await escalate({ id: other.id, h: visitorHeaders() })).statusCode).toBe(404);
    expect((await escalate({ id: other.id, h: visitorHeaders(TENANT_B) })).statusCode).toBe(404);
  });

  it('take-over resolves it and cancels the pending alert', async () => {
    const c = await chat();
    await escalate(c);
    const res = await call('POST', `/api/v1/conversations/${c.id}/takeover`, 'owner', {
      version: 1,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation).toMatchObject({ status: 'human', escalation: null });
    expect((await alerts(c.id)).map((a) => a.status)).toEqual(['cancelled']);
    const e = await owner.query(
      `select resolution, resolved_by from escalations where conversation_id = $1`,
      [c.id],
    );
    expect(e.rows).toEqual([{ resolution: 'claimed', resolved_by: ids.owner }]);
  });

  it('the widget config offers Talk to a person while live, not while paused', async () => {
    const config = () =>
      app.inject({
        method: 'GET',
        url: '/widget/v1/config?key=wk_dev_bakery',
        headers: { origin: ORIGIN },
      });
    expect((await config()).json().controls).toEqual({ talkToPerson: true });
    await owner.query(`update tenants set ai_paused = true, ai_paused_at = now() where id = $1`, [
      TENANT_A,
    ]);
    try {
      expect((await config()).json().controls).toEqual({ talkToPerson: false });
    } finally {
      await owner.query(
        `update tenants set ai_paused = false, ai_paused_at = null, ai_paused_by = null where id = $1`,
        [TENANT_A],
      );
    }
  });
});

describe('routing settings (AC-3, AC-5, AC-9)', () => {
  it('GET returns the defaults when unsaved; any member may read', async () => {
    await owner.query(`delete from escalation_routing`);
    for (const who of ['owner', 'mei'] as const) {
      const res = await call('GET', '/api/v1/settings/escalation', who);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        mode: 'round_robin',
        personUserId: null,
        reminderMinutes: 10,
        personInactive: false,
      });
    }
  });

  it('PUT by an owner saves and audits codes only; an agent is refused', async () => {
    const res = await call('PUT', '/api/v1/settings/escalation', 'owner', {
      mode: 'person',
      personUserId: ids.mei,
      reminderMinutes: 15,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: 'person',
      personUserId: ids.mei,
      reminderMinutes: 15,
      personInactive: false,
    });
    const audit = await owner.query(
      `select payload, subject_refs from audit_entries where event_type = 'escalation.routing_updated' order by seq desc limit 1`,
    );
    expect(audit.rows[0]).toEqual({
      payload: { mode: 'person', reminderMinutes: 15 },
      subject_refs: [`tenant:${TENANT_A}`, `user:${ids.mei}`],
    });
    const agent = await call('PUT', '/api/v1/settings/escalation', 'mei', {
      mode: 'round_robin',
      personUserId: null,
      reminderMinutes: 10,
    });
    expect(agent.statusCode).toBe(403);
  });

  it('422: person mode with no person, out-of-range minutes, extra keys, a person of tenant B', async () => {
    const put = (payload: unknown) => call('PUT', '/api/v1/settings/escalation', 'owner', payload);
    const noPerson = await put({ mode: 'person', personUserId: null, reminderMinutes: 10 });
    expect(noPerson.statusCode).toBe(422);
    expect(noPerson.json()).toMatchObject({
      error: 'invalid_routing',
      fields: { personUserId: 'person_required' },
    });
    expect(
      (await put({ mode: 'round_robin', personUserId: null, reminderMinutes: 0 })).statusCode,
    ).toBe(422);
    expect(
      (
        await put({
          mode: 'round_robin',
          personUserId: null,
          reminderMinutes: 10,
          tenantId: TENANT_B,
        })
      ).statusCode,
    ).toBe(422);
    const foreign = await put({
      mode: 'person',
      personUserId: ids.otherOwner,
      reminderMinutes: 10,
    });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().error).toBe('person_not_member');
  });

  it('a person who left shows as inactive; tenant B sees its own defaults', async () => {
    await owner.query(`update memberships set status = 'deactivated' where user_id = $1`, [
      ids.mei,
    ]);
    try {
      expect((await call('GET', '/api/v1/settings/escalation', 'owner')).json()).toMatchObject({
        mode: 'person',
        personUserId: ids.mei,
        personInactive: true,
      });
    } finally {
      await owner.query(`update memberships set status = 'active' where user_id = $1`, [ids.mei]);
    }
    expect((await call('GET', '/api/v1/settings/escalation', 'other')).json()).toMatchObject({
      mode: 'round_robin',
      personUserId: null,
    });
  });
});

describe('the inbox (AC-7, AC-9)', () => {
  it('escalated rows carry the escalation and match assignee=<id>; the thread names the assignee', async () => {
    const c = await chat();
    await escalate(c);
    const list = await call(
      'GET',
      `/api/v1/conversations?view=escalated&assignee=${ids.mei}`,
      'owner',
    );
    expect(list.statusCode).toBe(200);
    const row = list.json().conversations.find((x: { id: string }) => x.id === c.id);
    expect(row).toMatchObject({
      status: 'escalated',
      escalation: { assignee: { userId: ids.mei, name: 'Mei Ling' }, urgent: true, reminders: 0 },
    });
    const mine = await call('GET', `/api/v1/conversations?view=escalated&assignee=me`, 'mei');
    expect(mine.json().conversations.map((x: { id: string }) => x.id)).toContain(c.id);
    const none = await call('GET', `/api/v1/conversations?view=escalated&assignee=none`, 'owner');
    expect(none.json().conversations.map((x: { id: string }) => x.id)).not.toContain(c.id);
    const thread = await call('GET', `/api/v1/conversations/${c.id}`, 'owner');
    expect(thread.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'escalated',
          to: 'escalated',
          subject: { name: 'Mei Ling' },
          source: 'visitor_button',
        }),
      ]),
    );
    // Tenant B sees none of it.
    const b = await call('GET', `/api/v1/conversations/${c.id}`, 'other');
    expect(b.statusCode).toBe(404);
  });
});
