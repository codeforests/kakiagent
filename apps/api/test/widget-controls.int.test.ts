import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { signToken } from '@kaki/platform';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { testApp } from './support.js';

/**
 * FEAT-033 §3 (CHN-13, UC-20 8): the visitor ends their chat; a closed chat refuses new
 * messages (D5).
 */
const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
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
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});

const headers = (tenant = TENANT_A, visitorId = randomUUID(), origin = ORIGIN) => ({
  origin,
  authorization: `Bearer ${signToken(
    { t: tenant, o: ORIGIN, v: visitorId, exp: Math.floor(Date.now() / 1000) + 600 },
    VISITOR_SECRET,
  )}`,
});

async function startChat(h: Record<string, string>) {
  const conv = await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers: h });
  expect(conv.statusCode).toBe(201);
  const { conversationId } = conv.json<{ conversationId: string }>();
  const sent = await app.inject({
    method: 'POST',
    url: `/widget/v1/conversations/${conversationId}/messages`,
    headers: h,
    payload: { text: 'Do you deliver on Sundays?', clientMessageId: 'c-ended-01' },
  });
  expect(sent.statusCode).toBe(201);
  return conversationId;
}

const end = (id: string, h: Record<string, string>) =>
  app.inject({ method: 'POST', url: `/widget/v1/conversations/${id}/end`, headers: h });

describe('POST /widget/v1/conversations/:id/end (FEAT-033 AC-1, AC-3)', () => {
  it('closes the chat once: 200 twice, one audit row, one inbox notify', async () => {
    const h = headers();
    const id = await startChat(h);
    published.length = 0;
    for (let i = 0; i < 2; i++) {
      const res = await end(id, h);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'closed' });
    }
    const { rows } = await owner.query(`select status from conversations where id = $1`, [id]);
    expect(rows).toEqual([{ status: 'closed' }]);
    const audits = await owner.query(
      `select count(*)::int as n from audit_entries
        where event_type = 'conversation.visitor_ended' and $1 = any(subject_refs)`,
      [`conversation:${id}`],
    );
    expect(audits.rows[0].n).toBe(1);
    expect(published).toEqual([
      {
        channel: expect.stringContaining(TENANT_A),
        payload: {
          type: 'conversation',
          conversation: expect.objectContaining({
            id,
            status: 'closed',
            lastMessage: 'Do you deliver on Sundays?',
          }),
        },
      },
    ]);
  });

  it("is 404 for another visitor's or tenant's token and a malformed id, 401 on a wrong origin", async () => {
    const h = headers();
    const id = await startChat(h);
    expect((await end(id, headers())).statusCode).toBe(404);
    expect((await end(id, headers(TENANT_B))).statusCode).toBe(404);
    expect((await end('not-a-uuid', h)).statusCode).toBe(404);
    expect((await end(id, { ...h, origin: 'https://evil.test' })).statusCode).toBe(401);
    const { rows } = await owner.query(`select status from conversations where id = $1`, [id]);
    expect(rows).toEqual([{ status: 'ai' }]);
  });
});

describe('a closed chat refuses new messages (FEAT-033 D5, AC-3)', () => {
  it('answers 409 chat_ended and stores nothing; a retry of a stored message is 200', async () => {
    const h = headers();
    const id = await startChat(h);
    expect((await end(id, h)).statusCode).toBe(200);
    const url = `/widget/v1/conversations/${id}/messages`;
    const retry = await app.inject({
      method: 'POST',
      url,
      headers: h,
      payload: { text: 'Do you deliver on Sundays?', clientMessageId: 'c-ended-01' },
    });
    expect(retry.statusCode).toBe(200);
    const late = await app.inject({
      method: 'POST',
      url,
      headers: h,
      payload: { text: 'hello?', clientMessageId: 'c-ended-02' },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: 'chat_ended', message: 'This chat has ended.' });
    const { rows } = await owner.query(
      `select count(*)::int as n from messages where conversation_id = $1`,
      [id],
    );
    expect(rows[0].n).toBe(1);
  });
});
