import type { ZoneDb } from '@kaki/db';
import { queueAutoClose, type AutoCloseQueued } from '@kaki/inbox';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One run of the auto-close scan (INB-08; FEAT-042 §5.3, D3): queues an auto-close job for
 * each conversation idle past its channel's limit; the agent-worker closes it. Logs the
 * counts and never throws, so a failed run is retried on the next tick.
 */
export async function autoCloseOnce(
  zdb: ZoneDb,
  logger: Log,
  run: (zdb: ZoneDb) => Promise<AutoCloseQueued[]> = queueAutoClose,
): Promise<void> {
  try {
    const rows = await run(zdb);
    logger.info(
      { tenants: rows.length, queued: rows.reduce((n, r) => n + r.queued, 0) },
      'auto-close scan',
    );
  } catch (err) {
    logger.error({ err }, 'auto-close scan failed; retrying on the next tick');
  }
}
