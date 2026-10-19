import { createZoneDb } from '@kaki/db';
import { createLogger, createPublisher, startTelemetry } from '@kaki/platform';
import { buildApp } from './app.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig();
const stopTelemetry = startTelemetry('api', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('api', config.LOG_LEVEL);

const deps = {
  config,
  logger,
  dashboardDb: createZoneDb('dashboard', config.DASHBOARD_DATABASE_URL),
  visitorDb: createZoneDb('visitor', config.VISITOR_DATABASE_URL),
  publisher: createPublisher(config.VALKEY_URL),
};
const app = await buildApp(deps);
await app.listen({ port: config.PORT, host: config.HOST });

async function shutdown() {
  await app.close();
  await Promise.all([
    deps.dashboardDb.pool.end(),
    deps.visitorDb.pool.end(),
    deps.publisher.close(),
  ]);
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
