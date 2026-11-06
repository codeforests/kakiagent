import type { ZoneDb } from '@kaki/db';
import { queueApprovalTimers } from '@kaki/approvals';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One run of the approval timers (APR-04, APR-06; FEAT-055 §5.4, D10, ADR-012): marks and queues each due
 * urgent, SLA and expiry timer; the agent-worker runs it. Logs
 * the counts and never throws, so a failed run is retried on the next tick.
 */
export async function approvalTimersOnce(
  zdb: ZoneDb,
  logger: Log,
  run: (zdb: ZoneDb) => Promise<{ tenantId: string; queued: number }[]> = queueApprovalTimers,
): Promise<void> {
  try {
    const rows = await run(zdb);
    logger.info(
      { tenants: rows.length, queued: rows.reduce((n, r) => n + r.queued, 0) },
      'approval timer scan',
    );
  } catch (err) {
    logger.error({ err }, 'approval timer scan failed; retrying on the next tick');
  }
}
