import type { ZoneDb } from '@kaki/db';
import { runGapCluster, type GapClusterRow } from '@kaki/kb/gap-cluster';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One run of the gap grouping (KB-09; FEAT-019 §5.5): logs the counts and never throws,
 * so a failed run is retried on the next tick.
 */
export async function gapClusterOnce(
  zdb: ZoneDb,
  logger: Log,
  cluster: (zdb: ZoneDb) => Promise<GapClusterRow[]> = runGapCluster,
): Promise<void> {
  try {
    const rows = await cluster(zdb);
    logger.info(
      {
        tenants: rows.length,
        grouped: rows.reduce((n, r) => n + r.grouped, 0),
        opened: rows.reduce((n, r) => n + r.opened, 0),
        closed: rows.reduce((n, r) => n + r.closed, 0),
      },
      'coverage gap grouping',
    );
  } catch (err) {
    logger.error({ err }, 'coverage gap grouping failed; retrying on the next tick');
  }
}
