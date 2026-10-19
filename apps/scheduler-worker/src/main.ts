import { createZoneDb, ping } from '@kaki/db';
import { anchorHeads, createS3AnchorStore } from '@kaki/governance';
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
    /** The S3 Object Lock bucket for audit chain heads (ADR-014 decision 5). */
    AUDIT_ANCHOR_BUCKET: z.string().min(3),
    AUDIT_ANCHOR_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60_000),
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

// Audit anchoring (ADR-014 decision 5): every chain head that moved since its last
// anchor goes to the Object Lock bucket, at start-up and then every 15 minutes.
const anchors = createS3AnchorStore({
  bucket: config.AUDIT_ANCHOR_BUCKET,
  region: config.AWS_REGION,
  endpoint: config.AWS_ENDPOINT_URL,
});
async function anchorOnce() {
  try {
    const { anchored } = await anchorHeads(outboxDb, anchors);
    logger.info({ anchored }, 'audit anchor run');
  } catch (err) {
    logger.error({ err }, 'audit anchor run failed; retrying on the next tick');
  }
}
const anchorRun = anchorOnce();
const anchorTimer = setInterval(() => void anchorOnce(), config.AUDIT_ANCHOR_INTERVAL_MS);

async function shutdown() {
  abort.abort();
  clearInterval(anchorTimer);
  await Promise.all([running.catch(() => {}), anchorRun]);
  health.close();
  await outboxDb.pool.end();
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
