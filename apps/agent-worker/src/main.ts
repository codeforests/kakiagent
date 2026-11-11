import { fakeAgentScript, runVisitorTurn } from '@kaki/agent';
import {
  deliverMessage,
  deliveryView,
  emailSender,
  escalateTimedOut,
  receiveEmail,
  recordBounce,
  sendServiceJob,
  telegramSender,
  type DeliverDeps,
  type DeliveryRow,
} from '@kaki/channels';
import { visitorPrivacy } from '@kaki/governance';
import { usageSink } from '@kaki/analytics';
import { runApprovalTimer } from '@kaki/approvals';
import { ChannelQueueJob, TurnQueueJob, type RealtimeEvent } from '@kaki/contracts';
import { createZoneDb, ping, withTenant, type Tx } from '@kaki/db';
import * as inbox from '@kaki/inbox';
import {
  autoCloseIdle,
  ConversationClosedError,
  conversationSummary,
  getMessage,
  remindEscalation,
  requestEscalation,
  toMessage,
  toSummary,
} from '@kaki/inbox';
import { gatewayFromEnv, type UsageEvent } from '@kaki/llm-gateway';
import {
  channels,
  createLogger,
  createSmtpMailer,
  createPublisher,
  createQueueClient,
  envSchemas,
  loadConfig,
  startHealthServer,
  startTelemetry,
} from '@kaki/platform';
import { visitorTenantState } from '@kaki/tenancy';
import { localSealer } from '@kaki/platform/secrets';
import { sendHandoffEmail } from '@kaki/channels/handoff';
import { z } from 'zod';
import { s3MailStore } from './mail-store.js';

const config = loadConfig(
  envSchemas.base
    .extend(envSchemas.aws.shape)
    .extend(envSchemas.valkey.shape)
    .extend(envSchemas.llm.shape)
    .extend(envSchemas.emailInbound.shape)
    .extend(envSchemas.channelSendQueue.shape)
    .extend({
      /** Replies on adapter channels go out through SMTP (Mailpit locally, SES at MD). */
      SMTP_URL: z.string().regex(/^smtps?:\/\//),
      EMAIL_FROM: z.string().min(3).default('KakiAgent <no-reply@kakiagent.local>'),
      /** SES replaces our Message-ID with `<id>@<this>` (FEAT-036 §8; checked at MD). */
      SES_MESSAGE_ID_DOMAIN: z.string().min(3).default('ap-southeast-1.amazonses.com'),
      HEALTH_PORT: envSchemas.port.default(3002),
      VISITOR_DATABASE_URL: z.string().startsWith('postgres'),
      /** Opens channel credentials (FEAT-037 §5.2); the same key as the api's. */
      CHANNEL_SECRET_KEY: z
        .string()
        .refine((v) => Buffer.from(v, 'base64url').length === 32, 'must be 32 bytes, base64url'),
      /** The Telegram Bot API; the local fake in dev and E2E (FEAT-037 §5.6). */
      TELEGRAM_API_BASE: envSchemas.url.default('https://api.telegram.org'),
      /** Signs channel handoff links (FEAT-038 D4); the same as the api's. */
      HANDOFF_LINK_SECRET: envSchemas.secret,
      /** The api's public origin: the email handoff's confirm link `<url>/continue/<code>`. */
      PUBLIC_API_URL: envSchemas.url.transform((u) => u.replace(/\/+$/, '')),
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

/**
 * Adapter-channel deliveries (D2; FEAT-036 §5.3): the trigger's and the sweep's `channel-send`
 * jobs. The thread's message carries its delivery state, so the inbox shows Sending… and
 * Not delivered as they change; a summary refresh follows an escalation.
 */
const mailer = createSmtpMailer(config.SMTP_URL, config.EMAIL_FROM, 15_000);
const channelSealer = localSealer(Buffer.from(config.CHANNEL_SECRET_KEY, 'base64url'));
const telegramApi = { base: config.TELEGRAM_API_BASE };
const deliverDeps: DeliverDeps = {
  zdb: visitorDb,
  senders: {
    telegram: telegramSender({ sealer: channelSealer, api: telegramApi }),
    email: emailSender({
      mailer,
      inboundDomain: config.EMAIL_INBOUND_DOMAIN,
      sesMessageIdDomain: config.SES_MESSAGE_ID_DOMAIN,
    }),
  },
  async footer(tx) {
    const [tenant, privacy] = await Promise.all([visitorTenantState(tx), visitorPrivacy(tx)]);
    // GOV-14: the tenant's own notice link; the hosted template page needs the widget key,
    // which the visitor zone can't read, so it shows the business name only (handoff).
    const notice = privacy?.notice ?? null;
    return {
      businessName: tenant?.businessName ?? privacy?.businessName ?? 'Our team',
      privacyUrl: notice?.mode === 'link' ? notice.url : null,
    };
  },
  async escalate(tx, tenantId, conversationId, source) {
    const tenant = await visitorTenantState(tx);
    await requestEscalation(tx, {
      tenantId,
      conversationId,
      source,
      hours: tenant
        ? {
            hours: tenant.hours,
            openOnPublicHolidays: tenant.openOnPublicHolidays,
            holidays: tenant.holidays,
          }
        : null,
      log: logger,
    }).catch((err: unknown) => {
      // A closed conversation has nobody to alert in the inbox; the delivery still shows failed.
      if (!(err instanceof ConversationClosedError)) throw err;
    });
  },
};

async function publishDelivery(tenantId: string, row: DeliveryRow | null) {
  if (!row) return;
  const out = await withTenant(visitorDb, tenantId, async (tx) => ({
    message: await getMessage(tx, tenantId, row.messageId),
    summary: await conversationSummary(tx, tenantId, row.conversationId).catch(() => null),
  }));
  const events: [string[], RealtimeEvent][] = [];
  if (out.message)
    events.push([
      [channels.inbox(tenantId)],
      { type: 'message', message: { ...toMessage(out.message), delivery: deliveryView(row) } },
    ]);
  if (out.summary)
    events.push([[channels.inbox(tenantId)], { type: 'conversation', conversation: out.summary }]);
  await publishAll(events, logger);
}

const health = startHealthServer(config.HEALTH_PORT, { database: () => ping(visitorDb) });
const abort = new AbortController();

/**
 * The email handoff's confirmation mail (CHN-07; FEAT-038 §5.4): from the business's reply
 * address, once per link (a used or expired link is skipped); a transient SMTP failure throws
 * for the queue's retry.
 */
const handoffEmailDeps = {
  zdb: visitorDb,
  mailer,
  secret: config.HANDOFF_LINK_SECRET,
  inboundDomain: config.EMAIL_INBOUND_DOMAIN,
  apiUrl: config.PUBLIC_API_URL,
  businessName: async (tx: Tx) => (await visitorTenantState(tx))?.businessName ?? 'Our team',
};
async function handoffEmail(
  job: { tenantId: string; linkId: string },
  log: { info(obj: object, msg: string): void },
): Promise<void> {
  const outcome = await sendHandoffEmail(handoffEmailDeps, job);
  log.info({ linkId: job.linkId, outcome }, 'handoff email');
}

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
    // A delivery the sweep timed out (UC-27 3c; FEAT-036 §5.3): escalate once and refresh the thread.
    if ('kind' in parsed && parsed.kind === 'delivery_failed') {
      const row = await escalateTimedOut(deliverDeps, parsed);
      await publishDelivery(parsed.tenantId, row);
      logger.info(
        { outboxId: msg.id, tenantId: parsed.tenantId, messageId: parsed.messageId, found: !!row },
        'delivery timed out',
      );
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
    // The email handoff's confirmation (CHN-07; FEAT-038 §5.4).
    if ('kind' in parsed && parsed.kind === 'handoff_email') {
      await handoffEmail(parsed, logger.child({ outboxId: msg.id, tenantId: parsed.tenantId }));
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
      // A permanent bounce of one of our replies (§5.3); other notifications are logged.
      if (r.notification === 'bounce' && r.permanent && r.sesMessageId) {
        const b = await recordBounce(
          deliverDeps,
          `<${r.sesMessageId}@${config.SES_MESSAGE_ID_DOMAIN}>`,
        );
        if (b) await publishDelivery(b.tenantId, b.delivery);
        log.info({ notification: 'bounce', matched: !!b }, 'email bounce');
        return;
      }
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

const delivering = queue.consume<unknown>(
  {
    queueUrl: config.SQS_CHANNEL_SEND_QUEUE_URL,
    signal: abort.signal,
    onError: (err, raw) =>
      logger.error({ err, sqsMessageId: raw.MessageId }, 'delivery failed; will be retried'),
  },
  async (msg) => {
    const parsed = ChannelQueueJob.parse(msg.body);
    // FEAT-037 §5.3: a channel's own reply (the group notice, a link confirmation, the greeting).
    if ('type' in parsed) {
      const outcome = await sendServiceJob(
        { zdb: visitorDb, sealer: channelSealer, api: telegramApi },
        parsed,
      );
      logger.info({ outboxId: msg.id, tenantId: parsed.tenantId, outcome }, 'service reply');
      return;
    }
    const job = parsed;
    const r = await deliverMessage(deliverDeps, job);
    if (r.outcome !== 'already_done' && r.outcome !== 'not_found')
      await publishDelivery(job.tenantId, r.delivery);
    logger.info(
      { outboxId: msg.id, tenantId: job.tenantId, messageId: job.messageId, outcome: r.outcome },
      'delivery',
    );
  },
);

async function shutdown() {
  abort.abort();
  await Promise.all([
    consuming.catch(() => {}),
    receivingMail.catch(() => {}),
    delivering.catch(() => {}),
  ]);
  await mailer.close();
  health.close();
  await Promise.all([visitorDb.pool.end(), publisher.close()]);
  await stopTelemetry();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
