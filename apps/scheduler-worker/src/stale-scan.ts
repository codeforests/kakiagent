import type { ZoneDb } from '@kaki/db';
import { runStaleScan, type StaleScanRow } from '@kaki/kb/stale';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One run of the stale-fact scan (KB-17; FEAT-018 §5.5): logs the counts and never
 * throws, so a failed run is retried on the next tick.
 */
export async function staleScanOnce(
  zdb: ZoneDb,
  logger: Log,
  scan: (zdb: ZoneDb) => Promise<StaleScanRow[]> = runStaleScan,
): Promise<void> {
  try {
    const rows = await scan(zdb);
    logger.info(
      {
        tenants: rows.length,
        flagged: rows.reduce((n, r) => n + r.flagged, 0),
        closed: rows.reduce((n, r) => n + r.closed, 0),
      },
      'stale fact scan',
    );
  } catch (err) {
    logger.error({ err }, 'stale fact scan failed; retrying on the next tick');
  }
}
