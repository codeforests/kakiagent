/**
 * Replay endpoints on the fake provider (AGT-17, UC-04 4b; FEAT-028 §3, §5.3; AC-1,
 * AC-2, AC-7, AC-8, AC-10's list half, AC-11).
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation } from '@kaki/inbox';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asStaff: string;

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
  asStaff = await sessionCookie(tdb, 'staff@kaki-bakery.test');
  const res = await call('POST', '/api/v1/kb/facts', asA, {
    type: 'product',
    value: { name: 'Chocolate fudge cake', price: '55', unit: '1 kg' },
    gstTreatment: 'inclusive',
  });
  expect(res.statusCode).toBe(201);
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const call = (method: 'GET' | 'POST', url: string, who: string | null, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: who ? { cookie: who } : {},
    ...(payload !== undefined ? { payload } : {}),
  });

async function conversation(tenantId: string, ...questions: string[]) {
  const visitorId = randomUUID();
  return withTenant(tdb.zone('visitor'), tenantId, async (tx) => {
    const conv = await createConversation(tx, tenantId, visitorId);
    for (const text of questions)
      await appendVisitorMessage(tx, {
        tenantId,
        conversationId: conv.id,
        visitorId,
        text,
        clientMessageId: randomUUID(),
      });
    return conv.id;
  });
}

async function replay(conversationId: string, who = asA) {
  const res = await call('POST', '/api/v1/coach/replays', who, {
    conversationId,
    includeUnreviewed: false,
  });
  expect(res.statusCode).toBe(201);
  return res.json().replay as { id: string; turns: { status: string }[]; totalQuestions: number };
}

describe('who can replay (AC-1)', () => {
  it('staff get 403 and no session gets 401 on every route', async () => {
    const conv = await conversation(TENANT_A, 'How much is the chocolate fudge cake?');
    const r = await replay(conv);
    const routes: ['GET' | 'POST', string, unknown?][] = [
      ['GET', '/api/v1/coach/replay-candidates'],
      ['POST', '/api/v1/coach/replays', { conversationId: conv, includeUnreviewed: false }],
      ['GET', `/api/v1/coach/replays/${r.id}`],
      ['POST', `/api/v1/coach/replays/${r.id}/next`, {}],
    ];
    for (const [method, url, body] of routes) {
      const staff = await call(method, url, asStaff, body);
      expect(staff.statusCode, url).toBe(403);
      expect(staff.json().error).toBe('forbidden');
      expect((await call(method, url, null, body)).statusCode, url).toBe(401);
    }
  });

  it("tenant B gets 404 for tenant A's conversations and replays, and never lists them", async () => {
    const conv = await conversation(TENANT_A, 'How much is the chocolate fudge cake?');
    const r = await replay(conv);
    const start = await call('POST', '/api/v1/coach/replays', asB, {
      conversationId: conv,
      includeUnreviewed: false,
    });
    expect([start.statusCode, start.json().error]).toEqual([404, 'not_found']);
    expect((await call('GET', `/api/v1/coach/replays/${r.id}`, asB)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/coach/replays/${r.id}/next`, asB, {})).statusCode).toBe(
      404,
    );
    expect((await call('GET', '/api/v1/coach/replays/not-a-uuid', asA)).statusCode).toBe(404);
    const list = await call('GET', '/api/v1/coach/replay-candidates', asB);
    expect(list.statusCode).toBe(200);
    expect(list.json().conversations.map((c: { id: string }) => c.id)).not.toContain(conv);
  });
});

describe('picking and starting (AC-2)', () => {
  it('lists conversations with a visitor message, with the first question and count', async () => {
    const empty = await withTenant(tdb.zone('visitor'), TENANT_B, (tx) =>
      createConversation(tx, TENANT_B, randomUUID()),
    );
    const conv = await conversation(TENANT_B, 'Do you deliver?', 'How much is delivery?');
    const res = await call('GET', '/api/v1/coach/replay-candidates', asB);
    const rows = res.json().conversations as { id: string }[];
    expect(rows.map((c) => c.id)).not.toContain(empty.id);
    expect(rows[0]).toMatchObject({
      id: conv,
      channel: 'widget',
      status: 'ai',
      firstQuestion: 'Do you deliver?',
      questions: 2,
      flagged: false,
      lastReplayId: null,
    });
    expect(res.json().nextCursor).toBeNull();
  });

  it('starts with every turn pending; 422 for a bad body or nothing to replay', async () => {
    const conv = await conversation(TENANT_A, 'How much is the chocolate fudge cake?', 'Thanks');
    const r = await replay(conv);
    expect(r.turns.map((t) => t.status)).toEqual(['pending', 'pending']);
    expect(r.totalQuestions).toBe(2);
    const bad = await call('POST', '/api/v1/coach/replays', asA, { conversationId: 'x' });
    expect([bad.statusCode, bad.json().error]).toEqual([422, 'invalid_body']);
    const empty = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, randomUUID()),
    );
    const none = await call('POST', '/api/v1/coach/replays', asA, {
      conversationId: empty.id,
      includeUnreviewed: false,
    });
    expect([none.statusCode, none.json().error]).toEqual([422, 'nothing_to_replay']);
  });
});

describe('replaying (AC-7, AC-8, AC-10, AC-11)', () => {
  it('answers one question per call within 8 s, then 409 replay_complete', async () => {
    const conv = await conversation(TENANT_A, 'How much is the chocolate fudge cake?');
    const r = await replay(conv);
    const t0 = performance.now();
    const res = await call('POST', `/api/v1/coach/replays/${r.id}/next`, asA, {});
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      remaining: 0,
      turn: {
        index: 0,
        status: 'done',
        replayed: { kind: 'replay', author: 'agent', correction: null },
        effects: [],
        factsChanged: null,
      },
    });
    expect(res.json().turn.replayed.text).toContain('$55.00');
    const done = await call('POST', `/api/v1/coach/replays/${r.id}/next`, asA, {});
    expect([done.statusCode, done.json().error]).toEqual([409, 'replay_complete']);
    const got = await call('GET', `/api/v1/coach/replays/${r.id}`, asA);
    expect(got.json().replay.turns[0].status).toBe('done');
    const list = await call('GET', '/api/v1/coach/replay-candidates', asA);
    expect(list.json().conversations.find((c: { id: string }) => c.id === conv).lastReplayId).toBe(
      r.id,
    );
  });

  it('keeps replay sessions out of the Coach chat list', async () => {
    const conv = await conversation(TENANT_A, 'How much is the chocolate fudge cake?');
    const r = await replay(conv);
    const sessions = await call('GET', '/api/v1/coach/sessions', asA);
    expect(sessions.json().sessions.map((s: { id: string }) => s.id)).not.toContain(r.id);
  });

  it('gives 404 conversation_gone once the conversation is being erased', async () => {
    const conv = await conversation(TENANT_A, 'How much is the chocolate fudge cake?');
    const r = await replay(conv);
    await owner.query(`delete from messages where conversation_id = $1`, [conv]);
    const res = await call('POST', `/api/v1/coach/replays/${r.id}/next`, asA, {});
    expect([res.statusCode, res.json().error]).toEqual([404, 'conversation_gone']);
    await owner.query(`delete from conversations where id = $1`, [conv]);
    expect((await call('GET', `/api/v1/coach/replays/${r.id}`, asA)).statusCode).toBe(404);
  });

  it('is refused with 429 after 30 replayed questions a minute for the same user', async () => {
    const limited = await testApp(tdb);
    try {
      const qs = Array.from({ length: 16 }, (_, i) => `Question ${i + 1} about the fudge cake`);
      const ids = [
        (await replay(await conversation(TENANT_A, ...qs))).id,
        (await replay(await conversation(TENANT_A, ...qs))).id,
      ];
      const next = (id: string) =>
        limited.inject({
          method: 'POST',
          url: `/api/v1/coach/replays/${id}/next`,
          headers: { cookie: asA },
          payload: {},
        });
      for (let i = 0; i < 30; i++) expect((await next(ids[i % 2]!)).statusCode).toBe(200);
      const res = await next(ids[0]!);
      expect([res.statusCode, res.json().error]).toEqual([429, 'rate_limited']);
    } finally {
      await limited.close();
    }
  });
});
