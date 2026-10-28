import { runChannelHealth, type HealthRunResult } from '@kaki/channels';
import type { ZoneDb } from '@kaki/db';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One channel health run (CHN-12; FEAT-034 §5.2): logs the counts and never throws, so a
 * failed run is retried on the next tick. With only the widget registered it checks nothing.
 */
export async function channelHealthOnce(
  zdb: ZoneDb,
  logger: Log,
  run: (zdb: ZoneDb) => Promise<HealthRunResult> = runChannelHealth,
): Promise<void> {
  try {
    logger.info({ ...(await run(zdb)) }, 'channel health check');
  } catch (err) {
    logger.error({ err }, 'channel health check failed; retrying on the next tick');
  }
}
