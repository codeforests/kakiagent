import { fakeAgentScript, runVisitorTurn } from '@kaki/agent';
import { receiveEmail } from '@kaki/channels';
import { usageSink } from '@kaki/analytics';
import { runApprovalTimer } from '@kaki/approvals';
import { TurnQueueJob, type RealtimeEvent } from '@kaki/contracts';
import { createZoneDb, ping, withTenant } from '@kaki/db';
import * as inbox from '@kaki/inbox';
import {
  autoCloseIdle,
  conversationSummary,
  remindEscalation,
  toMessage,
  toSummary,
} from '@kaki/inbox';
import { gatewayFromEnv, type UsageEvent } from '@kaki/llm-gateway';
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
import { visitorTenantState } from '@kaki/tenancy';
import { z } from 'zod';
import { s3MailStore } from './mail-store.js';

const config = loadConfig(
  envSchemas.base
    .extend(envSchemas.aws.shape)
    .extend(envSchemas.valkey.shape)
    .extend(envSchemas.llm.shape)
    .extend(envSchemas.emailInbound.shape)
    .extend({
      HEALTH_PORT: envSchemas.port.default(3002),
      VISITOR_DATABASE_URL: z.string().startsWith('postgres'),
    }),
);
const stopTelemetry = startTelemetry('agent-worker', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger('agent-worker', config.LOG_LEVEL);

const visitorDb = createZoneDb('visitor', config.VISITOR_DATABASE_URL);
const publisher = createPublisher(config.VALKEY_URL);
const queue = createQueueClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL });

// Every model call is written to the usage ledger (ADR-021) and tallied per turn for
// the `turn complete` line (FEAT-004 §5.6). The sink logs and never throws (D7).
const record = usageSink(visitorDb, logger);
const turnUsage = new Map<string, { costUsd: number; cacheReadTokens: number }>();
async function onUsage(e: UsageEvent) {
  if (e.turnId) {
    const t = turnUsage.get(e.turnId) ?? { costUsd: 0, cacheReadTokens: 0 };
    t.costUsd += e.costUsd;
    t.cacheReadTokens += e.cacheReadInputTokens;
    turnUsage.set(e.turnId, t);
  }
  await record(e);
}
const llm = gatewayFromEnv(config, {
  // The fake model plans with keywords and answers from the facts in its prompt, with
  // slots (FEAT-022, FEAT-004).
  fakeScript: fakeAgentScript,
  onUsage,
});

/** Publishes each event on its channels after commit; a failure only logs (clients resume from Postgres). */
async function publishAll(
  events: [string[], RealtimeEvent][],
  log: { warn(obj: object, msg: string): void },
): Promise<void> {
  for (const [names, event] of events) {
    await Promise.all(names.map((n) => publisher.publish(n, event))).catch((err) =>
      log.warn({ err }, 'publish failed; clients will resume from Postgres'),
    );
  }
}

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
    const parsed = TurnQueueJob.parse(msg.body);
    // An escalation reminder (INB-05; FEAT-044 §5.5) rides the conversation's FIFO group. The
    // escalation's lock and its resolved check make a duplicate job a no-op; the dedupe key
    // keeps a redelivered one from alerting twice.
    // An approval timer (APR-04, APR-06; FEAT-055 §5.4, D10): urgent alert, SLA escalation or
    // expiry. `runApprovalTimer` re-checks the approval under a lock, so a stale or duplicate
    // job does nothing (ADR-012).
    if ('kind' in parsed && parsed.kind === 'approval_timer') {
      const t = parsed.tenantId;
      const log = logger.child({
        outboxId: msg.id,
        tenantId: t,
        approvalId: parsed.approvalId,
        timer: parsed.timer,
      });
      const r = await withTenant(visitorDb, t, async (tx) => {
        const tenant = await visitorTenantState(tx);
        return runApprovalTimer(tx, {
          tenantId: t,
          approvalId: parsed.approvalId,
          timer: parsed.timer,
          hours: tenant
            ? {
                hours: tenant.hours,
                openOnPublicHolidays: tenant.openOnPublicHolidays,
                holidays: tenant.holidays,
              }
            : null,
        });
      });
      // As for a turn: the summary (with an escalation's details) is read after commit.
      const summary = r.conversation
        ? ((await withTenant(visitorDb, t, (tx) =>
            conversationSummary(tx, t, r.conversation!.id),
          ).catch(() => null)) ?? toSummary(r.conversation, r.message?.notice ?? ''))
        : null;
      const events: [string[], RealtimeEvent][] = [];
      if (r.message)
        events.push([
          [channels.conversation(t, r.message.conversationId), channels.inbox(t)],
          { type: 'message', message: toMessage(r.message) },
        ]);
      if (summary)
        events.push([[channels.inbox(t)], { type: 'conversation', conversation: summary }]);
      if (r.outcome === 'expired')
        events.push([
          [channels.inbox(t)],
          { type: 'approval', id: parsed.approvalId, status: 'expired' },
        ]);
      await publishAll(events, log);
      log.info({ outcome: r.outcome }, 'approval timer');
      return;
    }
    if ('kind' in parsed && parsed.kind === 'escalation_reminder') {
      const t = parsed.tenantId;
      const log = logger.child({
        outboxId: msg.id,
        tenantId: t,
        escalationId: parsed.escalationId,
      });
      const outcome = await withTenant(visitorDb, t, async (tx) => {
        const tenant = await visitorTenantState(tx);
        return remindEscalation(tx, {
          tenantId: t,
          escalationId: parsed.escalationId,
          hours: tenant
            ? {
                hours: tenant.hours,
                openOnPublicHolidays: tenant.openOnPublicHolidays,
                holidays: tenant.holidays,
              }
            : null,
          log,
        });
      });
      log.info({ outcome }, 'escalation reminder');
      return;
    }
    const log = logger.child({
      outboxId: msg.id,
      tenantId: parsed.tenantId,
      conversationId: parsed.conversationId,
    });
    // Auto-close (INB-08; FEAT-042 D3) rides this FIFO group, so it can't interleave with
    // a turn of the same conversation. The re-check makes a stale or duplicate job a no-op.
    if ('kind' in parsed) {
      const t = parsed.tenantId;
      const summary = await withTenant(visitorDb, t, async (tx) => {
        const closed = await autoCloseIdle(tx, t, parsed.conversationId);
        return closed ? conversationSummary(tx, t, parsed.conversationId) : null;
      });
      if (!summary) {
        log.info('auto-close skipped: no longer idle or already closed');
        return;
      }
      await publisher
        .publish(channels.inbox(t), { type: 'conversation', conversation: summary })
        .catch((err) => log.warn({ err }, 'publish failed; clients will resume from Postgres'));
      log.info('conversation auto-closed');
      return;
    }
    const job = parsed;
    // Each verified segment goes straight to Valkey (FEAT-022 D7); Postgres keeps the
    // stored message, which replaces the segments.
    const publishSegment = async (segment: { turnId: string; seq: number; text: string }) => {
      const event: RealtimeEvent = { type: 'segment', ...segment };
      await publisher
        .publish(channels.conversation(job.tenantId, job.conversationId), event)
        .catch((err) => log.warn({ err }, 'segment publish failed'));
    };
    let reply;
    let usage: { costUsd: number; cacheReadTokens: number };
    try {
      reply = await runVisitorTurn({ zdb: visitorDb, llm, publishSegment }, job);
    } finally {
      // A thrown turn is retried with the same message ID; its tally starts again.
      usage = turnUsage.get(job.messageId) ?? { costUsd: 0, cacheReadTokens: 0 };
      turnUsage.delete(job.messageId);
    }
    if (!reply) {
      log.info('turn already handled');
      return;
    }
    const message = toMessage(reply.message);
    // An escalated conversation's summary carries its open escalation (FEAT-044); the
    // visitor zone can't name the assignee, so the dashboard keeps the name it has.
    const summary =
      reply.conversation.status === 'escalated'
        ? ((await withTenant(visitorDb, job.tenantId, (tx) =>
            conversationSummary(tx, job.tenantId, job.conversationId),
          ).catch(() => null)) ?? toSummary(reply.conversation, message.body))
        : toSummary(reply.conversation, message.body);
    const both = [
      channels.conversation(job.tenantId, job.conversationId),
      channels.inbox(job.tenantId),
    ];
    const events: [string[], RealtimeEvent][] = [
      // A quote sent at once (FEAT-055 D3) was stored before the reply, so it goes first.
      ...(reply.approvalMessage
        ? [
            [both, { type: 'message', message: toMessage(reply.approvalMessage) }] as [
              string[],
              RealtimeEvent,
            ],
          ]
        : []),
      // The escalation notice stored beside an answered reply goes first (FEAT-044 §5.4).
      ...(reply.escalationNotice
        ? [
            [
              [
                channels.conversation(job.tenantId, job.conversationId),
                channels.inbox(job.tenantId),
              ],
              { type: 'message', message: toMessage(reply.escalationNotice) },
            ] as [string[], RealtimeEvent],
          ]
        : []),
      [
        [channels.conversation(job.tenantId, job.conversationId), channels.inbox(job.tenantId)],
        { type: 'message', message },
      ],
      // FEAT-055: the waiting notice stored after an answered reply.
      ...(reply.approvalNotice
        ? [
            [both, { type: 'message', message: toMessage(reply.approvalNotice) }] as [
              string[],
              RealtimeEvent,
            ],
          ]
        : []),
      [[channels.inbox(job.tenantId)], { type: 'conversation', conversation: summary }],
      // FEAT-055: a new approval (or a quote sent at once) refreshes the approvals queue. The
      // realtime role never forwards approval events to visitors.
      ...(reply.approval && reply.approval.status !== 'already_pending'
        ? [
            [
              [channels.inbox(job.tenantId)],
              {
                type: 'approval',
                id: reply.approval.id,
                status: reply.approval.status === 'auto' ? 'approved' : 'pending',
              },
            ] as [string[], RealtimeEvent],
          ]
        : []),
    ];
    await publishAll(events, log);
    // NFR-01 latency (AC-12): measured from the first token request to release.
    log.info(
      {
        messageId: message.id,
        outcome: reply.outcome,
        firstSegmentMs: reply.timings?.firstSegmentMs ?? null,
        totalMs: reply.timings?.totalMs ?? null,
        // FEAT-004: the routed model, the planned task kinds and the turn's cost (codes only).
        route: reply.route,
        tasks: reply.plan?.tasks.map((t) => t.kind) ?? [],
        planFallback: reply.plan?.fallback ?? null,
        // FEAT-023: the reply language and whether the after-hours notice went out.
        language: reply.language,
        afterHours: reply.afterHours,
        triageMs: reply.timings?.triageMs ?? null,
        costUsd: Number(usage.costUsd.toFixed(6)),
        cacheReadTokens: usage.cacheReadTokens,
      },
      'turn complete',
    );
  },
);
logger.info({ provider: config.LLM_PROVIDER }, 'agent-worker consuming conversation turns');

/**
 * Consumes `email-inbound` (CHN-04; FEAT-036 §5.2): SES-stored mail announced through SNS.
 * `inbound_events` makes a redelivery a no-op; a thrown error leaves the message for retry
 * and, after 5 receives, the DLQ (NFR-17).
 */
const mailStore = s3MailStore({
  quarantineBucket: config.QUARANTINE_BUCKET,
  region: config.AWS_REGION,
  endpoint: config.AWS_ENDPOINT_URL,
});
const receivingMail = queue.consume<unknown>(
  {
    queueUrl: config.SQS_EMAIL_INBOUND_QUEUE_URL,
    signal: abort.signal,
    onError: (err, raw) =>
      logger.error({ err, sqsMessageId: raw.MessageId }, 'inbound email failed; will be retried'),
  },
  async (msg) => {
    const r = await receiveEmail(
      {
        zdb: visitorDb,
        store: mailStore,
        inbox,
        config: {
          topicArn: config.EMAIL_SNS_TOPIC_ARN,
          inboundBucket: config.EMAIL_INBOUND_BUCKET,
          inboundDomain: config.EMAIL_INBOUND_DOMAIN,
        },
      },
      msg.body,
    );
    const log = logger.child({ sqsMessageId: msg.id });
    if ('rejected' in r) {
      log.warn({ rejected: r.rejected }, 'inbound email rejected');
      return;
    }
    if ('notification' in r) {
      log.info({ notification: r.notification }, 'email notification');
      return;
    }
    for (const one of r.recipients) {
      if (one.outcome !== 'accepted') {
        log.info(
          { outcome: one.outcome, reason: 'reason' in one ? one.reason : null },
          'inbound email',
        );
        continue;
      }
      const t = one.tenantId;
      // The inbox shows the mail at once; the turn (when scheduled) replies after.
      const summary =
        (await withTenant(visitorDb, t, (tx) =>
          conversationSummary(tx, t, one.conversation.id),
        ).catch(() => null)) ?? toSummary(one.conversation, one.message.body);
      if (one.created)
        await publishAll(
          [
            [
              [channels.conversation(t, one.conversation.id), channels.inbox(t)],
              { type: 'message', message: toMessage(one.message) },
            ],
            [[channels.inbox(t)], { type: 'conversation', conversation: summary }],
          ],
          log,
        );
      log.info(
        { tenantId: t, conversationId: one.conversation.id, created: one.created },
        'inbound email accepted',
      );
    }
  },
);

async function shutdown() {
  abort.abort();
  await Promise.all([consuming.catch(() => {}), receivingMail.catch(() => {})]);
  health.close();
  await Promise.all([visitorDb.pool.end(), publisher.close()]);
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
