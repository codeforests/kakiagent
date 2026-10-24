import { fakeAgentScript } from '@kaki/agent';
import { usageSink } from '@kaki/analytics';
import { createZoneDb } from '@kaki/db';
import { createGoogleSignIn } from '@kaki/identity';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import {
  createLogger,
  createPublisher,
  createRateLimiter,
  createSmtpMailer,
  startTelemetry,
} from '@kaki/platform';
import { buildApp } from './app.js';
import { loadApiConfig } from './config.js';
import { s3UploadSigner } from './uploads.js';

const config = loadApiConfig();
const stopTelemetry = startTelemetry('api', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('api', config.LOG_LEVEL);

const dashboardDb = createZoneDb('dashboard', config.DASHBOARD_DATABASE_URL);
const deps = {
  config,
  logger,
  dashboardDb,
  visitorDb: createZoneDb('visitor', config.VISITOR_DATABASE_URL),
  publisher: createPublisher(config.VALKEY_URL),
  llm: gatewayFromConfig({
    provider: config.LLM_PROVIDER,
    anthropicApiKey: config.ANTHROPIC_API_KEY,
    // Coaching turns run here (FEAT-027 D1), so the fake model plans and answers as the
    // agent-worker's does.
    fakeScript: fakeAgentScript,
    // Fact embeddings and coaching turns are billed calls too (ADR-021, FEAT-004 §5.6).
    onUsage: usageSink(dashboardDb, logger),
  }),
  identityDb: createZoneDb('identity', config.IDENTITY_DATABASE_URL),
  mailer: createSmtpMailer(config.SMTP_URL, config.EMAIL_FROM),
  rateLimiter: createRateLimiter(config.VALKEY_URL),
  uploads: s3UploadSigner({
    bucket: config.QUARANTINE_BUCKET,
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
  }),
  google:
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
      ? createGoogleSignIn({
          issuer: config.GOOGLE_ISSUER,
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
          redirectUri: new URL('/api/v1/auth/google/callback', config.PUBLIC_APP_URL).href,
          cookieSecret: config.SESSION_SECRET,
        })
      : null,
};
const app = await buildApp(deps);
await app.listen({ port: config.PORT, host: config.HOST });

async function shutdown() {
  await app.close();
  await Promise.all([
    deps.dashboardDb.pool.end(),
    deps.visitorDb.pool.end(),
    deps.identityDb.pool.end(),
    deps.publisher.close(),
    deps.mailer.close(),
    deps.rateLimiter.close(),
  ]);
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
