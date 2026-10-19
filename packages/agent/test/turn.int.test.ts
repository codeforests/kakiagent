import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation, messagesSince } from '@kaki/inbox';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
} from '@kaki/llm-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runVisitorTurn } from '../src/index.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await startTestDatabase();
});
afterAll(async () => tdb?.stop());

async function visitorMessage(text: string) {
  const zdb = tdb.zone('visitor');
  const visitorId = randomUUID();
  const conv = await withTenant(zdb, TENANT_A, (tx) => createConversation(tx, TENANT_A, visitorId));
  const { message } = await withTenant(zdb, TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: conv.id,
      visitorId,
      text,
      clientMessageId: randomUUID(),
    }),
  );
  return { zdb, visitorId, conversationId: conv.id, messageId: message.id };
}

describe('runVisitorTurn (walking skeleton: echo through llm-gateway)', () => {
  it('replies once, even when the turn is delivered twice (at-least-once SQS)', async () => {
    const { zdb, visitorId, conversationId, messageId } = await visitorMessage('hello');
    const llm = gatewayFromConfig({ provider: 'fake' });
    const job = { tenantId: TENANT_A, conversationId, messageId };
    const first = await runVisitorTurn({ zdb, llm }, job);
    const second = await runVisitorTurn({ zdb, llm }, job);
    expect(first?.message.body).toBe('Echo: hello');
    expect(second).toBeNull();
    const all = await withTenant(zdb, TENANT_A, (tx) =>
      messagesSince(tx, { tenantId: TENANT_A, conversationId, afterSeq: 0, visitorId }),
    );
    expect(all.map((m) => [m.author, m.body])).toEqual([
      ['visitor', 'hello'],
      ['agent', 'Echo: hello'],
    ]);
  });

  it('ignores a job whose message is missing', async () => {
    const llm = gatewayFromConfig({ provider: 'fake' });
    const res = await runVisitorTurn(
      { zdb: tdb.zone('visitor'), llm },
      { tenantId: TENANT_A, conversationId: randomUUID(), messageId: randomUUID() },
    );
    expect(res).toBeNull();
  });

  it('stores nothing when the model call fails, so the turn can be retried', async () => {
    const { zdb, visitorId, conversationId, messageId } = await visitorMessage('boom');
    const failing = createGateway(defaultRegistry('fake'), [
      createFakeProvider(() => {
        throw new Error('model unavailable');
      }),
    ]);
    await expect(
      runVisitorTurn({ zdb, llm: failing }, { tenantId: TENANT_A, conversationId, messageId }),
    ).rejects.toThrow('model unavailable');
    const all = await withTenant(zdb, TENANT_A, (tx) =>
      messagesSince(tx, { tenantId: TENANT_A, conversationId, afterSeq: 0, visitorId }),
    );
    expect(all.map((m) => m.author)).toEqual(['visitor']);
  });
});
