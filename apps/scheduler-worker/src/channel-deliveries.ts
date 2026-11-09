import { sql, type ZoneDb } from '@kaki/db';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface SweepRow {
  outcome: 'due' | 'timed_out';
}

/** `channel_deliveries_due()` (migration 0053): queues due retries, times out 24-hour-old ones. */
export async function queueDueDeliveries(zdb: ZoneDb): Promise<SweepRow[]> {
  const res = await zdb.db.execute<{ outcome: 'due' | 'timed_out' }>(
    sql`select outcome from channel_deliveries_due()`,
  );
  return res.rows;
}

/** `inbound_events_purge()`: provider events older than 30 days. */
export async function purgeInboundEvents(zdb: ZoneDb): Promise<number> {
  const res = await zdb.db.execute<{ n: number }>(sql`select inbound_events_purge() as n`);
  return Number(res.rows[0]?.n ?? 0);
}

const PURGE_EVERY_MS = 3_600_000;
let lastPurge = 0;

/**
 * One run of the delivery sweep (NFR-17, UC-27 3c; FEAT-036 §5.3, ADR-012): a due retry goes
 * back on `channel-send`; a delivery still pending after 24 hours is marked failed/timed_out
 * and a `delivery_failed` job escalates it in the agent-worker. Hourly, it also purges old
 * `inbound_events`. Logs the counts and never throws, so a failed run is retried next tick.
 */
export async function channelDeliveriesOnce(
  zdb: ZoneDb,
  logger: Log,
  run: { due: typeof queueDueDeliveries; purge: typeof purgeInboundEvents } = {
    due: queueDueDeliveries,
    purge: purgeInboundEvents,
  },
  now: () => number = Date.now,
): Promise<void> {
  try {
    const rows = await run.due(zdb);
    const timedOut = rows.filter((r) => r.outcome === 'timed_out').length;
    logger.info({ requeued: rows.length - timedOut, timedOut }, 'delivery sweep');
    if (now() - lastPurge >= PURGE_EVERY_MS) {
      lastPurge = now();
      logger.info({ purged: await run.purge(zdb) }, 'inbound events purged');
    }
  } catch (err) {
    logger.error({ err }, 'delivery sweep failed; retrying on the next tick');
  }
}
