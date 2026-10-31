/** The inbox's read models on the real schema (INB-01, INB-04; FEAT-042 §5.2, AC-2–AC-4). */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAgentReply,
  appendVisitorMessage,
  BadCursorError,
  closeByStaff,
  createConversation,
  flagConversation,
  getThread,
  inboxCounts,
  intentCounts,
  listConversations,
  sidebarFacts,
  threadEvents,
  visitorHistory,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';
const FACT = '00000000-0000-4000-8000-0000000000f1';
const FACT2 = '00000000-0000-4000-8000-0000000000f2';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = () => tdb.zone('dashboard');
const visitor = () => tdb.zone('visitor');

async function conversationWithTurn(tenantId: string, visitorId = randomUUID()) {
  const conv = await withTenant(visitor(), tenantId, (tx) =>
    createConversation(tx, tenantId, visitorId),
  );
  const { message } = await withTenant(visitor(), tenantId, (tx) =>
    appendVisitorMessage(tx, {
      tenantId,
      conversationId: conv.id,
      visitorId,
      text: 'how much is the fudge cake?',
      clientMessageId: `c-${randomUUID()}`,
    }),
  );
  return { id: conv.id, visitorId, messageId: message.id };
}

describe('views and pagination (AC-2, AC-3)', () => {
  // Tenant B holds only this block's conversations.
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    for (let i = 0; i < 30; i++) {
      const c = await conversationWithTurn(TENANT_B);
      // Same timestamp for pairs, so the id tie-breaker is exercised.
      await owner.query(
        `update conversations set last_message_at = timestamptz '2026-10-01 10:00:00.123456+00' + make_interval(mins => $2) where id = $1`,
        [c.id, Math.floor(i / 2)],
      );
      ids[`c${i}`] = c.id;
    }
    await owner.query(`update conversations set status = 'escalated' where id = any($1::uuid[])`, [
      [ids.c0, ids.c1],
    ]);
    await owner.query(`update conversations set status = 'waiting_approval' where id = $1`, [
      ids.c2,
    ]);
    await withTenant(dash(), TENANT_B, (tx) =>
      closeByStaff(tx, { tenantId: TENANT_B, conversationId: ids.c3!, userId: USER, version: 0 }),
    );
    await withTenant(visitor(), TENANT_B, (tx) =>
      flagConversation(tx, TENANT_B, ids.c3!, 'crisis'),
    );
  });

  const all = async (view: 'open' | 'escalated' | 'approval' | 'flagged' | 'closed', limit = 7) => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await withTenant(dash(), TENANT_B, (tx) =>
        listConversations(tx, TENANT_B, { view, cursor, limit }),
      );
      seen.push(...page.conversations.map((c) => c.id));
      if (!page.nextCursor) return seen;
      cursor = page.nextCursor;
    }
  };

  it('pages through a view newest first with no duplicates or gaps', async () => {
    const open = await all('open');
    expect(open).toHaveLength(29);
    expect(new Set(open).size).toBe(29);
    const order = await owner.query(
      `select id from conversations where tenant_id = $1 and status <> 'closed' order by last_message_at desc, id desc`,
      [TENANT_B],
    );
    expect(open).toEqual(order.rows.map((r) => r.id));
  });

  it('each view returns exactly its conversations, and the counts match', async () => {
    expect((await all('escalated')).sort()).toEqual([ids.c0, ids.c1].sort());
    expect(await all('approval')).toEqual([ids.c2]);
    expect(await all('closed')).toEqual([ids.c3]);
    expect(await all('flagged')).toEqual([ids.c3]);
    const counts = await withTenant(dash(), TENANT_B, (tx) => inboxCounts(tx, TENANT_B));
    expect(counts).toEqual({ open: 29, escalated: 2, approval: 1, flagged: 1 });
    const page = await withTenant(dash(), TENANT_B, (tx) =>
      listConversations(tx, TENANT_B, { view: 'closed', channel: 'widget', limit: 25 }),
    );
    expect(page.conversations[0]).toMatchObject({
      id: ids.c3,
      status: 'closed',
      closeReason: 'staff',
      lastMessage: 'how much is the fudge cake?',
      flagReasons: ['crisis'],
    });
  });

  it('refuses a malformed cursor, and tenant A sees none of these', async () => {
    await expect(
      withTenant(dash(), TENANT_B, (tx) =>
        listConversations(tx, TENANT_B, { view: 'open', cursor: 'nope', limit: 5 }),
      ),
    ).rejects.toBeInstanceOf(BadCursorError);
    const a = await withTenant(dash(), TENANT_A, (tx) =>
      listConversations(tx, TENANT_A, { view: 'open', limit: 50 }),
    );
    expect(a.conversations.map((c) => c.id)).not.toContain(ids.c5);
  });
});

describe('the thread and sidebar (AC-4, AC-8)', () => {
  it('returns messages with fact IDs, state and flag events, facts, intents and history', async () => {
    const visitorId = randomUUID();
    const earlier = await conversationWithTurn(TENANT_A, visitorId);
    const c = await conversationWithTurn(TENANT_A, visitorId);
    await withTenant(visitor(), TENANT_A, async (tx) => {
      await appendAgentReply(tx, {
        tenantId: TENANT_A,
        conversationId: c.id,
        inReplyTo: c.messageId,
        text: 'It is S$55.',
        factIds: [FACT, FACT2],
        taskKinds: ['answer', 'capture_lead', 'answer'],
      });
      await flagConversation(tx, TENANT_A, c.id, 'crisis');
    });
    const second = await withTenant(visitor(), TENANT_A, (tx) =>
      appendVisitorMessage(tx, {
        tenantId: TENANT_A,
        conversationId: c.id,
        visitorId,
        text: 'and delivery?',
        clientMessageId: `c-${randomUUID()}`,
      }),
    );
    await withTenant(visitor(), TENANT_A, (tx) =>
      appendAgentReply(tx, {
        tenantId: TENANT_A,
        conversationId: c.id,
        inReplyTo: second.message.id,
        text: 'We deliver.',
        factIds: [FACT],
        taskKinds: ['answer', 'withdraw_consent', 'data_request', 'correct'],
      }),
    );
    await withTenant(dash(), TENANT_A, (tx) =>
      closeByStaff(tx, { tenantId: TENANT_A, conversationId: c.id, userId: USER, version: 0 }),
    );

    const out = await withTenant(dash(), TENANT_A, async (tx) => ({
      thread: await getThread(tx, TENANT_A, c.id),
      page: await getThread(tx, TENANT_A, c.id, { limit: 2 }),
      events: await threadEvents(tx, TENANT_A, c.id),
      facts: await sidebarFacts(tx, TENANT_A, c.id),
      intents: await intentCounts(tx, TENANT_A, c.id),
      history: await visitorHistory(tx, TENANT_A, c.id),
      firstHistory: await visitorHistory(tx, TENANT_A, earlier.id),
    }));
    expect(out.thread.hasEarlier).toBe(false);
    expect(out.thread.messages.map((m) => [m.author, m.factIds])).toEqual([
      ['visitor', []],
      ['agent', [FACT, FACT2]],
      ['visitor', []],
      ['agent', [FACT]],
    ]);
    expect(out.page.hasEarlier).toBe(true);
    expect(out.page.messages.map((m) => m.body)).toEqual(['and delivery?', 'We deliver.']);
    const older = await withTenant(dash(), TENANT_A, (tx) =>
      getThread(tx, TENANT_A, c.id, { before: out.page.messages[0]!.seq, limit: 2 }),
    );
    expect(older.messages.map((m) => m.author)).toEqual(['visitor', 'agent']);
    expect(older.hasEarlier).toBe(false);

    expect(out.events.map(({ at: _at, ...e }) => e)).toEqual([
      {
        kind: 'flagged',
        from: null,
        to: null,
        reason: 'crisis',
        actor: { type: 'agent', id: null },
      },
      {
        kind: 'state',
        from: 'ai',
        to: 'closed',
        reason: 'staff',
        actor: { type: 'user', id: USER },
      },
    ]);
    expect(out.facts).toEqual([
      { factId: FACT, uses: 2 },
      { factId: FACT2, uses: 1 },
    ]);
    expect(out.intents).toEqual([
      { signal: 'asked_questions', count: 2 },
      { signal: 'privacy_request', count: 2 },
      { signal: 'left_details', count: 1 },
    ]);
    expect(out.history).toMatchObject({ previousConversations: 1 });
    expect(out.firstHistory).toMatchObject({ previousConversations: 0 });
    expect(out.history!.firstSeenAt.getTime()).toBe(out.firstHistory!.firstSeenAt.getTime());

    // Tenant B sees nothing of it.
    const fromB = await withTenant(dash(), TENANT_B, async (tx) => ({
      thread: await getThread(tx, TENANT_B, c.id),
      events: await threadEvents(tx, TENANT_B, c.id),
      history: await visitorHistory(tx, TENANT_B, c.id),
    }));
    expect(fromB).toEqual({
      thread: { messages: [], hasEarlier: false },
      events: [],
      history: null,
    });
  });
});
