import { usageSink } from '@kaki/analytics';
import { runThemeDetect } from '@kaki/channels';
import { IngestJob, ThemeDetectJob } from '@kaki/contracts';
import { createZoneDb, ping } from '@kaki/db';
import {
  DEFAULT_FILE_LIMITS,
  fakeExtractScript,
  fakeMineScript,
  runIngestJob,
  type FileDeps,
} from '@kaki/kb';
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
import { clamavScanner } from './clamav.js';
import { guarddutyScanner } from './guardduty.js';
import { pdftoppmRasterizer } from './pdf-raster.js';
import { s3FileStore } from './s3-files.js';
import { tesseractOcr } from './tesseract.js';

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
      /** Where the widget build is served; `detect.js` is fetched from here (FEAT-032 D4). */
      WIDGET_ASSET_URL: envSchemas.url.transform((u) => (u.endsWith('/') ? u : `${u}/`)),
      /** Uploads wait in quarantine; only clean files reach sources (FEAT-015 §5.3). */
      QUARANTINE_BUCKET: z.string().min(3),
      SOURCES_BUCKET: z.string().min(3),
      /** ClamAV locally (and ADR-019's fallback); GuardDuty Malware Protection at MD. */
      MALWARE_SCANNER: z.enum(['clamav', 'guardduty']).default('clamav'),
      CLAMAV_HOST: z.string().default('127.0.0.1'),
      CLAMAV_PORT: envSchemas.port.default(3310),
      TESSERACT_PATH: z.string().default('tesseract'),
      PDFTOPPM_PATH: z.string().default('pdftoppm'),
      /** Pages read, and pages OCR'd, per file; OCR'd pages at once (FEAT-015 D8). */
      FILE_PAGE_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_FILE_LIMITS.pages),
      OCR_PAGE_LIMIT: z.coerce.number().int().min(0).default(DEFAULT_FILE_LIMITS.ocrPages),
      OCR_CONCURRENCY: z.coerce
        .number()
        .int()
        .min(1)
        .max(8)
        .default(DEFAULT_FILE_LIMITS.ocrConcurrency),
      /** Data rows read per spreadsheet (FEAT-016 D10). */
      SHEET_ROW_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_FILE_LIMITS.sheetRows),
      /** A chat export's messages read, the latest kept (FEAT-017 D9). */
      CHAT_MESSAGE_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_FILE_LIMITS.chatMessages),
      /** A chat export's conversation parts stored and mined (FEAT-017 §5.3). */
      CHAT_PART_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_FILE_LIMITS.chatParts),
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
  // The fake model reads the fixture site's patterns (FEAT-012 §5.3) and mines chat parts
  // (FEAT-017 §5.4).
  fakeScript: (req) => (req.model === 'mine' ? fakeMineScript(req) : fakeExtractScript(req)),
  onUsage: usageSink(zdb, logger),
});
const browser = chromiumFetchers({
  executablePath: config.CHROMIUM_EXECUTABLE_PATH,
  allowPrivate: dev && config.CRAWL_ALLOW_PRIVATE_HOSTS,
  hostMap: dev ? parseHostMap(config.CRAWL_HOST_MAP) : new Map(),
});
if (dev && config.CRAWL_ALLOW_PRIVATE_HOSTS)
  logger.warn('crawler address guard is off (CRAWL_ALLOW_PRIVATE_HOSTS, dev only)');

const store = s3FileStore({
  quarantineBucket: config.QUARANTINE_BUCKET,
  sourcesBucket: config.SOURCES_BUCKET,
  region: config.AWS_REGION,
  endpoint: config.AWS_ENDPOINT_URL,
});
const clamav =
  config.MALWARE_SCANNER === 'clamav'
    ? clamavScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT })
    : null;
const ocr = tesseractOcr({ path: config.TESSERACT_PATH });
const files: FileDeps = {
  store,
  scanner: clamav ?? guarddutyScanner({ s3: store.s3, quarantineBucket: config.QUARANTINE_BUCKET }),
  ocr,
  rasterizer: pdftoppmRasterizer({ path: config.PDFTOPPM_PATH }),
  limits: {
    pages: config.FILE_PAGE_LIMIT,
    ocrPages: config.OCR_PAGE_LIMIT,
    ocrConcurrency: config.OCR_CONCURRENCY,
    sheetRows: config.SHEET_ROW_LIMIT,
    chatMessages: config.CHAT_MESSAGE_LIMIT,
    chatParts: config.CHAT_PART_LIMIT,
  },
};
// Tesseract's languages don't change while the worker runs: checked once (§5.8).
const ocrReady = ocr.healthy();
void ocrReady.then((ok) => {
  if (!ok) logger.error('tesseract is missing, or lacks eng or chi_sim');
});

const health = startHealthServer(config.HEALTH_PORT, {
  database: () => ping(zdb),
  browser: async () => browser.healthy(),
  // GuardDuty scans in S3 on its own; there is nothing to reach.
  scanner: async () => (clamav ? clamav.healthy() : true),
  ocr: () => ocrReady,
});
const abort = new AbortController();

// The widget's detection script, fetched once per worker; a failed fetch is retried by
// the next job (FEAT-032 §5.4).
let detectScript: Promise<string> | null = null;
const loadDetectScript = () =>
  (detectScript ??= fetch(`${config.WIDGET_ASSET_URL}detect.js`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`detect.js: HTTP ${res.status}`);
      return res.text();
    })
    .catch((err: unknown) => {
      detectScript = null;
      throw err;
    }));

/**
 * Consumes `ingest.fifo` (ADR-018, FEAT-012 §5.1): one stage of one source per message,
 * one message at a time (a crawl can take minutes), and the widget's theme detection. The job runner is idempotent on
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
    // Theme detection rides the same queue (FEAT-032 §5.4); source jobs carry no `kind`.
    if ((msg.body as { kind?: unknown } | null)?.kind === 'theme_detect') {
      const job = ThemeDetectJob.parse(msg.body);
      const script = await loadDetectScript();
      const started = Date.now();
      const outcome = await runThemeDetect(zdb, job, (url) => browser.probeTheme(url, script));
      logger.info(
        { outboxId: msg.id, tenantId: job.tenantId, outcome, ms: Date.now() - started },
        'theme detection done',
      );
      return;
    }
    const job = IngestJob.parse(msg.body);
    const log = logger.child({
      outboxId: msg.id,
      tenantId: job.tenantId,
      sourceId: job.sourceId,
      attempt: 'attempt' in job ? job.attempt : undefined,
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
        files,
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
