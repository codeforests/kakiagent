import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { signToken } from '@kaki/platform';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { testApp } from './support.js';

/**
 * FEAT-003 AC-5 (GOV-04 acceptance): identifiers a visitor types never reach the
 * database, the outbox or a published event unmasked.
 */
const VISITOR_SECRET = 'v'.repeat(32);
const ORIGIN = 'http://localhost:5175';

let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
const published: string[] = [];

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, {
    env: { VISITOR_TOKEN_SECRET: VISITOR_SECRET },
    publisher: {
      publish: async (_channel: string, payload: unknown) =>
        void published.push(JSON.stringify(payload)),
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

const RAW = ['S1234567D', '4242 4242 4242 4242', '4242424242424242', '123-456789-0', '1234567890'];
const TEXT = 'My IC is S1234567D, card 4242 4242 4242 4242, refund to DBS acct 123-456789-0';
const MASKED = 'My IC is [NRIC ••••567D], card [CARD ••••4242], refund to DBS acct [BANK ••••7890]';

const headers = () => ({
  origin: ORIGIN,
  authorization: `Bearer ${signToken(
    { t: TENANT_A, o: ORIGIN, v: randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 },
    VISITOR_SECRET,
  )}`,
});

describe('widget messages are masked at the edge (GOV-04, FEAT-003 AC-5)', () => {
  it('returns, stores and publishes only the masked text', async () => {
    const h = headers();
    const conv = await app.inject({ method: 'POST', url: '/widget/v1/conversations', headers: h });
    expect(conv.statusCode).toBe(201);
    const { conversationId } = conv.json<{ conversationId: string }>();
    const url = `/widget/v1/conversations/${conversationId}/messages`;
    const payload = { text: TEXT, clientMessageId: randomUUID() };

    const sent = await app.inject({ method: 'POST', url, headers: h, payload });
    expect(sent.statusCode).toBe(201);
    expect(sent.json<{ message: { body: string } }>().message.body).toBe(MASKED);

    // A retry returns the same stored, masked message.
    const retry = await app.inject({ method: 'POST', url, headers: h, payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ message: { body: string } }>().message.body).toBe(MASKED);

    const { rows } = await owner.query<{ body: string }>(
      'SELECT body FROM messages WHERE conversation_id = $1',
      [conversationId],
    );
    expect(rows).toEqual([{ body: MASKED }]);

    for (const table of ['messages', 'conversations', 'outbox', 'audit_entries', 'audit_pii']) {
      const { rows: all } = await owner.query<{ t: string }>(`SELECT t::text AS t FROM ${table} t`);
      const text = all.map((r) => r.t.toUpperCase()).join('\n');
      for (const raw of RAW) expect(text, `${raw} in ${table}`).not.toContain(raw);
    }
    expect(published.length).toBeGreaterThan(0);
    for (const p of published) for (const raw of RAW) expect(p).not.toContain(raw);
  });
});
