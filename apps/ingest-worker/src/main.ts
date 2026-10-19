import {
  createLogger,
  envSchemas,
  loadConfig,
  startHealthServer,
  startTelemetry,
} from '@kaki/platform';

/**
 * The ingest-worker role (ADR-018): crawl, file safety, parsing/OCR, extraction,
 * embeddings. It has no queue in the walking skeleton; it starts, reports healthy and
 * waits. FEAT-012 (website crawl) gives it its first `ingest-*` queue, and its image
 * gains Chromium and Tesseract then.
 */
const config = loadConfig(envSchemas.base.extend({ HEALTH_PORT: envSchemas.port.default(3003) }));
const stopTelemetry = startTelemetry('ingest-worker', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('ingest-worker', config.LOG_LEVEL);
const health = startHealthServer(config.HEALTH_PORT, {});
logger.info('ingest-worker idle: no ingestion queues until FEAT-012');

async function shutdown() {
  health.close();
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
