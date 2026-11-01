import type { ZoneDb } from '@kaki/db';
import { queueEscalationReminders, type RemindersQueued } from '@kaki/inbox';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One run of the escalation reminder timer (INB-05; FEAT-044 §5.5, ADR-012): queues a
 * reminder job for each open escalation whose time has come; the agent-worker sends it. Logs
 * the counts and never throws, so a failed run is retried on the next tick.
 */
export async function escalationRemindersOnce(
  zdb: ZoneDb,
  logger: Log,
  run: (zdb: ZoneDb) => Promise<RemindersQueued[]> = queueEscalationReminders,
): Promise<void> {
  try {
    const rows = await run(zdb);
    logger.info(
      { tenants: rows.length, queued: rows.reduce((n, r) => n + r.queued, 0) },
      'escalation reminder scan',
    );
  } catch (err) {
    logger.error({ err }, 'escalation reminder scan failed; retrying on the next tick');
  }
}
