import { randomUUID } from 'node:crypto';
import { schema, sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAgentReply,
  appendVisitorMessage,
  createConversation,
  getMessage,
  listConversations,
  messagesSince,
  NotFoundError,
  toMessage,
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
      `select action from audit_events where tenant_id = $1 order by seq`,
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
});
