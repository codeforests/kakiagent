import { and, eq, gte, schema, sql, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditId } from '@kaki/governance';
import {
  appendSystemNotice,
  ConversationClosedError,
  requestEscalation,
  transition,
  type ConversationRow,
  type MessageRow,
  type TenantHours,
} from '@kaki/inbox';
import { cancelNotifications, notify } from '@kaki/platform/notifications';
import { approverIds } from './drafts.js';
import { expiredNotice } from './quote.js';

const { approvals } = schema;

export type ApprovalTimer = 'urgent' | 'sla' | 'expire';

export interface TimerResult {
  outcome: 'alerted' | 'escalated' | 'expired' | 'skipped';
  /** A notice to publish after commit (the expiry notice). */
  message: MessageRow | null;
  /** A conversation that moved (escalated, or back to `ai`): publish after commit. */
  conversation: ConversationRow | null;
}

const SKIPPED: TimerResult = { outcome: 'skipped', message: null, conversation: null };

/**
 * Runs one due timer (APR-04, APR-06; UC-22 5d; FEAT-055 §5.1, D10), on the visitor zone in
 * the agent-worker. A stale timer does nothing (ADR-012): `urgent` and `sla` act only while
 * the approval is pending, and `expire` only once (the sweep marked the row `expired`; the
 * notice is sent unless it already was).
 */
export async function runApprovalTimer(
  tx: Tx,
  input: {
    tenantId: string;
    approvalId: string;
    timer: ApprovalTimer;
    hours: TenantHours | null;
    now?: Date;
  },
): Promise<TimerResult> {
  const { tenantId, approvalId } = input;
  const [row] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.tenantId, tenantId), eq(approvals.id, approvalId)));
  if (!row) return SKIPPED;
  const subject = { type: 'approval', id: approvalId } as const;

  if (input.timer === 'urgent') {
    if (row.status !== 'pending') return SKIPPED;
    await notify(tx, {
      tenantId,
      kind: 'approval_pending',
      recipients: await approverIds(tx),
      urgent: true,
      subject,
      dedupeKey: `approval:${approvalId}:urgent`,
    });
    return { outcome: 'alerted', message: null, conversation: null };
  }

  if (input.timer === 'sla') {
    if (row.status !== 'pending') return SKIPPED;
    try {
      // No visitor notice: they already have the expected time (§5.1).
      const r = await requestEscalation(tx, {
        tenantId,
        conversationId: row.conversationId,
        source: 'approval_sla',
        hours: input.hours,
        ...(input.now ? { now: input.now } : {}),
      });
      return {
        outcome: r.status === 'escalated' ? 'escalated' : 'skipped',
        message: null,
        conversation: r.status === 'escalated' ? r.conversation : null,
      };
    } catch (err) {
      if (err instanceof ConversationClosedError) return SKIPPED;
      throw err;
    }
  }

  if (row.status !== 'expired') return SKIPPED;
  const m = schema.messages;
  const [already] = await tx
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.tenantId, tenantId),
        eq(m.conversationId, row.conversationId),
        eq(m.noticeKind, 'approval_expired'),
        gte(m.createdAt, row.createdAt),
      ),
    )
    .limit(1);
  if (already) return SKIPPED;
  const message = await appendSystemNotice(tx, {
    tenantId,
    conversationId: row.conversationId,
    kind: 'approval_expired',
    text: expiredNotice,
  });
  const c = schema.conversations;
  const [conv] = await tx
    .select({ status: c.status })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.id, row.conversationId)));
  const conversation =
    conv?.status === 'waiting_approval'
      ? await transition(tx, {
          tenantId,
          conversationId: row.conversationId,
          to: 'ai',
          actor: { type: 'system' },
        })
      : null;
  await cancelNotifications(tx, tenantId, subject);
  await audit.append(tx, tenantId, {
    action: 'approval.expired',
    actorType: 'system',
    subjectType: 'conversation',
    subjectId: row.conversationId,
    related: [{ type: 'approval', id: approvalId }],
    payload: { approvalId: auditId(approvalId) },
  });
  return { outcome: 'expired', message, conversation };
}

/** The scheduler's sweep (D10): marks and queues every due timer, across tenants. */
export async function queueApprovalTimers(
  zdb: ZoneDb,
): Promise<{ tenantId: string; queued: number }[]> {
  const res = await zdb.db.execute<{ tenant_id: string; queued: number }>(
    sql`select * from approvals_queue_due()`,
  );
  return res.rows.map((r) => ({ tenantId: r.tenant_id, queued: r.queued }));
}
