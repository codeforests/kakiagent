import { randomUUID } from 'node:crypto';
import { schema, sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAgentReply,
  appendVisitorMessage,
  createConversation,
  endAiConversation,
  flagConversation,
  getConversation,
  getMessage,
  listConversations,
  messagesSince,
  messagesUpTo,
  NotFoundError,
  pastQuestionsUsing,
  recordAbuse,
  toMessage,
  toSummary,
} from '../src/index.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await startTestDatabase();
});
afterAll(async () => tdb?.stop());

describe('inbox repository (visitor trust zone)', () => {
  it('stores a visitor message with its outbox row and audit event in one transaction', async () => {
    const visitor = tdb.zone('visitor');
    const visitorId = randomUUID();
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, visitorId),
    );
    const res = await withTenant(visitor, TENANT_A, (tx) =>
      appendVisitorMessage(tx, {
        tenantId: TENANT_A,
        conversationId: conv.id,
        visitorId,
        text: 'hello',
        clientMessageId: 'c-000001',
      }),
    );
    expect(res.created).toBe(true);
    expect(toMessage(res.message)).toMatchObject({
      author: 'visitor',
      body: 'hello',
      conversationId: conv.id,
    });

    // Outbox and audit rows are invisible to the visitor role; read as the owner.
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: tdb.ownerUrl });
    await c.connect();
    const outbox = await c.query(
      `select topic, group_key, payload from outbox where tenant_id = $1`,
      [TENANT_A],
    );
    expect(outbox.rows).toEqual([
      {
        topic: 'conversation-turns',
        group_key: conv.id,
        payload: { tenantId: TENANT_A, conversationId: conv.id, messageId: res.message.id },
      },
    ]);
    const audit = await c.query(
      `select event_type as action from audit_entries where tenant_id = $1 order by seq`,
      [TENANT_A],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['conversation.started', 'message.received']);
    await c.end();
  });

  it('is idempotent on clientMessageId', async () => {
    const visitor = tdb.zone('visitor');
    const visitorId = randomUUID();
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, visitorId),
    );
    const input = {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId,
      text: 'twice',
      clientMessageId: 'c-000002',
    };
    const first = await withTenant(visitor, TENANT_A, (tx) => appendVisitorMessage(tx, input));
    const again = await withTenant(visitor, TENANT_A, (tx) => appendVisitorMessage(tx, input));
    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
  });

  it("refuses another visitor's conversation", async () => {
    const visitor = tdb.zone('visitor');
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, randomUUID()),
    );
    await expect(
      withTenant(visitor, TENANT_A, (tx) =>
        appendVisitorMessage(tx, {
          tenantId: TENANT_A,
          conversationId: conv.id,
          visitorId: randomUUID(),
          text: 'x',
          clientMessageId: 'c-000003',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('stores one agent reply per visitor message and resumes by sequence', async () => {
    const visitor = tdb.zone('visitor');
    const visitorId = randomUUID();
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, visitorId),
    );
    const { message } = await withTenant(visitor, TENANT_A, (tx) =>
      appendVisitorMessage(tx, {
        tenantId: TENANT_A,
        conversationId: conv.id,
        visitorId,
        text: 'q',
        clientMessageId: 'c-000004',
      }),
    );
    const reply = { tenantId: TENANT_A, conversationId: conv.id, inReplyTo: message.id, text: 'a' };
    const first = await withTenant(visitor, TENANT_A, (tx) => appendAgentReply(tx, reply));
    const second = await withTenant(visitor, TENANT_A, (tx) => appendAgentReply(tx, reply));
    expect(first?.message.author).toBe('agent');
    expect(second).toBeNull();

    const all = await withTenant(visitor, TENANT_A, (tx) =>
      messagesSince(tx, { tenantId: TENANT_A, conversationId: conv.id, afterSeq: 0, visitorId }),
    );
    expect(all.map((m) => m.author)).toEqual(['visitor', 'agent']);
    const after = await withTenant(visitor, TENANT_A, (tx) =>
      messagesSince(tx, { tenantId: TENANT_A, conversationId: conv.id, afterSeq: all[0]!.seq }),
    );
    expect(after.map((m) => m.id)).toEqual([first!.message.id]);
    expect(
      await withTenant(visitor, TENANT_A, (tx) => getMessage(tx, TENANT_A, message.id)),
    ).toMatchObject({ id: message.id });
    expect(
      await withTenant(visitor, TENANT_B, (tx) => getMessage(tx, TENANT_B, message.id)),
    ).toBeNull();
  });

  it('lists conversations with the latest message for the dashboard, per tenant', async () => {
    const list = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      listConversations(tx, TENANT_A),
    );
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some((c) => c.lastMessage === 'a')).toBe(true);
    const other = await withTenant(tdb.zone('dashboard'), TENANT_B, (tx) =>
      listConversations(tx, TENANT_B),
    );
    expect(other).toEqual([]);
    const count = await withTenant(tdb.zone('dashboard'), TENANT_B, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(schema.messages),
    );
    expect(count[0]!.n).toBe(0);
  });

  it('flags a conversation once per reason, audited once, and lists the flags (FEAT-025)', async () => {
    const visitor = tdb.zone('visitor');
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, randomUUID()),
    );
    const flag = (reason: 'abuse' | 'crisis') =>
      withTenant(visitor, TENANT_A, (tx) => flagConversation(tx, TENANT_A, conv.id, reason));
    const first = await flag('crisis');
    const again = await flag('crisis');
    const both = await flag('abuse');
    expect(first?.flagReasons).toEqual(['crisis']);
    expect(again?.flaggedAt?.toISOString()).toBe(first?.flaggedAt?.toISOString());
    expect(both?.flagReasons).toEqual(['crisis', 'abuse']);
    expect(toSummary(both!, null)).toMatchObject({
      flaggedAt: first!.flaggedAt!.toISOString(),
      flagReasons: ['crisis', 'abuse'],
    });
    const listed = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      listConversations(tx, TENANT_A),
    );
    expect(listed.find((c) => c.id === conv.id)?.flagReasons).toEqual(['crisis', 'abuse']);
    // Another tenant's context can't flag it.
    expect(
      await withTenant(visitor, TENANT_B, (tx) => flagConversation(tx, TENANT_B, conv.id, 'abuse')),
    ).toBeNull();

    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: tdb.ownerUrl });
    await c.connect();
    const audit = await c.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'conversation.flagged' and split_part(subject_refs[1], ':', 2) = $2 order by seq`,
      [TENANT_A, conv.id],
    );
    await c.end();
    expect(audit.rows.map((r) => r.payload)).toEqual([{ reason: 'crisis' }, { reason: 'abuse' }]);
  });

  it('counts distinct abuse turns and ends the AI once (FEAT-025 D2)', async () => {
    const visitor = tdb.zone('visitor');
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, randomUUID()),
    );
    const turn1 = randomUUID();
    const count = (turn: string) =>
      withTenant(visitor, TENANT_A, (tx) => recordAbuse(tx, TENANT_A, conv.id, turn));
    expect(await count(turn1)).toBe(1);
    expect(await count(turn1)).toBe(1);
    expect(await count(randomUUID())).toBe(2);
    const end = () =>
      withTenant(visitor, TENANT_A, (tx) => endAiConversation(tx, TENANT_A, conv.id, 'abuse'));
    expect(await end()).toBe(true);
    expect(await end()).toBe(false);
    expect(
      (await withTenant(visitor, TENANT_A, (tx) => getConversation(tx, TENANT_A, conv.id)))?.status,
    ).toBe('closed');
    await expect(
      withTenant(visitor, TENANT_B, (tx) => recordAbuse(tx, TENANT_B, conv.id, turn1)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('finds past questions whose reply used a fact, newest first, before a time (FEAT-018 D4)', async () => {
    const visitor = tdb.zone('visitor');
    const fact = randomUUID();
    const other = randomUUID();
    const asked: string[] = [];
    let conversationId = '';
    for (let i = 0; i < 4; i++) {
      const visitorId = randomUUID();
      const conv = await withTenant(visitor, TENANT_A, (tx) =>
        createConversation(tx, TENANT_A, visitorId),
      );
      conversationId = conv.id;
      const { message } = await withTenant(visitor, TENANT_A, (tx) =>
        appendVisitorMessage(tx, {
          tenantId: TENANT_A,
          conversationId: conv.id,
          visitorId,
          text: `q${i}`,
          clientMessageId: `c-pq-00${i}`,
        }),
      );
      await withTenant(visitor, TENANT_A, (tx) =>
        appendAgentReply(tx, {
          tenantId: TENANT_A,
          conversationId: conv.id,
          inReplyTo: message.id,
          text: `a${i}`,
          // The third reply cited another fact only.
          factIds: i === 2 ? [other] : [fact],
        }),
      );
      asked.push(message.id);
    }
    const before = new Date(Date.now() + 1000);
    const found = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      pastQuestionsUsing(tx, { tenantId: TENANT_A, factIds: [fact], before, limit: 2 }),
    );
    expect(found.matched).toBe(3);
    expect(found.questions.map((q) => q.messageId)).toEqual([asked[3], asked[1]]);
    expect(found.questions[0]!.conversationId).toBe(conversationId);
    const earlier = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      pastQuestionsUsing(tx, {
        tenantId: TENANT_A,
        factIds: [fact],
        before: new Date(0),
        limit: 20,
      }),
    );
    expect(earlier).toEqual({ questions: [], matched: 0 });
    expect(
      await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        pastQuestionsUsing(tx, { tenantId: TENANT_A, factIds: [], before, limit: 20 }),
      ),
    ).toEqual({ questions: [], matched: 0 });
    expect(
      (
        await withTenant(tdb.zone('dashboard'), TENANT_B, (tx) =>
          pastQuestionsUsing(tx, { tenantId: TENANT_B, factIds: [fact], before, limit: 20 }),
        )
      ).matched,
    ).toBe(0);

    const excerpt = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      messagesUpTo(tx, { tenantId: TENANT_A, conversationId, upTo: before, limit: 1 }),
    );
    expect(excerpt.map((m) => m.body)).toEqual(['a3']);
    const both = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      messagesUpTo(tx, { tenantId: TENANT_A, conversationId, upTo: before, limit: 5 }),
    );
    expect(both.map((m) => m.body)).toEqual(['q3', 'a3']);
  });
});
