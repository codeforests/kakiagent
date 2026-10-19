import { schema, sql, type Tx, type ZoneDb } from '@kaki/db';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { QueueClient } from './queue.js';

export type OutboxTopic = (typeof schema.outbox.topic.enumValues)[number];

/**
 * Writes an outbox row in the caller's transaction (ADR-012). The work it describes
 * happens only if the transaction commits. An insert trigger fires
 * `pg_notify('outbox_pending')` on commit, which wakes the dispatcher at once.
 */
export async function enqueue(
  tx: Tx,
  row: { tenantId: string; topic: OutboxTopic; groupKey: string; payload: unknown },
): Promise<string> {
  // The ID is made here rather than returned: writer roles may insert outbox rows
  // but not read them back (RETURNING needs SELECT), so only app_outbox can read.
  const id = randomUUID();
  await tx.insert(schema.outbox).values({
    tenantId: row.tenantId,
    id,
    topic: row.topic,
    groupKey: row.groupKey,
    payload: row.payload,
  });
  return id;
}

export interface Dispatcher {
  /** Publishes up to `limit` pending rows; returns how many were sent. */
  dispatchPending(limit?: number): Promise<number>;
  /** LISTEN for new rows and sweep on an interval until `signal` aborts. */
  run(signal: AbortSignal): Promise<void>;
}

/**
 * The outbox dispatcher, run by the scheduler-worker. It connects as the
 * `app_outbox` role, whose RLS policy is the only one allowed to see pending rows
 * across tenants. Rows are claimed with SKIP LOCKED so several dispatchers can run;
 * a failed send leaves the row pending for the next sweep. Consumers dedupe on the
 * outbox ID, so a send that succeeds before a crash is harmless when repeated.
 */
export function createDispatcher(opts: {
  zdb: ZoneDb;
  queue: QueueClient;
  queueUrls: Record<OutboxTopic, string>;
  logger: Logger;
  sweepIntervalMs?: number;
}): Dispatcher {
  const { zdb, queue, queueUrls, logger } = opts;

  async function dispatchPending(limit = 50): Promise<number> {
    return zdb.db.transaction(async (tx) => {
      const rows = await tx.execute<{
        tenant_id: string;
        id: string;
        topic: OutboxTopic;
        group_key: string;
        payload: unknown;
      }>(
        sql`select tenant_id, id, topic, group_key, payload from outbox
            where dispatched_at is null order by created_at limit ${limit} for update skip locked`,
      );
      let sent = 0;
      for (const row of rows.rows) {
        try {
          await queue.send(queueUrls[row.topic], {
            id: row.id,
            groupId: row.group_key,
            body: row.payload,
          });
          await tx.execute(
            sql`update outbox set dispatched_at = now() where tenant_id = ${row.tenant_id} and id = ${row.id}`,
          );
          sent++;
        } catch (err) {
          logger.warn(
            { err, outboxId: row.id, topic: row.topic },
            'outbox send failed; will retry',
          );
        }
      }
      return sent;
    });
  }

  async function run(signal: AbortSignal): Promise<void> {
    let wake: (() => void) | null = null;
    const listener = await zdb.pool.connect();
    const onNotify = () => wake?.();
    listener.on('notification', onNotify);
    await listener.query('listen outbox_pending');
    const interval = setInterval(onNotify, opts.sweepIntervalMs ?? 5000);
    signal.addEventListener('abort', onNotify);
    try {
      while (!signal.aborted) {
        try {
          while ((await dispatchPending()) > 0) {
            /* drain */
          }
        } catch (err) {
          logger.error({ err }, 'outbox sweep failed');
        }
        if (signal.aborted) break;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    } finally {
      clearInterval(interval);
      listener.off('notification', onNotify);
      await listener.query('unlisten outbox_pending').catch(() => {});
      (listener as pg.PoolClient).release();
    }
  }

  return { dispatchPending, run };
}
