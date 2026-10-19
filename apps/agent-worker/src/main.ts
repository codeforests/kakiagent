import { fakeVisitorResponder, runVisitorTurn } from '@kaki/agent';
import { TurnJob, type RealtimeEvent } from '@kaki/contracts';
import { createZoneDb, ping } from '@kaki/db';
import { toMessage, toSummary } from '@kaki/inbox';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import {
  channels,
  createLogger,
  createPublisher,
  createQueueClient,
  envSchemas,
  loadConfig,
  startHealthServer,
  startTelemetry,
} from '@kaki/platform';
import { z } from 'zod';

const config = loadConfig(
  envSchemas.base
    .extend(envSchemas.aws.shape)
    .extend(envSchemas.valkey.shape)
    .extend({
      HEALTH_PORT: envSchemas.port.default(3002),
      VISITOR_DATABASE_URL: z.string().startsWith('postgres'),
      /** `fake` until real-model access (M1.5); `anthropic-dev` uses test data only (Q1). */
      LLM_PROVIDER: z.enum(['fake', 'anthropic-dev']).default('fake'),
      ANTHROPIC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    }),
);
const stopTelemetry = startTelemetry('agent-worker', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('agent-worker', config.LOG_LEVEL);

const visitorDb = createZoneDb('visitor', config.VISITOR_DATABASE_URL);
const publisher = createPublisher(config.VALKEY_URL);
const queue = createQueueClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL });
const llm = gatewayFromConfig({
  provider: config.LLM_PROVIDER,
  anthropicApiKey: config.ANTHROPIC_API_KEY,
  // The fake model answers from the facts in its prompt, with slots (FEAT-022).
  fakeScript: fakeVisitorResponder,
});

const health = startHealthServer(config.HEALTH_PORT, { database: () => ping(visitorDb) });
const abort = new AbortController();

/**
 * Consumes `conversation-turns.fifo` (ADR-012): one turn at a time per conversation
 * (FIFO message groups), idempotent on the visitor message (a reply already stored
 * means the turn is done). A thrown error leaves the message for retry and,
 * after maxReceiveCount, the DLQ (NFR-17).
 */
const consuming = queue.consume<unknown>(
  {
    queueUrl: config.SQS_TURNS_QUEUE_URL,
    signal: abort.signal,
    onError: (err, raw) =>
      logger.error({ err, sqsMessageId: raw.MessageId }, 'turn failed; will be retried'),
  },
  async (msg) => {
    const job = TurnJob.parse(msg.body);
    const log = logger.child({
      outboxId: msg.id,
      tenantId: job.tenantId,
      conversationId: job.conversationId,
    });
    // Each verified segment goes straight to Valkey (FEAT-022 D7); Postgres keeps the
    // stored message, which replaces the segments.
    const publishSegment = async (segment: { turnId: string; seq: number; text: string }) => {
      const event: RealtimeEvent = { type: 'segment', ...segment };
      await publisher
        .publish(channels.conversation(job.tenantId, job.conversationId), event)
        .catch((err) => log.warn({ err }, 'segment publish failed'));
    };
    const reply = await runVisitorTurn({ zdb: visitorDb, llm, publishSegment }, job);
    if (!reply) {
      log.info('turn already handled');
      return;
    }
    const message = toMessage(reply.message);
    const events: [string[], RealtimeEvent][] = [
      [
        [channels.conversation(job.tenantId, job.conversationId), channels.inbox(job.tenantId)],
        { type: 'message', message },
      ],
      [
        [channels.inbox(job.tenantId)],
        { type: 'conversation', conversation: toSummary(reply.conversation, message.body) },
      ],
    ];
    for (const [names, event] of events) {
      await Promise.all(names.map((n) => publisher.publish(n, event))).catch((err) =>
        log.warn({ err }, 'publish failed; clients will resume from Postgres'),
      );
    }
    // NFR-01 latency (AC-12): measured from the first token request to release.
    log.info(
      {
        messageId: message.id,
        outcome: reply.outcome,
        firstSegmentMs: reply.timings?.firstSegmentMs ?? null,
        totalMs: reply.timings?.totalMs ?? null,
      },
      'turn complete',
    );
  },
);
logger.info({ provider: config.LLM_PROVIDER }, 'agent-worker consuming conversation turns');

async function shutdown() {
  abort.abort();
  await consuming.catch(() => {});
  health.close();
  await Promise.all([visitorDb.pool.end(), publisher.close()]);
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
