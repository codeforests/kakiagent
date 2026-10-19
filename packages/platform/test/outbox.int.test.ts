import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createDispatcher, enqueue } from '../src/outbox.js';
import type { QueueClient } from '../src/queue.js';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await startTestDatabase();
});
afterAll(async () => tdb?.stop());

function fakeQueue(failTimes = 0) {
  const sent: { url: string; id: string; groupId?: string | undefined; body: unknown }[] = [];
  let failures = failTimes;
  const queue = {
    async send(url: string, msg: { id: string; groupId?: string; body: unknown }) {
      if (failures-- > 0) throw new Error('sqs down');
      sent.push({ url, ...msg });
    },
  } as unknown as QueueClient;
  return { queue, sent };
}

describe('transactional outbox (ADR-012)', () => {
  it('dispatches committed rows from every tenant once, and never rolled-back ones', async () => {
    const visitor = tdb.zone('visitor');
    const a = await withTenant(visitor, TENANT_A, (tx) =>
      enqueue(tx, {
        tenantId: TENANT_A,
        topic: 'conversation-turns',
        groupKey: 'g-a',
        payload: { n: 1 },
      }),
    );
    const b = await withTenant(visitor, TENANT_B, (tx) =>
      enqueue(tx, {
        tenantId: TENANT_B,
        topic: 'conversation-turns',
        groupKey: 'g-b',
        payload: { n: 2 },
      }),
    );
    await expect(
      withTenant(visitor, TENANT_A, async (tx) => {
        await enqueue(tx, {
          tenantId: TENANT_A,
          topic: 'conversation-turns',
          groupKey: 'g-x',
          payload: { n: 3 },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const { queue, sent } = fakeQueue();
    const dispatcher = createDispatcher({
      zdb: tdb.zone('outbox'),
      queue,
      queueUrls: { 'conversation-turns': 'q://turns' },
      logger: createLogger('test', 'silent'),
    });
    expect(await dispatcher.dispatchPending()).toBe(2);
    expect(await dispatcher.dispatchPending()).toBe(0);
    expect(sent.map((s) => [s.id, s.groupId, s.url]).sort()).toEqual(
      [
        [a, 'g-a', 'q://turns'],
        [b, 'g-b', 'q://turns'],
      ].sort(),
    );
  });

  it('leaves a row pending when the send fails, then sends it on the next sweep', async () => {
    const id = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      enqueue(tx, {
        tenantId: TENANT_A,
        topic: 'conversation-turns',
        groupKey: 'g-r',
        payload: {},
      }),
    );
    const { queue, sent } = fakeQueue(1);
    const dispatcher = createDispatcher({
      zdb: tdb.zone('outbox'),
      queue,
      queueUrls: { 'conversation-turns': 'q://turns' },
      logger: createLogger('test', 'silent'),
    });
    expect(await dispatcher.dispatchPending()).toBe(0);
    expect(await dispatcher.dispatchPending()).toBe(1);
    expect(sent.map((s) => s.id)).toEqual([id]);
  });

  it('wakes on NOTIFY when a row commits', async () => {
    const { queue, sent } = fakeQueue();
    const dispatcher = createDispatcher({
      zdb: tdb.zone('outbox'),
      queue,
      queueUrls: { 'conversation-turns': 'q://turns' },
      logger: createLogger('test', 'silent'),
      sweepIntervalMs: 60_000,
    });
    const abort = new AbortController();
    const running = dispatcher.run(abort.signal);
    await new Promise((r) => setTimeout(r, 300));
    const id = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      enqueue(tx, {
        tenantId: TENANT_A,
        topic: 'conversation-turns',
        groupKey: 'g-n',
        payload: {},
      }),
    );
    for (let i = 0; i < 50 && !sent.some((s) => s.id === id); i++)
      await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await running;
    expect(sent.map((s) => s.id)).toContain(id);
  });

  it('the outbox role sees pending outbox rows but no other table', async () => {
    await expect(tdb.zone('outbox').pool.query('select * from messages')).rejects.toThrow(
      /permission denied/,
    );
  });
});
