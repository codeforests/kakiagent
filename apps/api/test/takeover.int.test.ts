/**
 * The takeover routes (INB-02, INB-09, INB-01; FEAT-043 §3, §5.4; AC-1–AC-9): take over,
 * staff messages, hand back, requests, take-from, the assignee filter, members, tenants.
 */
import { randomUUID } from 'node:crypto';
import { runVisitorTurn } from '@kaki/agent';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { withTenant } from '@kaki/db';
import { messagesSince } from '@kaki/inbox';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import { channels, signToken } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
const cookies: Record<'owner' | 'mei' | 'admin' | 'ahmad' | 'other', string> = {
  owner: '',
  mei: '',
  admin: '',
  ahmad: '',
  other: '',
};
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
  ids.admin = await member('admin@kaki-bakery.test', 'Siti', 'admin');
  ids.ahmad = await member('ahmad@kaki-bakery.test', null, 'agent');
  cookies.owner = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  cookies.mei = await sessionCookie(tdb, 'mei@kaki-bakery.test');
  cookies.admin = await sessionCookie(tdb, 'admin@kaki-bakery.test');
  cookies.ahmad = await sessionCookie(tdb, 'ahmad@kaki-bakery.test');
  cookies.other = await sessionCookie(tdb, 'owner@second-tenant.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const visitorHeaders = (tenant = TENANT_A, visitorId = randomUUID()) => ({
  origin: ORIGIN,
  authorization: `Bearer ${signToken(
    { t: tenant, o: ORIGIN, v: visitorId, exp: Math.floor(Date.now() / 1000) + 600 },
    VISITOR_SECRET,
  )}`,
});

const say = (id: string, h: Record<string, string>, text: string) =>
  app.inject({
    method: 'POST',
    url: `/widget/v1/conversations/${id}/messages`,
    headers: h,
    payload: { text, clientMessageId: `c-${randomUUID()}` },
  });

async function chat() {
  const h = visitorHeaders();
  const conv = await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers: h });
  const { conversationId } = conv.json<{ conversationId: string }>();
  await say(conversationId, h, 'Can someone help me with a big order?');
  return { id: conversationId, h };
}

type Who = keyof typeof cookies;
const post = (url: string, who: Who, payload: unknown = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { cookie: cookies[who] },
    payload: payload as object,
  });
const takeover = (id: string, who: Who, version = 0, from?: string) =>
  post(`/api/v1/conversations/${id}/takeover`, who, { version, ...(from ? { from } : {}) });
const handback = (id: string, who: Who, version: number) =>
  post(`/api/v1/conversations/${id}/handback`, who, { version });
const staff = (id: string, who: Who, body: string, clientMessageId = `s-${randomUUID()}`) =>
  post(`/api/v1/conversations/${id}/messages`, who, { body, clientMessageId });
const list = (query: string, who: Who = 'owner') =>
  app.inject({
    method: 'GET',
    url: `/api/v1/conversations?${query}`,
    headers: { cookie: cookies[who] },
  });

describe('take over, reply, hand back (AC-1, AC-3, AC-4)', () => {
  it('takes over, stores the joined notice for the widget, and names the owner', async () => {
    const c = await chat();
    published.length = 0;
    const res = await takeover(c.id, 'mei');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversation).toMatchObject({
      status: 'human',
      owner: { userId: ids.mei, name: 'Mei Ling' },
    });
    expect(body.notice).toMatchObject({
      noticeKind: 'staff_joined',
      notice: 'Mei Ling joined the chat.',
      authorName: 'Mei Ling',
    });
    expect(published.map((p) => [p.channel, p.payload.type])).toEqual([
      [channels.conversation(TENANT_A, c.id), 'message'],
      [channels.inbox(TENANT_A), 'message'],
      [channels.inbox(TENANT_A), 'conversation'],
    ]);
    // The widget's stream replays the stored notice after a reconnect.
    const replay = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      messagesSince(tx, { tenantId: TENANT_A, conversationId: c.id, afterSeq: 0 }),
    );
    expect(replay.at(-1)).toMatchObject({ noticeKind: 'staff_joined', authorName: 'Mei Ling' });
  });

  it('a member without a display name is "A team member" to the visitor, never the email', async () => {
    const c = await chat();
    const res = await takeover(c.id, 'ahmad');
    expect(res.json().notice.notice).toBe('A team member joined the chat.');
    expect(JSON.stringify(res.json().notice)).not.toContain('ahmad');
    expect(res.json().conversation.owner).toEqual({ userId: ids.ahmad, name: 'ahmad' });
  });

  it('the owner replies (idempotent, masked), the visitor gets no AI reply, then hands back', async () => {
    const c = await chat();
    await takeover(c.id, 'mei');
    const cid = `s-${randomUUID()}`;
    const first = await staff(c.id, 'mei', 'Sure, NRIC S1234567D noted', cid);
    expect(first.statusCode).toBe(201);
    expect(first.json().message).toMatchObject({
      author: 'staff',
      authorName: 'Mei Ling',
      authorUserId: ids.mei,
    });
    expect(first.json().message.body).not.toContain('S1234567D');
    const retry = await staff(c.id, 'mei', 'Sure, NRIC S1234567D noted', cid);
    expect([retry.statusCode, retry.json().message.id]).toEqual([200, first.json().message.id]);
    const blocked = await staff(c.id, 'ahmad', 'me too');
    expect([blocked.statusCode, blocked.json().error]).toEqual([409, 'not_owner']);
    expect(blocked.json().conversation.owner.userId).toBe(ids.mei);
    expect((await staff(c.id, 'mei', '   ')).statusCode).toBe(422);

    // A visitor message while Mei has it: the turn makes no reply (AC-2).
    const sent = await say(c.id, c.h, 'Thanks!');
    expect(sent.statusCode).toBe(201);
    const ownerEvent = published.filter((p) => p.payload.type === 'conversation').at(-1)!.payload
      .conversation as { owner: unknown };
    expect(ownerEvent.owner).toEqual({ userId: ids.mei, name: 'Mei Ling' });
    const turn = await runVisitorTurn(
      { zdb: tdb.zone('visitor'), llm: gatewayFromConfig({ provider: 'fake' }) },
      { tenantId: TENANT_A, conversationId: c.id, messageId: sent.json().message.id },
    );
    expect(turn).toBeNull();

    const back = await handback(c.id, 'mei', 1);
    expect(back.statusCode).toBe(200);
    expect(back.json().conversation).toMatchObject({ status: 'ai', owner: null });
    expect(back.json().notice.noticeKind).toBe('staff_left');
    const again = await handback(c.id, 'mei', 2);
    expect([again.statusCode, again.json().error]).toEqual([409, 'not_owner']);
  });
});

describe('one owner (AC-5, AC-6)', () => {
  it('two parallel take-overs: one 200, one 409 owned naming the winner', async () => {
    const c = await chat();
    const [a, b] = await Promise.all([takeover(c.id, 'mei'), takeover(c.id, 'ahmad')]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const won = a.statusCode === 200 ? a : b;
    const lost = a.statusCode === 200 ? b : a;
    expect(lost.json()).toMatchObject({ error: 'owned', owner: won.json().conversation.owner });
  });

  it('the conflicts: already owner, closed, stale version, close by a non-owner', async () => {
    const c = await chat();
    await takeover(c.id, 'mei');
    const mine = await takeover(c.id, 'mei', 1);
    expect([mine.statusCode, mine.json().error]).toEqual([409, 'already_owner']);
    const close = (who: Who) => post(`/api/v1/conversations/${c.id}/close`, who, { version: 1 });
    const notMine = await close('owner');
    expect(notMine.json()).toMatchObject({ error: 'owned', owner: { userId: ids.mei } });
    expect((await close('mei')).statusCode).toBe(200);
    const closed = await takeover(c.id, 'ahmad', 2);
    expect([closed.statusCode, closed.json().error]).toEqual([409, 'closed']);
    const fresh = await chat();
    const stale = await takeover(fresh.id, 'mei', 5);
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'state_changed']);
    expect(stale.json().conversation).toMatchObject({ status: 'ai', owner: null });
  });

  it('a request notifies the owner and shows as a divider; take-from is for owners and admins', async () => {
    const c = await chat();
    const nobody = await post(`/api/v1/conversations/${c.id}/handover-request`, 'ahmad');
    expect([nobody.statusCode, nobody.json().error]).toEqual([409, 'not_owned']);
    await takeover(c.id, 'mei');
    published.length = 0;
    const asked = await post(`/api/v1/conversations/${c.id}/handover-request`, 'ahmad');
    expect(asked.statusCode).toBe(202);
    expect(published[0]).toEqual({
      channel: channels.member(TENANT_A, ids.mei),
      payload: {
        type: 'handover_requested',
        conversationId: c.id,
        by: { userId: ids.ahmad, name: 'ahmad' },
      },
    });
    const self = await post(`/api/v1/conversations/${c.id}/handover-request`, 'mei');
    expect(self.json().error).toBe('already_owner');

    const agentFrom = await takeover(c.id, 'ahmad', 1, ids.mei);
    expect(agentFrom.statusCode).toBe(403);
    published.length = 0;
    const adminFrom = await takeover(c.id, 'admin', 1, ids.mei);
    expect(adminFrom.statusCode).toBe(200);
    expect(adminFrom.json().conversation.owner).toEqual({ userId: ids.admin, name: 'Siti' });
    expect(published.at(-1)).toEqual({
      channel: channels.member(TENANT_A, ids.mei),
      payload: {
        type: 'taken_from_you',
        conversationId: c.id,
        by: { userId: ids.admin, name: 'Siti' },
      },
    });
    const stale = await takeover(c.id, 'owner', 1, ids.mei);
    expect(stale.json()).toMatchObject({ error: 'owned', owner: { userId: ids.admin } });

    const thread = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${c.id}`,
      headers: { cookie: cookies.owner },
    });
    const events = thread
      .json()
      .events.map((e: Record<string, unknown>) => [
        e.reason,
        (e.actor as { name: string }).name,
        (e.subject as { name: string } | null)?.name ?? null,
      ]);
    expect(events).toEqual([
      ['taken_over', 'Mei Ling', null],
      ['handover_requested', 'ahmad', 'Mei Ling'],
      ['taken_from', 'Siti', 'Mei Ling'],
    ]);
    expect(
      thread.json().messages.filter((m: { noticeKind: string }) => m.noticeKind === 'staff_joined'),
    ).toHaveLength(2);
  });
});

describe('the assignee filter and members (AC-7)', () => {
  it('filters by me, none and a member, and lists active members by name', async () => {
    const mine = await chat();
    const theirs = await chat();
    const free = await chat();
    await takeover(mine.id, 'mei');
    await takeover(theirs.id, 'ahmad');
    const idsOf = async (q: string, who: Who = 'owner') =>
      (await list(q, who)).json().conversations.map((x: { id: string }) => x.id) as string[];
    const meiMine = await idsOf('assignee=me', 'mei');
    expect(meiMine).toContain(mine.id);
    expect(meiMine).not.toContain(theirs.id);
    const none = await idsOf('assignee=none&limit=50');
    expect(none).toContain(free.id);
    expect(none).not.toContain(mine.id);
    const ahmads = await idsOf(`assignee=${ids.ahmad}`);
    expect(ahmads).toContain(theirs.id);
    expect(ahmads).not.toContain(mine.id);
    expect((await list('assignee=anyone')).statusCode).toBe(400);
    const members = await app.inject({
      method: 'GET',
      url: '/api/v1/inbox/members',
      headers: { cookie: cookies.mei },
    });
    expect(members.json().members.map((m: { name: string }) => m.name)).toEqual([
      'ahmad',
      'Mei Ling',
      'owner',
      'Siti',
    ]);
  });
});

describe('tenants and sessions (AC-9)', () => {
  it("every new route is 404 across tenants; tenant B's members aren't listed", async () => {
    const c = await chat();
    for (const res of [
      await takeover(c.id, 'other'),
      await handback(c.id, 'other', 0),
      await staff(c.id, 'other', 'hi'),
      await post(`/api/v1/conversations/${c.id}/handover-request`, 'other'),
    ])
      expect(res.statusCode).toBe(404);
    const members = await app.inject({
      method: 'GET',
      url: '/api/v1/inbox/members',
      headers: { cookie: cookies.other },
    });
    expect(members.json().members.map((m: { userId: string }) => m.userId)).not.toContain(ids.mei);
    expect((await takeover(c.id, 'mei')).statusCode).toBe(200);
  });

  it('refuses a signed-out caller and a session still owing two-step verification', async () => {
    const c = await chat();
    const u = await member('two-step-takeover@kaki-bakery.test', 'Two', 'agent');
    await owner.query(
      `insert into mfa_factors (user_id, secret_ciphertext, key_ref, confirmed_at)
       values ($1, '\\x00', 'test', now())`,
      [u],
    );
    const pending = await sessionCookie(tdb, 'two-step-takeover@kaki-bakery.test');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${c.id}/takeover`,
      headers: { cookie: pending },
      payload: { version: 0 },
    });
    expect([res.statusCode, res.json().error]).toEqual([401, 'mfa_required']);
    const anon = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${c.id}/takeover`,
      payload: { version: 0 },
    });
    expect(anon.statusCode).toBe(401);
  });
});
