import { createZoneDb, ping } from '@kaki/db';
import {
  createLogger,
  createQueueClient,
  envSchemas,
  loadConfig,
  startHealthServer,
  startTelemetry,
} from '@kaki/platform';
import { createDispatcher } from '@kaki/platform/outbox';
import { z } from 'zod';

const config = loadConfig(
  envSchemas.base.extend(envSchemas.aws.shape).extend({
    HEALTH_PORT: envSchemas.port.default(3004),
    OUTBOX_DATABASE_URL: z.string().startsWith('postgres'),
    OUTBOX_SWEEP_MS: z.coerce.number().int().positive().default(5000),
  }),
);
const stopTelemetry = startTelemetry('scheduler-worker', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('scheduler-worker', config.LOG_LEVEL);

const outboxDb = createZoneDb('outbox', config.OUTBOX_DATABASE_URL, 3);
const queue = createQueueClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL });
const health = startHealthServer(config.HEALTH_PORT, { database: () => ping(outboxDb) });
const abort = new AbortController();

// The outbox dispatcher (ADR-012). Durable timers (`timers` table, SKIP LOCKED poll)
// and recurring jobs join this role with the first feature that needs them.
const dispatcher = createDispatcher({
  zdb: outboxDb,
  queue,
  queueUrls: { 'conversation-turns': config.SQS_TURNS_QUEUE_URL },
  logger,
  sweepIntervalMs: config.OUTBOX_SWEEP_MS,
});
const running = dispatcher.run(abort.signal);
logger.info('scheduler-worker dispatching the outbox');

async function shutdown() {
  abort.abort();
  await running.catch(() => {});
  health.close();
  await outboxDb.pool.end();
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
