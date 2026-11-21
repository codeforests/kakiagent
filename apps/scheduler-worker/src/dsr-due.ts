import type { ZoneDb } from '@kaki/db';
import { queueDsrDueAlerts } from '@kaki/governance';

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * One run of the data-request due sweep (GOV-05; FEAT-061 §5.6, D8): alerts Owners and Admins
 * once for each request 7 days or less from its legal due date. Logs the count and never throws,
 * so a failed run is retried on the next tick.
 */
export async function dsrDueOnce(
  zdb: ZoneDb,
  logger: Log,
  run: (zdb: ZoneDb) => Promise<number> = queueDsrDueAlerts,
): Promise<void> {
  try {
    const alerted = await run(zdb);
    if (alerted > 0) logger.info({ alerted }, 'data-request due sweep');
  } catch (err) {
    logger.error({ err }, 'data-request due sweep failed; retrying on the next tick');
  }
}
