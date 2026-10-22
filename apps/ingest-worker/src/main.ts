import { usageSink } from '@kaki/analytics';
import { IngestJob } from '@kaki/contracts';
import { createZoneDb, ping } from '@kaki/db';
import { fakeExtractScript, runIngestJob } from '@kaki/kb';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import {
  createLogger,
  createQueueClient,
  envSchemas,
  loadConfig,
  startHealthServer,
  startTelemetry,
} from '@kaki/platform';
import { z } from 'zod';
import { chromiumFetchers, parseHostMap } from './chromium.js';

const flag = z.preprocess((v) => v === 'true' || v === '1', z.boolean());
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const config = loadConfig(
  envSchemas.base
    .extend(envSchemas.aws.omit({ SQS_TURNS_QUEUE_URL: true }).shape)
    .extend(envSchemas.ingestQueue.shape)
    .extend({
      HEALTH_PORT: envSchemas.port.default(3003),
      INGEST_DATABASE_URL: z.string().startsWith('postgres'),
      /** `fake` until real-model access (M1.5); `anthropic-dev` uses test data only (Q1). */
      LLM_PROVIDER: z.enum(['fake', 'anthropic-dev']).default('fake'),
      ANTHROPIC_API_KEY: optional,
      /** Pages fetched at once per source, and pages extracted at once (ADR-018 d4). */
      CRAWL_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
      EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
      /** One below the queue's maxReceiveCount (6), so a source never stays processing. */
      INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
      /** Dev-only: lifts the crawler's private-address guard (FEAT-012 §5.6). */
      CRAWL_ALLOW_PRIVATE_HOSTS: flag.default(false),
      /** Dev-only: `host=http://127.0.0.1:5176`, the fixture site for a domain (§5.8). */
      CRAWL_HOST_MAP: optional,
      /** The image's Chromium; unset uses playwright-core's own download. */
      CHROMIUM_EXECUTABLE_PATH: optional,
    }),
);
const stopTelemetry = startTelemetry('ingest-worker', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('ingest-worker', config.LOG_LEVEL);

const dev = process.env.KAKI_BUILD !== 'production';
const zdb = createZoneDb('ingest', config.INGEST_DATABASE_URL);
const queue = createQueueClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL });
const llm = gatewayFromConfig({
  provider: config.LLM_PROVIDER,
  anthropicApiKey: config.ANTHROPIC_API_KEY,
  // The fake model reads the fixture site's patterns (FEAT-012 §5.3).
  fakeScript: fakeExtractScript,
  onUsage: usageSink(zdb, logger),
});
const browser = chromiumFetchers({
  executablePath: config.CHROMIUM_EXECUTABLE_PATH,
  allowPrivate: dev && config.CRAWL_ALLOW_PRIVATE_HOSTS,
  hostMap: dev ? parseHostMap(config.CRAWL_HOST_MAP) : new Map(),
});
if (dev && config.CRAWL_ALLOW_PRIVATE_HOSTS)
  logger.warn('crawler address guard is off (CRAWL_ALLOW_PRIVATE_HOSTS, dev only)');

const health = startHealthServer(config.HEALTH_PORT, {
  database: () => ping(zdb),
  browser: async () => browser.healthy(),
});
const abort = new AbortController();

/**
 * Consumes `ingest.fifo` (ADR-018, FEAT-012 §5.1): one stage of one source per message,
 * one message at a time (a crawl can take minutes). The job runner is idempotent on
 * (source, stage, attempt); a thrown stage is retried by SQS.
 */
const consuming = queue.consume<unknown>(
  {
    queueUrl: config.SQS_INGEST_QUEUE_URL,
    signal: abort.signal,
    maxMessages: 1,
    onError: (err, raw) =>
      logger.error({ err, sqsMessageId: raw.MessageId }, 'ingest stage failed; will be retried'),
  },
  async (msg) => {
    const job = IngestJob.parse(msg.body);
    const log = logger.child({
      outboxId: msg.id,
      tenantId: job.tenantId,
      sourceId: job.sourceId,
      attempt: job.attempt,
      stage: job.stage,
    });
    const started = Date.now();
    const outcome = await runIngestJob(
      {
        zdb,
        llm,
        fetcher: browser.open,
        crawl: { concurrency: config.CRAWL_CONCURRENCY },
        extract: {
          concurrency: config.EXTRACT_CONCURRENCY,
          onDropped: (pageId, dropped) => log.info({ pageId, dropped }, 'extracted facts dropped'),
        },
        maxAttempts: config.INGEST_MAX_ATTEMPTS,
      },
      job,
      msg.receiveCount,
    );
    log.info({ ...outcome, ms: Date.now() - started }, 'ingest stage done');
  },
);
consuming.catch((err) => {
  logger.fatal({ err }, 'ingest consumer stopped');
  process.exit(1);
});
logger.info('ingest-worker consuming ingest.fifo');

async function shutdown() {
  abort.abort();
  health.close();
  await consuming.catch(() => undefined);
  await browser.close().catch(() => undefined);
  await zdb.pool.end();
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
