/**
 * One delivery path for every adapter channel (D2; FEAT-036 §5.3, NFR-17, CHN-12). The
 * `messages_channel_delivery` trigger writes a `message_deliveries` row and a `channel-send`
 * job for each staff, agent or system message in a non-widget conversation; the agent-worker
 * runs `deliverMessage` per job. The row is locked, shaped (`shape.ts`) and handed to the
 * channel's sender: sent → `sent`; transient → back off (the scheduler's sweep re-queues it);
 * auth → as transient and the connection degraded at once; permanent → `failed`/`rejected`
 * and the conversation escalated. Nothing here branches on the channel kind: the sender is
 * looked up by it.
 */
import { and, eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import type { EscalationSource } from '@kaki/contracts';
import type { ChannelCapabilities, SendResult } from './adapter.js';
import { reportSendFailure } from './connections.js';
import { shapeOutbound } from './shape.js';

type ConversationRow = typeof schema.conversations.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;
export type DeliveryRow = typeof schema.messageDeliveries.$inferSelect;

/** One channel's sender (an adapter's send, with the transaction it needs to thread). */
export interface ChannelSender {
  capabilities: ChannelCapabilities;
  send(
    tx: Tx,
    input: {
      tenantId: string;
      connectionId: string;
      conversation: ConversationRow;
      message: MessageRow;
      text: string;
      businessName: string;
    },
  ): Promise<SendResult>;
}

export interface DeliverDeps {
  /** The visitor zone. */
  zdb: ZoneDb;
  senders: Partial<Record<ConversationRow['channel'], ChannelSender>>;
  /** The business name and GOV-14 privacy link for the footer (tenancy and governance). */
  footer(tx: Tx): Promise<{ businessName: string; privacyUrl: string | null }>;
  /** Opens an escalation (@kaki/inbox `requestEscalation`); a closed conversation is ignored. */
  escalate(
    tx: Tx,
    tenantId: string,
    conversationId: string,
    source: EscalationSource,
  ): Promise<void>;
  now?: () => Date;
}

export type DeliverOutcome =
  'sent' | 'not_sent' | 'retry' | 'failed' | 'already_done' | 'not_found';

export interface DeliverResult {
  outcome: DeliverOutcome;
  delivery: DeliveryRow | null;
  message: MessageRow | null;
}

/** NFR-17: 1, 2, 4 … minutes, at most an hour; the sweep gives up after 24 hours. */
export const backoffMs = (attempts: number) => Math.min(2 ** attempts, 60) * 60_000;

const d = schema.messageDeliveries;

export async function deliverMessage(
  deps: DeliverDeps,
  job: { tenantId: string; messageId: string },
): Promise<DeliverResult> {
  const now = deps.now?.() ?? new Date();
  const { tenantId, messageId } = job;
  return withTenant(deps.zdb, tenantId, async (tx) => {
    const key = and(eq(d.tenantId, tenantId), eq(d.messageId, messageId));
    const [delivery] = await tx.select().from(d).where(key).for('update');
    if (!delivery) return { outcome: 'not_found', delivery: null, message: null };
    if (delivery.status !== 'pending') return { outcome: 'already_done', delivery, message: null };
    const [message] = await tx
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.id, messageId)));
    const [conversation] = await tx
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.tenantId, tenantId),
          eq(schema.conversations.id, delivery.conversationId),
        ),
      );
    if (!message || !conversation) return { outcome: 'not_found', delivery, message: null };
    const set = async (values: Partial<typeof d.$inferInsert>) => {
      const [row] = await tx
        .update(d)
        .set({ ...values, version: sql`${d.version} + 1` })
        .where(key)
        .returning();
      return row!;
    };
    const sender = deps.senders[conversation.channel];
    const fail = async (reason: 'rejected') => {
      const row = await set({ status: 'failed', failedReason: reason, nextAttemptAt: null });
      await deps.escalate(tx, tenantId, conversation.id, 'delivery_failed');
      return { outcome: 'failed' as const, delivery: row, message };
    };
    if (!sender) return fail('rejected');
    const footer = await deps.footer(tx);
    const shaped = shapeOutbound(
      {
        author: message.author,
        body: message.body,
        notice: message.notice,
        noticeKind: message.noticeKind,
        disclosure: message.disclosure,
        card: message.card ?? null,
      },
      { capabilities: sender.capabilities, ...footer },
    );
    // A widget-only notice is "delivered" with nothing sent, so staff see no pending state.
    if (!shaped.send)
      return {
        outcome: 'not_sent',
        delivery: await set({ status: 'sent', sentAt: now, nextAttemptAt: null }),
        message,
      };
    const result = await sender.send(tx, {
      tenantId,
      connectionId: delivery.connectionId,
      conversation,
      message,
      text: shaped.text,
      businessName: footer.businessName,
    });
    if (result.ok)
      return {
        outcome: 'sent',
        delivery: await set({
          status: 'sent',
          sentAt: now,
          externalId: result.externalId,
          nextAttemptAt: null,
          attempts: delivery.attempts + 1,
        }),
        message,
      };
    if (result.failed === 'permanent') return fail('rejected');
    // CHN-12: a rejected login degrades the channel at once; the send is still retried.
    if (result.failed === 'auth') await reportSendFailure(tx, delivery.connectionId, result);
    return {
      outcome: 'retry',
      delivery: await set({
        attempts: delivery.attempts + 1,
        nextAttemptAt: new Date(now.getTime() + backoffMs(delivery.attempts + 1)),
      }),
      message,
    };
  });
}

/**
 * A permanent bounce for one of our replies (§5.3): SES names its own message ID only, so the
 * tenant and message come from `email_bounce_route()`. The delivery becomes `failed`/`bounced`
 * and the conversation is escalated once.
 */
export async function recordBounce(
  deps: Pick<DeliverDeps, 'zdb' | 'escalate'>,
  rfcMessageId: string,
): Promise<{ tenantId: string; delivery: DeliveryRow } | null> {
  const route = (
    await deps.zdb.db.execute<{ tenant_id: string; message_id: string }>(
      sql`select tenant_id, message_id from email_bounce_route(${rfcMessageId})`,
    )
  ).rows[0];
  if (!route) return null;
  return withTenant(deps.zdb, route.tenant_id, async (tx) => {
    const key = and(eq(d.tenantId, route.tenant_id), eq(d.messageId, route.message_id));
    const [row] = await tx
      .update(d)
      .set({
        status: 'failed',
        failedReason: 'bounced',
        nextAttemptAt: null,
        version: sql`${d.version} + 1`,
      })
      .where(and(key, sql`not (${d.status} = 'failed' and ${d.failedReason} = 'bounced')`))
      .returning();
    if (!row) return null;
    await deps.escalate(tx, route.tenant_id, row.conversationId, 'delivery_failed');
    return { tenantId: route.tenant_id, delivery: row };
  });
}

/** The `delivery_failed` job from the sweep (UC-27 3c): the delivery is already `timed_out`. */
export async function escalateTimedOut(
  deps: Pick<DeliverDeps, 'zdb' | 'escalate'>,
  job: { tenantId: string; conversationId: string; messageId: string },
): Promise<DeliveryRow | null> {
  return withTenant(deps.zdb, job.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(d)
      .where(and(eq(d.tenantId, job.tenantId), eq(d.messageId, job.messageId)));
    if (!row || row.status !== 'failed') return null;
    await deps.escalate(tx, job.tenantId, job.conversationId, 'delivery_failed');
    return row;
  });
}

/** The contract's delivery state (FEAT-036 §3): `pending` reads as `sending`. */
export function deliveryView(row: DeliveryRow | null) {
  if (!row) return null;
  return {
    status: row.status === 'pending' ? ('sending' as const) : row.status,
    failedReason: row.failedReason,
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}
