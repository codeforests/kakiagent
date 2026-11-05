import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import {
  appendSystemMessage,
  appendSystemNotice,
  transition,
  type ConversationRow,
  type MessageRow,
} from '@kaki/inbox';
import { cancelNotifications, notify } from '@kaki/platform/notifications';
import { approverIds, type ApprovalRow } from './drafts.js';
import { quoteText, rejectedNotice, totalsOf, type GstNote, type Terms } from './quote.js';

const { approvals } = schema;

/** Someone decided first, or the row changed since it was loaded (APR-06, UC-22 5c): 409. */
export class AlreadyDecided extends Error {
  override name = 'AlreadyDecided';
  constructor(readonly approval: ApprovalRow) {
    super('approval already decided');
  }
}
/** Past its 7 days (APR-06): can no longer be sent. 409 `expired`. */
export class ApprovalExpired extends Error {
  override name = 'ApprovalExpired';
}
export class ApprovalNotFound extends Error {
  override name = 'ApprovalNotFound';
}
/** `edit_approve` with no lines and no note: nothing to send. 422 `invalid_terms`. */
export class InvalidTerms extends Error {
  override name = 'InvalidTerms';
}

export type Decision =
  | { action: 'approve'; version: number }
  | { action: 'edit_approve'; version: number; terms: Terms }
  | { action: 'reject'; version: number; reason: string };

export type Outcome = 'approved' | 'edited_approved' | 'rejected';

export interface DecideResult {
  approval: ApprovalRow;
  /** The quote message or the rejection notice: publish after commit. */
  message: MessageRow;
  /** Set when the conversation moved (`waiting_approval` → `ai`): publish after commit. */
  conversation: ConversationRow | null;
}

/** The quote's GST note, as drafted (`request.gst`). */
export const gstOf = (row: Pick<ApprovalRow, 'request'>): GstNote => {
  const g = (row.request as { gst?: unknown }).gst;
  return g === 'inclusive' || g === 'exclusive' ? g : 'none';
};

/**
 * Records one decision (APR-02, APR-06; UC-22 5, 5a, 5c; FEAT-055 §5.1), on the dashboard
 * zone: the first decision on the loaded version wins (a conditional update, so two at once
 * record one), the result is delivered in the same transaction, the approval's alerts are
 * cancelled, and one code-only `approval.decided` entry is audited (the reason stays on the
 * row, D9).
 */
export async function decide(
  tx: Tx,
  input: { tenantId: string; approvalId: string; userId: string; decision: Decision; now?: Date },
): Promise<DecideResult> {
  const { tenantId, approvalId, userId, decision } = input;
  const now = input.now ?? new Date();
  const [row] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.tenantId, tenantId), eq(approvals.id, approvalId)))
    .for('update');
  if (!row) throw new ApprovalNotFound('approval not found');
  if (row.status === 'expired' || (row.status === 'pending' && row.expiresAt <= now))
    throw new ApprovalExpired('approval expired');
  if (row.status !== 'pending' || row.version !== decision.version) throw new AlreadyDecided(row);
  if (
    decision.action === 'edit_approve' &&
    decision.terms.lines.length === 0 &&
    !decision.terms.note.trim()
  )
    throw new InvalidTerms('nothing to send');
  if (decision.action === 'edit_approve' && totalsOf(decision.terms, 'none').totalCents < 0)
    throw new InvalidTerms('total below zero');

  const outcome: Outcome =
    decision.action === 'approve'
      ? 'approved'
      : decision.action === 'edit_approve'
        ? 'edited_approved'
        : 'rejected';
  const final =
    decision.action === 'approve'
      ? row.draft
      : decision.action === 'edit_approve'
        ? (decision.terms as unknown as Record<string, unknown>)
        : null;
  const [decided] = await tx
    .update(approvals)
    .set({
      status: outcome,
      final,
      decidedBy: userId,
      decidedAt: now,
      reason: decision.action === 'reject' ? decision.reason.trim() : null,
      version: sql`${approvals.version} + 1`,
    })
    .where(
      and(
        eq(approvals.tenantId, tenantId),
        eq(approvals.id, approvalId),
        eq(approvals.status, 'pending'),
        eq(approvals.version, decision.version),
      ),
    )
    .returning();
  if (!decided) throw new AlreadyDecided(row);

  const delivered = await deliver(tx, decided, outcome, userId);
  await cancelNotifications(tx, tenantId, { type: 'approval', id: approvalId }, 'approval_pending');
  await audit.append(tx, tenantId, {
    action: 'approval.decided',
    actorType: 'user',
    actorId: userId,
    subjectType: 'conversation',
    subjectId: decided.conversationId,
    related: [{ type: 'approval', id: approvalId }],
    payload: {
      approvalId: auditId(approvalId),
      outcome: auditCode(delivered.approval.status),
      edited: outcome === 'edited_approved',
    },
  });
  return delivered;
}

async function businessName(tx: Tx, tenantId: string): Promise<string> {
  const [t] = await tx
    .select({ name: schema.tenants.name })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  return t?.name ?? '';
}

/**
 * Sends the decision to the visitor (APR-06, UC-22 6, 6a; D7): an approval stores the quote
 * card (code-built from the approver's values, never the composer, D2), a rejection the
 * follow-up notice, even on a closed conversation, which stays closed. Closed with no email
 * or phone on the contact → `undeliverable` and the approvers and the decider are told.
 * `waiting_approval` returns to `ai`.
 */
export async function deliver(
  tx: Tx,
  row: ApprovalRow,
  outcome: Outcome,
  deciderId: string,
): Promise<DecideResult> {
  const { tenantId, conversationId } = row;
  const c = schema.conversations;
  const [conv] = await tx
    .select({ status: c.status, contactId: c.contactId })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.id, conversationId)));
  let message: MessageRow;
  if (outcome === 'rejected') {
    message = await appendSystemNotice(tx, {
      tenantId,
      conversationId,
      kind: 'approval_rejected',
      text: rejectedNotice,
    });
  } else {
    const terms = row.final as unknown as Terms;
    const totals = totalsOf(terms, gstOf(row));
    const business = await businessName(tx, tenantId);
    message = await appendSystemMessage(tx, {
      tenantId,
      conversationId,
      body: (language) => quoteText(language, business, terms, totals),
      card: { kind: 'quote', approvalId: row.id, ...terms, totals },
    });
  }

  let reachable = conv?.status !== 'closed';
  if (!reachable && conv?.contactId) {
    const k = schema.contacts;
    const [contact] = await tx
      .select({ email: k.email, phone: k.phone })
      .from(k)
      .where(and(eq(k.tenantId, tenantId), eq(k.id, conv.contactId)));
    reachable = Boolean(contact?.email || contact?.phone);
  }
  const [updated] = await tx
    .update(approvals)
    .set({
      deliveredMessageId: message.id,
      ...(reachable ? {} : { status: 'undeliverable' as const }),
    })
    .where(and(eq(approvals.tenantId, tenantId), eq(approvals.id, row.id)))
    .returning();
  if (!reachable)
    await notify(tx, {
      tenantId,
      kind: 'approval_undeliverable',
      recipients: [...(await approverIds(tx)), deciderId],
      subject: { type: 'approval', id: row.id },
      dedupeKey: `approval:${row.id}:undeliverable`,
    });

  const conversation =
    conv?.status === 'waiting_approval'
      ? await transition(tx, {
          tenantId,
          conversationId,
          to: 'ai',
          actor: { type: 'user', id: deciderId },
        })
      : null;
  return { approval: updated!, message, conversation };
}
