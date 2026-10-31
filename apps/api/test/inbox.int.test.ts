/**
 * The inbox routes (INB-01, INB-04, INB-08; FEAT-042 §3, §5.4; AC-1–AC-5, AC-7–AC-9):
 * views and pages, the thread with dividers and sidebar, older pages, staff close and
 * reopen, tenant isolation.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { appendAgentReply, flagConversation } from '@kaki/inbox';
import { signToken } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let cookieA: string;
let cookieB: string;
const published: { channel: string; payload: { type: string; conversation?: unknown } }[] = [];

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    env: { VISITOR_TOKEN_SECRET: VISITOR_SECRET },
    publisher: {
      publish: async (channel: string, payload: unknown) =>
        void published.push({ channel, payload: payload as { type: string } }),
      close: async () => {},
    },
  });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  cookieA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  cookieB = await sessionCookie(tdb, 'owner@second-tenant.test');
  await owner.query(`update users set display_name = 'Mei Lin' where email = $1`, [
    'owner@kaki-bakery.test',
  ]);
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

async function chat(tenant = TENANT_A, text = 'How much is the fudge cake?') {
  const h = visitorHeaders(tenant);
  const conv = await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers: h });
  expect(conv.statusCode).toBe(201);
  const { conversationId } = conv.json<{ conversationId: string }>();
  const sent = await send(conversationId, h, text);
  expect(sent.statusCode).toBe(201);
  return { id: conversationId, h, messageId: sent.json().message.id as string };
}

const send = (id: string, h: Record<string, string>, text: string) =>
  app.inject({
    method: 'POST',
    url: `/widget/v1/conversations/${id}/messages`,
    headers: h,
    payload: { text, clientMessageId: `c-${randomUUID()}` },
  });

const get = (url: string, cookie = cookieA) =>
  app.inject({ method: 'GET', url, headers: { cookie } });
const close = (id: string, version: number, cookie = cookieA) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${id}/close`,
    headers: { cookie },
    payload: { version },
  });

describe('GET /api/v1/conversations (AC-2, AC-3)', () => {
  // Tenant B holds only this block's conversations.
  const ids: string[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 30; i++) ids.push((await chat(TENANT_B)).id);
    await owner.query(`update conversations set status = 'escalated' where id = $1`, [ids[0]]);
    await owner.query(`update conversations set status = 'waiting_approval' where id = $1`, [
      ids[1],
    ]);
    await withTenant(tdb.zone('visitor'), TENANT_B, (tx) =>
      flagConversation(tx, TENANT_B, ids[2]!, 'abuse'),
    );
    expect((await close(ids[3]!, 0, cookieB)).statusCode).toBe(200);
  });

  it('pages the open view 25 at a time, newest first, with no duplicates or gaps', async () => {
    const first = await get('/api/v1/conversations', cookieB);
    expect(first.statusCode).toBe(200);
    const p1 = first.json();
    expect(p1.conversations).toHaveLength(25);
    expect(p1.counts).toEqual({ open: 29, escalated: 1, approval: 1, flagged: 1 });
    const p2 = (
      await get(`/api/v1/conversations?cursor=${encodeURIComponent(p1.nextCursor)}`, cookieB)
    ).json();
    expect(p2.nextCursor).toBeNull();
    const seen = [...p1.conversations, ...p2.conversations].map((c: { id: string }) => c.id);
    expect(seen).toHaveLength(29);
    expect(new Set(seen).size).toBe(29);
    expect(seen).not.toContain(ids[3]);
    const times = [...p1.conversations, ...p2.conversations].map(
      (c: { lastMessageAt: string }) => c.lastMessageAt,
    );
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('each view and the channel filter return exactly their conversations', async () => {
    const view = async (q: string) =>
      (await get(`/api/v1/conversations?${q}`, cookieB))
        .json()
        .conversations.map((c: { id: string }) => c.id);
    expect(await view('view=escalated')).toEqual([ids[0]]);
    expect(await view('view=approval')).toEqual([ids[1]]);
    expect(await view('view=flagged')).toEqual([ids[2]]);
    expect(await view('view=closed&channel=widget')).toEqual([ids[3]]);
    const closed = (await get('/api/v1/conversations?view=closed', cookieB)).json();
    expect(closed.conversations[0]).toMatchObject({ status: 'closed', closeReason: 'staff' });
  });

  it('a malformed cursor is 400 bad_cursor; bad query values are 400', async () => {
    const bad = await get('/api/v1/conversations?cursor=nope', cookieB);
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'bad_cursor']);
    expect((await get('/api/v1/conversations?view=mine', cookieB)).statusCode).toBe(400);
    expect((await get('/api/v1/conversations?limit=500', cookieB)).statusCode).toBe(400);
  });

  it("tenant A sees none of tenant B's conversations", async () => {
    const a = (await get('/api/v1/conversations?limit=50')).json();
    expect(a.conversations.map((c: { id: string }) => c.id)).not.toContain(ids[0]);
  });
});

describe('the thread, close and reopen (AC-4, AC-5, AC-7, AC-8)', () => {
  const FACT_LABEL = 'Chocolate fudge cake';
  let factId: string;
  beforeAll(async () => {
    const f = await owner.query(
      `insert into facts (tenant_id, type, status, value, gst_treatment)
       values ($1, 'product', 'approved', $2, 'inclusive') returning id`,
      [
        TENANT_A,
        JSON.stringify({ name: FACT_LABEL, priceCents: 5500, currency: 'SGD', unit: '1 kg' }),
      ],
    );
    factId = f.rows[0].id;
  });

  it('returns messages with fact IDs, sidebar facts and intents, and named dividers', async () => {
    const c = await chat();
    await withTenant(tdb.zone('visitor'), TENANT_A, async (tx) => {
      await appendAgentReply(tx, {
        tenantId: TENANT_A,
        conversationId: c.id,
        inReplyTo: c.messageId,
        text: 'It is S$55.',
        factIds: [factId],
        taskKinds: ['answer'],
      });
      await flagConversation(tx, TENANT_A, c.id, 'crisis');
    });
    const before = (await get(`/api/v1/conversations/${c.id}`)).json();
    expect(before.conversation).toMatchObject({ id: c.id, status: 'ai', version: 0 });
    published.length = 0;
    const closed = await close(c.id, 0);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().conversation).toMatchObject({
      id: c.id,
      status: 'closed',
      closeReason: 'staff',
      lastMessage: 'It is S$55.',
    });
    expect(published).toEqual([
      {
        channel: expect.stringContaining(TENANT_A),
        payload: {
          type: 'conversation',
          conversation: expect.objectContaining({ id: c.id, status: 'closed' }),
        },
      },
    ]);

    const res = await get(`/api/v1/conversations/${c.id}`);
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t.conversation).toMatchObject({ status: 'closed', version: 1 });
    expect(
      t.messages.map((m: { author: string; factIds: string[] }) => [m.author, m.factIds]),
    ).toEqual([
      ['visitor', []],
      ['agent', [factId]],
    ]);
    expect(t.hasEarlier).toBe(false);
    expect(t.events.map(({ at: _at, ...e }: { at: string }) => e)).toEqual([
      {
        kind: 'flagged',
        from: null,
        to: null,
        reason: 'crisis',
        actor: { type: 'agent', name: null },
        subject: null,
      },
      {
        kind: 'state',
        from: 'ai',
        to: 'closed',
        reason: 'staff',
        actor: { type: 'user', name: 'Mei Lin' },
        subject: null,
      },
    ]);
    expect(t.sidebar).toMatchObject({
      contact: { label: 'Website visitor', previousConversations: 0 },
      channel: 'widget',
      intents: [{ signal: 'asked_questions', count: 1 }],
      lead: null,
      facts: [{ id: factId, type: 'product', label: FACT_LABEL, status: 'approved', uses: 1 }],
    });

    // A widget message within 7 days reopens the same conversation.
    const again = await send(c.id, c.h, 'One more thing');
    expect(again.statusCode).toBe(201);
    const reopened = (await get(`/api/v1/conversations/${c.id}`)).json();
    expect(reopened.conversation).toMatchObject({ status: 'ai', version: 2, closeReason: null });
    expect(reopened.events.at(-1)).toMatchObject({
      kind: 'state',
      from: 'closed',
      to: 'ai',
      reason: 'reopened',
      actor: { type: 'visitor', name: null },
    });
  });

  it('close: 409 already_closed at the current version, 409 state_changed when stale', async () => {
    const c = await chat();
    expect((await close(c.id, 0)).statusCode).toBe(200);
    const already = await close(c.id, 1);
    expect([already.statusCode, already.json().error]).toEqual([409, 'already_closed']);
    const stale = await close(c.id, 0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: 'state_changed',
      conversation: { id: c.id, status: 'closed' },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/conversations/${c.id}/close`,
          headers: { cookie: cookieA },
          payload: { version: 1, status: 'ai' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('two simultaneous closes: one 200, one 409 state_changed', async () => {
    const c = await chat();
    const results = await Promise.all([close(c.id, 0), close(c.id, 0)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('state_changed');
  });

  it('pages older messages before a seq', async () => {
    const c = await chat();
    for (let i = 0; i < 3; i++) expect((await send(c.id, c.h, `more ${i}`)).statusCode).toBe(201);
    const thread = (await get(`/api/v1/conversations/${c.id}`)).json();
    const lastSeq = thread.messages.at(-1).seq;
    const page = await get(`/api/v1/conversations/${c.id}/messages?before=${lastSeq}`);
    expect(page.statusCode).toBe(200);
    expect(page.json().messages.map((m: { body: string }) => m.body)).toEqual([
      'How much is the fudge cake?',
      'more 0',
      'more 1',
    ]);
    expect(page.json().hasEarlier).toBe(false);
    expect((await get(`/api/v1/conversations/${c.id}/messages?before=0`)).statusCode).toBe(400);
  });

  it("another tenant's conversation is 404 on every route (AC-9)", async () => {
    const c = await chat();
    for (const url of [`/api/v1/conversations/${c.id}`, `/api/v1/conversations/${c.id}/messages`])
      expect((await get(url, cookieB)).statusCode).toBe(404);
    expect((await close(c.id, 0, cookieB)).statusCode).toBe(404);
    expect((await get('/api/v1/conversations/not-a-uuid')).statusCode).toBe(404);
    const row = await owner.query(`select status from conversations where id = $1`, [c.id]);
    expect(row.rows).toEqual([{ status: 'ai' }]);
  });

  it('refuses a signed-out caller and a session still owing two-step verification', async () => {
    const c = await chat();
    expect((await get(`/api/v1/conversations/${c.id}`, '')).statusCode).toBe(401);
    const u = await owner.query(
      `insert into users (email) values ('two-step@kaki-bakery.test') returning id`,
    );
    await owner.query(
      `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`,
      [TENANT_A, u.rows[0].id],
    );
    await owner.query(
      `insert into mfa_factors (user_id, secret_ciphertext, key_ref, confirmed_at)
       values ($1, '\\x00', 'test', now())`,
      [u.rows[0].id],
    );
    const pending = await sessionCookie(tdb, 'two-step@kaki-bakery.test');
    for (const res of [
      await get(`/api/v1/conversations/${c.id}`, pending),
      await get(`/api/v1/conversations/${c.id}/messages`, pending),
      await close(c.id, 0, pending),
    ])
      expect([res.statusCode, res.json().error]).toEqual([401, 'mfa_required']);
  });
});
