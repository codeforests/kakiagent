import { purgeHandoffLinks } from '@kaki/channels/handoff';
import type { ZoneDb } from '@kaki/db';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One run of the daily handoff-link purge (FEAT-038 §5.9; ADR-015): deletes links 7 days past
 * expiry across tenants and logs the count. Never throws, so a failed run is retried on the
 * next tick.
 */
export async function handoffPurgeOnce(
  zdb: ZoneDb,
  logger: Log,
  run: (zdb: ZoneDb) => Promise<number> = purgeHandoffLinks,
): Promise<void> {
  try {
    logger.info({ deleted: await run(zdb) }, 'handoff-link purge');
  } catch (err) {
    logger.error({ err }, 'handoff-link purge failed; retrying on the next tick');
  }
}
