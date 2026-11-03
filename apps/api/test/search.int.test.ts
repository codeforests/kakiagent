/**
 * Conversation search route (INB-11; FEAT-046 §3, §5.2; AC-1, AC-3, AC-5, AC-6): results
 * for every role, the 400s, tenant isolation, and the query text kept out of the logs.
 */
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { createLogger } from '@kaki/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { sessionCookie, testApp } from './support.js';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let cookieA: string;
let cookieB: string;
let agentA: string;
const logLines: string[] = [];

const EMAIL = 'mei.search.zq@example.com';
const TOKEN = 'zqsearchtoken';

async function conversation(tenantId: string, bodies: string[], status = 'ai') {
  const { rows } = await owner.query<{ id: string }>(
    `insert into conversations (tenant_id, channel, visitor_id, status, closed_at, close_reason)
     values ($1, 'widget', gen_random_uuid(), $2, $3, $4) returning id`,
    [
      tenantId,
      status,
      status === 'closed' ? new Date() : null,
      status === 'closed' ? 'staff' : null,
    ],
  );
  const id = rows[0]!.id;
  for (const body of bodies)
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body) values ($1, $2, 'visitor', $3)`,
      [tenantId, id, body],
    );
  return id;
}

const search = (cookie: string | null, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/conversations/search',
    headers: cookie ? { cookie } : {},
    payload: payload as Record<string, unknown>,
  });

let convA: string;
let closedA: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    logger: createLogger('api-test', 'debug', { write: (s: string) => void logLines.push(s) }),
  });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  cookieA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  cookieB = await sessionCookie(tdb, 'owner@second-tenant.test');
  const agentId = (
    await owner.query<{ id: string }>(
      `insert into users (email) values ('agent@search.test') returning id`,
    )
  ).rows[0]!.id;
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    agentId,
  ]);
  agentA = await sessionCookie(tdb, 'agent@search.test');
  convA = await conversation(TENANT_A, [`Hi, I'm Mei, ${EMAIL}, ref ${TOKEN}`]);
  closedA = await conversation(TENANT_A, [`old chat about ${TOKEN}`], 'closed');
  await conversation(TENANT_B, [`tenant b also says ${TOKEN} and ${EMAIL}`]);
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('POST /api/v1/conversations/search (AC-1, AC-3)', () => {
  it('returns summaries with marked excerpts for the owner and the agent role', async () => {
    for (const cookie of [cookieA, agentA]) {
      const res = await search(cookie, { q: TOKEN.toUpperCase() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.nextCursor).toBeNull();
      expect(
        body.results.map((r: { conversation: { id: string } }) => r.conversation.id).sort(),
      ).toEqual([convA, closedA].sort());
      const hit = body.results.find(
        (r: { conversation: { id: string } }) => r.conversation.id === convA,
      );
      const { excerpt, ranges } = hit.match;
      expect(excerpt.slice(ranges[0].start, ranges[0].end)).toBe(TOKEN);
      expect(hit.match.author).toBe('visitor');
      expect(hit.conversation.status).toBe('ai');
    }
  });

  it('finds an email by part of it and pages by cursor', async () => {
    const res = await search(cookieA, { q: 'search.zq@', limit: 1 });
    expect(
      res.json().results.map((r: { conversation: { id: string } }) => r.conversation.id),
    ).toEqual([convA]);
    const first = await search(cookieA, { q: TOKEN, limit: 1 });
    const next = first.json().nextCursor as string;
    expect(next).toBeTruthy();
    const second = await search(cookieA, { q: TOKEN, limit: 1, cursor: next });
    expect(second.statusCode).toBe(200);
    expect(second.json().results).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
    expect(second.json().results[0].conversation.id).not.toBe(
      first.json().results[0].conversation.id,
    );
  });

  it("tenant B's session finds nothing of tenant A's", async () => {
    const res = await search(cookieB, { q: TOKEN });
    expect(res.statusCode).toBe(200);
    const ids = res.json().results.map((r: { conversation: { id: string } }) => r.conversation.id);
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain(convA);
    expect(ids).not.toContain(closedA);
  });
});

describe('refusals (AC-6)', () => {
  it('401 without a session', async () => {
    expect((await search(null, { q: TOKEN })).statusCode).toBe(401);
  });

  it('400 for a short, long or extra-key body', async () => {
    for (const payload of [
      { q: 'a' },
      { q: 'x'.repeat(101) },
      { q: TOKEN, tenantId: TENANT_B },
      { q: TOKEN, limit: 0 },
      {},
    ]) {
      const res = await search(cookieA, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
      expect(res.json().error).toBe('bad_request');
    }
  });

  it('bad_request for a query that collapses below 2 characters, and bad_cursor', async () => {
    // Zod collapses the same whitespace `searchTerms` does, and masking only lengthens text,
    // so `query_too_short` is a guard the route keeps but HTTP can't reach today (inbox
    // unit and integration tests cover QueryTooShortError).
    const short = await search(cookieA, { q: ' \u00a0x\u00a0 ' });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toBe('bad_request');
    const cursor = await search(cookieA, { q: TOKEN, cursor: 'not-a-cursor' });
    expect(cursor.statusCode).toBe(400);
    expect(cursor.json().error).toBe('bad_cursor');
  });
});

describe('the query text stays out of logs (AC-5)', () => {
  it('logs the request but neither the query nor an email from it', async () => {
    logLines.length = 0;
    await search(cookieA, { q: EMAIL });
    await search(cookieA, { q: `${TOKEN} ${EMAIL}`, cursor: 'nope' });
    await search(cookieA, { q: 'y', note: EMAIL });
    const all = logLines.join('\n');
    expect(all).toContain('/api/v1/conversations/search');
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain('search.zq');
    expect(all).not.toContain(TOKEN);
  });
});
