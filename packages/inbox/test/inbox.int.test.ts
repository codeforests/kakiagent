import { randomUUID } from 'node:crypto';
import { schema, sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAgentReply,
  appendVisitorMessage,
  createConversation,
  ConversationClosedError,
  endAiConversation,
  endVisitorConversation,
  flagConversation,
  gapCounts,
  gapQuestions,
  getConversation,
  getMessage,
  listConversations,
  markQuestionGap,
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

  it('marks a visitor question as a gap once, and reads gap questions and counts per item (FEAT-019)', async () => {
    const visitor = tdb.zone('visitor');
    const vec = [1, ...new Array<number>(1023).fill(0)];
    const ask = async (text: string, n: number) => {
      const visitorId = randomUUID();
      const conv = await withTenant(visitor, TENANT_B, (tx) =>
        createConversation(tx, TENANT_B, visitorId),
      );
      const { message } = await withTenant(visitor, TENANT_B, (tx) =>
        appendVisitorMessage(tx, {
          tenantId: TENANT_B,
          conversationId: conv.id,
          visitorId,
          text,
          clientMessageId: `c-gap-00${n}`,
        }),
      );
      return message;
    };
    const first = await ask('Do you have parking? NRIC S1234567D', 1);
    const second = await ask('Is there parking nearby?', 2);
    const mark = (messageId: string, reason: 'unavailable' | 'unsure' | 'escalated') =>
      withTenant(visitor, TENANT_B, (tx) =>
        markQuestionGap(tx, { tenantId: TENANT_B, messageId, reason, embedding: vec }),
      );
    expect(await mark(first.id, 'unavailable')).toBe(true);
    expect(await mark(first.id, 'escalated')).toBe(false);
    expect(await mark(second.id, 'unsure')).toBe(true);
    // Agent replies are never marked.
    const reply = await withTenant(visitor, TENANT_B, (tx) =>
      appendAgentReply(tx, {
        tenantId: TENANT_B,
        conversationId: first.conversationId,
        inReplyTo: first.id,
        text: 'a',
        factIds: [],
      }),
    );
    expect(await mark(reply!.message.id, 'unsure')).toBe(false);

    // File both under one item, as kb_gap_cluster() would, and read them back.
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: tdb.ownerUrl });
    await c.connect();
    const item = await c.query(
      `insert into corrections (tenant_id, source_type, proposed_by, proposed_change)
       values ($1, 'coverage_gap', 'system', '{"kind":"answer_gap"}') returning id`,
      [TENANT_B],
    );
    const id = item.rows[0].id as string;
    await c.query(
      `update messages set gap_correction_id = $1, created_at = now() - interval '40 days' where id = $2`,
      [id, first.id],
    );
    await c.query(`update messages set gap_correction_id = $1 where id = $2`, [id, second.id]);
    const stored = await c.query(`select gap_reason from messages where id = $1`, [first.id]);
    await c.end();
    expect(stored.rows[0].gap_reason).toBe('unavailable');

    const dashboard = tdb.zone('dashboard');
    const questions = await withTenant(dashboard, TENANT_B, (tx) =>
      gapQuestions(tx, TENANT_B, [id, randomUUID()], { perItem: 1 }),
    );
    expect([...questions.keys()]).toEqual([id]);
    expect(questions.get(id)).toEqual([
      {
        messageId: second.id,
        conversationId: second.conversationId,
        body: 'Is there parking nearby?',
        askedAt: expect.any(Date),
        reason: 'unsure',
      },
    ]);
    const all = await withTenant(dashboard, TENANT_B, (tx) =>
      gapQuestions(tx, TENANT_B, [id], { perItem: 5 }),
    );
    expect(all.get(id)!.map((q) => q.messageId)).toEqual([second.id, first.id]);
    expect(all.get(id)![1]!.body).not.toContain('S1234567D');
    const counts = await withTenant(dashboard, TENANT_B, (tx) =>
      gapCounts(tx, TENANT_B, [id], new Date(Date.now() - 30 * 86_400_000)),
    );
    expect(counts.get(id)).toMatchObject({
      asksSince: 1,
      asksTotal: 2,
      reasons: ['unavailable', 'unsure'],
    });
    expect(counts.get(id)!.firstAskedAt.getTime()).toBeLessThan(
      counts.get(id)!.lastAskedAt.getTime(),
    );
    // Tenant A sees none of tenant B's gaps.
    expect(
      (
        await withTenant(dashboard, TENANT_A, (tx) =>
          gapQuestions(tx, TENANT_A, [id], { perItem: 5 }),
        )
      ).size,
    ).toBe(0);
    expect(
      await withTenant(dashboard, TENANT_B, (tx) => gapCounts(tx, TENANT_B, [], new Date())),
    ).toEqual(new Map());
  });
});

describe('visitor ends the chat (FEAT-033 §5.1)', () => {
  const owner = async <T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> => {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: tdb.ownerUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const endedAudits = (conversationId: string) =>
    owner(async (c) => {
      const r = await c.query(
        `select actor_type, actor_ref, payload from audit_entries
          where tenant_id = $1 and event_type = 'conversation.visitor_ended' and $2 = any(subject_refs)`,
        [TENANT_A, `conversation:${conversationId}`],
      );
      return r.rows;
    });

  it.each(['ai', 'human'] as const)(
    'closes a conversation from %s once, audited once with no text',
    async (from) => {
      const visitor = tdb.zone('visitor');
      const visitorId = randomUUID();
      const conv = await withTenant(visitor, TENANT_A, (tx) =>
        createConversation(tx, TENANT_A, visitorId),
      );
      if (from === 'human')
        await owner((c) =>
          c.query(`update conversations set status = 'human' where id = $1`, [conv.id]),
        );
      const end = () =>
        withTenant(visitor, TENANT_A, (tx) =>
          endVisitorConversation(tx, { tenantId: TENANT_A, conversationId: conv.id, visitorId }),
        );
      const first = await end();
      expect(first.ended).toBe(true);
      expect(first.conversation.status).toBe('closed');
      const again = await end();
      expect(again.ended).toBe(false);
      expect(again.conversation.status).toBe('closed');
      expect(await endedAudits(conv.id)).toEqual([
        { actor_type: 'visitor', actor_ref: visitorId, payload: {} },
      ]);
    },
  );

  it("refuses another visitor's and another tenant's conversation", async () => {
    const visitor = tdb.zone('visitor');
    const visitorId = randomUUID();
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, visitorId),
    );
    await expect(
      withTenant(visitor, TENANT_A, (tx) =>
        endVisitorConversation(tx, {
          tenantId: TENANT_A,
          conversationId: conv.id,
          visitorId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      withTenant(visitor, TENANT_B, (tx) =>
        endVisitorConversation(tx, { tenantId: TENANT_B, conversationId: conv.id, visitorId }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await withTenant(visitor, TENANT_A, (tx) => getConversation(tx, TENANT_A, conv.id)))?.status,
    ).toBe('ai');
  });

  it('refuses a new message to a closed conversation but returns a retried one (D5)', async () => {
    const visitor = tdb.zone('visitor');
    const visitorId = randomUUID();
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, visitorId),
    );
    const send = (clientMessageId: string) =>
      withTenant(visitor, TENANT_A, (tx) =>
        appendVisitorMessage(tx, {
          tenantId: TENANT_A,
          conversationId: conv.id,
          visitorId,
          text: 'hello',
          clientMessageId,
        }),
      );
    const first = await send('c-033001');
    await withTenant(visitor, TENANT_A, (tx) =>
      endVisitorConversation(tx, { tenantId: TENANT_A, conversationId: conv.id, visitorId }),
    );
    const retry = await send('c-033001');
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(first.message.id);
    await expect(send('c-033002')).rejects.toBeInstanceOf(ConversationClosedError);
    const count = await owner(
      async (c) =>
        (
          await c.query(`select count(*)::int as n from messages where conversation_id = $1`, [
            conv.id,
          ])
        ).rows[0].n,
    );
    expect(count).toBe(1);
  });

  it("stores a reply's language and rejects one outside en/zh (D3)", async () => {
    const visitor = tdb.zone('visitor');
    const visitorId = randomUUID();
    const conv = await withTenant(visitor, TENANT_A, (tx) =>
      createConversation(tx, TENANT_A, visitorId),
    );
    const asked = await withTenant(visitor, TENANT_A, (tx) =>
      appendVisitorMessage(tx, {
        tenantId: TENANT_A,
        conversationId: conv.id,
        visitorId,
        text: '你们几点开门?',
        clientMessageId: 'c-033003',
      }),
    );
    expect(toMessage(asked.message).language).toBe(null);
    const reply = await withTenant(visitor, TENANT_A, (tx) =>
      appendAgentReply(tx, {
        tenantId: TENANT_A,
        conversationId: conv.id,
        inReplyTo: asked.message.id,
        text: '我们早上九点开门。',
        language: 'zh',
      }),
    );
    expect(toMessage(reply!.message).language).toBe('zh');
    await expect(
      owner((c) =>
        c.query(`update messages set language = 'fr' where id = $1`, [reply!.message.id]),
      ),
    ).rejects.toThrow(/messages_language_ck/);
  });
});
