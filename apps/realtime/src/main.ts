import { createZoneDb } from '@kaki/db';
import { createLogger, createSubscriber, startTelemetry } from '@kaki/platform';
import { buildApp } from './app.js';
import { loadRealtimeConfig } from './config.js';

const config = loadRealtimeConfig();
const stopTelemetry = startTelemetry('realtime', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('realtime', config.LOG_LEVEL);

const deps = {
  config,
  logger,
  dashboardDb: createZoneDb('dashboard', config.DASHBOARD_DATABASE_URL, 5),
  visitorDb: createZoneDb('visitor', config.VISITOR_DATABASE_URL, 5),
  identityDb: createZoneDb('identity', config.IDENTITY_DATABASE_URL, 5),
  subscriber: createSubscriber(config.VALKEY_URL),
};
const app = await buildApp(deps);
await app.listen({ port: config.PORT, host: config.HOST });

async function shutdown() {
  // Clients reconnect to another node and resume by sequence number (ADR-017).
  await app.close();
  await Promise.all([
    deps.dashboardDb.pool.end(),
    deps.visitorDb.pool.end(),
    deps.identityDb.pool.end(),
    deps.subscriber.close(),
  ]);
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
