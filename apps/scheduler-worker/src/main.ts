import { DEFAULT_GOVERNOR, runCostGovernor } from '@kaki/analytics';
import { createZoneDb, ping } from '@kaki/db';
import { anchorHeads, createS3AnchorStore } from '@kaki/governance';
import { sendPendingInvitations, sendPendingMagicLinks } from '@kaki/identity';
import {
  createLogger,
  createQueueClient,
  createSmtpMailer,
  envSchemas,
  loadConfig,
  startHealthServer,
  startTelemetry,
} from '@kaki/platform';
import { createDispatcher } from '@kaki/platform/outbox';
import { z } from 'zod';
import { channelHealthOnce } from './channel-health.js';
import { gapClusterOnce } from './gap-cluster.js';
import { staleScanOnce } from './stale-scan.js';

const config = loadConfig(
  envSchemas.base
    .extend(envSchemas.aws.shape)
    .extend(envSchemas.ingestQueue.shape)
    .extend({
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
      /** Sign-in links whose first send failed are retried from here (FEAT-005, NFR-17). */
      IDENTITY_DATABASE_URL: z.string().startsWith('postgres'),
      MAGIC_LINK_SECRET: envSchemas.secret,
      PUBLIC_APP_URL: envSchemas.url,
      SMTP_URL: z.string().regex(/^smtps?:\/\//),
      EMAIL_FROM: z.string().min(3).default('KakiAgent <no-reply@kakiagent.local>'),
      MAGIC_LINK_SWEEP_MS: z.coerce.number().int().positive().default(5000),
      /** The cost governor (ADR-007 decision 3, FEAT-004 D9): hourly, on the 7-day average. */
      COST_GOVERNOR_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(60 * 60_000),
      COST_GOVERNOR_TARGET_SGD: z.coerce.number().positive().default(DEFAULT_GOVERNOR.targetSgd),
      COST_GOVERNOR_RELAX_SGD: z.coerce.number().positive().default(DEFAULT_GOVERNOR.relaxSgd),
      USD_SGD_RATE: z.coerce.number().positive().default(DEFAULT_GOVERNOR.usdToSgd),
      COST_GOVERNOR_MIN_CONVERSATIONS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_GOVERNOR.minConversations),
      /** The stale-fact scan (KB-17, FEAT-018 §5.5): daily, first run at start-up. */
      STALE_SCAN_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(24 * 60 * 60_000),
      /** Coverage-gap grouping (KB-09, FEAT-019 §5.5): every 10 minutes, first run at start-up. */
      GAP_CLUSTER_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(10 * 60_000),
      /** Channel health checks (CHN-12, FEAT-034 §5.2): every 5 minutes, first run at start-up. */
      CHANNEL_HEALTH_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(5 * 60_000),
    }),
);
const stopTelemetry = startTelemetry('scheduler-worker', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('scheduler-worker', config.LOG_LEVEL);

const outboxDb = createZoneDb('outbox', config.OUTBOX_DATABASE_URL, 3);
const queue = createQueueClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL });
const identityDb = createZoneDb('identity', config.IDENTITY_DATABASE_URL, 2);
const health = startHealthServer(config.HEALTH_PORT, { database: () => ping(outboxDb) });
const abort = new AbortController();

// The outbox dispatcher (ADR-012). Durable timers (`timers` table, SKIP LOCKED poll)
// and recurring jobs join this role with the first feature that needs them.
const dispatcher = createDispatcher({
  zdb: outboxDb,
  queue,
  queueUrls: {
    'conversation-turns': config.SQS_TURNS_QUEUE_URL,
    ingest: config.SQS_INGEST_QUEUE_URL,
  },
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

// Sign-in links (FEAT-005 D6): the api sends each link at once; any that failed are
// retried here with backoff while the link has more than a minute left, and rows older
// than 24 hours are purged. Team invitations (FEAT-007 §5.3) ride the same tick.
const mailer = createSmtpMailer(config.SMTP_URL, config.EMAIL_FROM);
const linkConfig = { secret: config.MAGIC_LINK_SECRET, appUrl: config.PUBLIC_APP_URL };
let sweeping = Promise.resolve();
async function sweepLinks() {
  try {
    const r = await sendPendingMagicLinks(identityDb, mailer, linkConfig);
    if (r.sent || r.failed || r.purged) logger.info(r, 'magic-link sweep');
  } catch (err) {
    logger.error({ err }, 'magic-link sweep failed; retrying on the next tick');
  }
  try {
    const r = await sendPendingInvitations(identityDb, mailer, linkConfig);
    if (r.sent || r.failed || r.purged) logger.info(r, 'invitation sweep');
  } catch (err) {
    logger.error({ err }, 'invitation sweep failed; retrying on the next tick');
  }
}
const linkTimer = setInterval(() => {
  sweeping = sweeping.then(sweepLinks);
}, config.MAGIC_LINK_SWEEP_MS);

// The cost governor (FEAT-004 §5.6): moves a tenant's routing threshold one step when
// its 7-day cost per conversation leaves the band. Each change is a `warn` line, the
// operator's alert until MD's metric filter and FEAT-070's console.
const governorConfig = {
  targetSgd: config.COST_GOVERNOR_TARGET_SGD,
  relaxSgd: config.COST_GOVERNOR_RELAX_SGD,
  usdToSgd: config.USD_SGD_RATE,
  minConversations: config.COST_GOVERNOR_MIN_CONVERSATIONS,
};
if (governorConfig.relaxSgd >= governorConfig.targetSgd)
  throw new Error('COST_GOVERNOR_RELAX_SGD must be below COST_GOVERNOR_TARGET_SGD');
async function governOnce() {
  try {
    const changes = await runCostGovernor(outboxDb, governorConfig);
    for (const c of changes)
      logger.warn({ event: 'cost_governor.step_changed', ...c }, 'cost governor step changed');
    logger.info({ changed: changes.length }, 'cost governor run');
  } catch (err) {
    logger.error({ err }, 'cost governor run failed; retrying on the next tick');
  }
}
const governorRun = governOnce();
const governorTimer = setInterval(() => void governOnce(), config.COST_GOVERNOR_INTERVAL_MS);

// The stale-fact scan (FEAT-018 §5.5): flags approved facts past their review interval
// as corrections and closes items whose fact moved on.
const staleRun = staleScanOnce(outboxDb, logger);
const staleTimer = setInterval(
  () => void staleScanOnce(outboxDb, logger),
  config.STALE_SCAN_INTERVAL_MS,
);

// Coverage gaps (FEAT-019 §5.5): files the questions turns couldn't answer under
// `coverage_gap` corrections and closes items with no question left.
const gapRun = gapClusterOnce(outboxDb, logger);
const gapTimer = setInterval(
  () => void gapClusterOnce(outboxDb, logger),
  config.GAP_CLUSTER_INTERVAL_MS,
);

// Channel health (FEAT-034 §5.2): checks every health-checked connection and marks a broken
// one degraded (two checks 5 minutes apart meet CHN-12's 15 minutes).
const channelRun = channelHealthOnce(outboxDb, logger);
const channelTimer = setInterval(
  () => void channelHealthOnce(outboxDb, logger),
  config.CHANNEL_HEALTH_INTERVAL_MS,
);

async function shutdown() {
  abort.abort();
  clearInterval(anchorTimer);
  clearInterval(linkTimer);
  clearInterval(governorTimer);
  clearInterval(staleTimer);
  clearInterval(gapTimer);
  clearInterval(channelTimer);
  await Promise.all([
    running.catch(() => {}),
    anchorRun,
    sweeping,
    governorRun,
    staleRun,
    gapRun,
    channelRun,
  ]);
  health.close();
  await mailer.close();
  await Promise.all([outboxDb.pool.end(), identityDb.pool.end()]);
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
