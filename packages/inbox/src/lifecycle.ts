import { and, eq, schema, sql, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, type ActorType } from '@kaki/governance';
import { cancelNotifications } from '@kaki/platform/notifications';

/**
 * The conversation lifecycle (INB-08, ADR-013 d1; FEAT-042 §5.1). Every write of
 * `conversations.status` goes through `transition`: it applies the edge table, compares
 * and sets on `version`, and writes exactly one audit entry with codes only (D6).
 */

export type ConversationStatus = (typeof schema.CONVERSATION_STATUSES)[number];
export type CloseReason = (typeof schema.CLOSE_REASONS)[number];
type Row = typeof schema.conversations.$inferSelect;

/** INB-08's edges. FEAT-042 uses `→ closed` and `closed → ai`; the rest are FEAT-043/044/055's. */
export const TRANSITIONS: Readonly<Record<ConversationStatus, readonly ConversationStatus[]>> = {
  ai: ['escalated', 'human', 'waiting_approval', 'closed'],
  escalated: ['ai', 'human', 'closed'],
  /** Hand-back during a pending approval lands in `waiting_approval` (FEAT-055 D5). */
  human: ['ai', 'waiting_approval', 'closed'],
  waiting_approval: ['ai', 'escalated', 'human', 'closed'],
  closed: ['ai'],
};

export const canTransition = (from: ConversationStatus, to: ConversationStatus) =>
  TRANSITIONS[from].includes(to);

/** How long a conversation may be quiet before it closes (INB-08); mirrors `inbox_queue_auto_close()`. */
export const IDLE_MS = { widget: 30 * 60_000, other: 72 * 3_600_000 } as const;
export const idleMs = (channel: string) => (channel === 'widget' ? IDLE_MS.widget : IDLE_MS.other);
/** A staff or inactivity close reopens on a visitor message within this window (INB-08, D5). */
export const REOPEN_MS = 7 * 24 * 3_600_000;
const REOPENABLE: readonly CloseReason[] = ['staff', 'inactive'];

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ConversationStatus,
    readonly to: ConversationStatus,
  ) {
    super(`illegal transition ${from} → ${to}`);
  }
}
/** The version moved (or the row changed under us): carries the current row. */
export class StateChangedError extends Error {
  constructor(readonly conversation: Row) {
    super('conversation state changed');
  }
}
export class AlreadyClosedError extends Error {
  constructor(readonly conversation: Row) {
    super('conversation already closed');
  }
}
export class ConversationNotFoundError extends Error {}
/** A new visitor message (FEAT-033 D5) or an escalation (FEAT-044) to a closed conversation: the API answers 409. */
export class ConversationClosedError extends Error {}
/** Someone else owns the conversation (INB-09; FEAT-043): carries who. */
export class OwnedError extends Error {
  constructor(readonly owner: { userId: string; visitorName: string | null }) {
    super('conversation owned by someone else');
  }
}

export type LifecycleActor =
  | { type: 'user'; id: string }
  | { type: 'visitor'; id: string }
  | { type: 'agent' }
  | { type: 'system' };

const CLOSE_ACTIONS: Record<CloseReason, string> = {
  staff: 'conversation.closed',
  inactive: 'conversation.auto_closed',
  abuse: 'conversation.ai_ended',
  visitor: 'conversation.visitor_ended',
};
/** Every audit action a lifecycle change writes (the thread's dividers read these, §5.2). */
export const LIFECYCLE_ACTIONS = [
  ...Object.values(CLOSE_ACTIONS),
  'conversation.reopened',
  'conversation.state_changed',
  /** An owner or admin took it from its owner (FEAT-043 D1). */
  'conversation.owner_changed',
  /** Someone asked the owner for it (FEAT-043 §5.1); not a state change. */
  'conversation.handover_requested',
  /** An escalation opened and was routed (FEAT-044 §5.1): the "Escalated to {name}" divider. */
  'escalation.assigned',
] as const;

export type EscalationResolution = (typeof schema.ESCALATION_RESOLUTIONS)[number];

/**
 * Resolves the conversation's open escalation, if any, and cancels its alerts not yet sent
 * (pending and held), so no reminder or digest mentions it (FEAT-044 §5.1). `transition` calls
 * it on every move out of `escalated`; `remindEscalation` as a safety net.
 */
export async function resolveEscalation(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    resolution: EscalationResolution;
    by: string | null;
  },
): Promise<boolean> {
  const e = schema.escalations;
  const resolved = await tx
    .update(e)
    .set({ resolvedAt: sql`now()`, resolution: input.resolution, resolvedBy: input.by })
    .where(
      and(
        eq(e.tenantId, input.tenantId),
        eq(e.conversationId, input.conversationId),
        sql`${e.resolvedAt} is null`,
      ),
    )
    .returning({ id: e.id });
  const subject = { type: 'conversation', id: input.conversationId } as const;
  await cancelNotifications(tx, input.tenantId, subject, 'escalation');
  await cancelNotifications(tx, input.tenantId, subject, 'escalation_reminder');
  return resolved.length > 0;
}

async function lockRow(tx: Tx, tenantId: string, conversationId: string): Promise<Row> {
  const c = schema.conversations;
  const [row] = await tx
    .select()
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.id, conversationId)))
    .for('update');
  if (!row) throw new ConversationNotFoundError('conversation not found');
  return row;
}

export interface TransitionInput {
  tenantId: string;
  conversationId: string;
  to: ConversationStatus;
  /** Required on `→ closed`; ignored otherwise. */
  reason?: CloseReason;
  actor: LifecycleActor;
  /** When given, a different current version is refused with `StateChangedError`. */
  expectedVersion?: number;
}

export async function transition(tx: Tx, input: TransitionInput): Promise<Row> {
  const current = await lockRow(tx, input.tenantId, input.conversationId);
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion)
    throw new StateChangedError(current);
  const from = current.status;
  if (!canTransition(from, input.to)) throw new IllegalTransitionError(from, input.to);
  const closing = input.to === 'closed';
  if (closing && !input.reason) throw new Error('transition: a close needs a reason');
  const c = schema.conversations;
  const [row] = await tx
    .update(c)
    .set({
      status: input.to,
      version: sql`${c.version} + 1`,
      closedAt: closing ? sql`now()` : null,
      closeReason: closing ? input.reason! : null,
    })
    .where(
      and(
        eq(c.tenantId, input.tenantId),
        eq(c.id, input.conversationId),
        eq(c.version, current.version),
      ),
    )
    .returning();
  if (!row) throw new StateChangedError(await lockRow(tx, input.tenantId, input.conversationId));
  // A close or a hand-back leaves no owner (FEAT-043 §5.1): every close path runs through here.
  if (closing || (from === 'human' && (input.to === 'ai' || input.to === 'waiting_approval'))) {
    const o = schema.conversationOwners;
    await tx
      .delete(o)
      .where(and(eq(o.tenantId, input.tenantId), eq(o.conversationId, input.conversationId)));
  }
  // Every claim, close and return resolves the open escalation and drops its alerts (§5.1).
  if (from === 'escalated')
    await resolveEscalation(tx, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      resolution: input.to === 'human' ? 'claimed' : input.to === 'closed' ? 'closed' : 'returned',
      by: input.actor.type === 'user' ? input.actor.id : null,
    });
  const reopening = from === 'closed';
  const action = closing
    ? CLOSE_ACTIONS[input.reason!]
    : reopening
      ? 'conversation.reopened'
      : 'conversation.state_changed';
  await audit.append(tx, input.tenantId, {
    action,
    actorType: input.actor.type satisfies ActorType,
    ...('id' in input.actor ? { actorId: input.actor.id } : {}),
    subjectType: 'conversation',
    subjectId: input.conversationId,
    payload: {
      from: auditCode(from),
      to: auditCode(input.to),
      reason: closing ? auditCode(input.reason!) : reopening ? auditCode('reopened') : null,
    },
  });
  return row;
}

/** Staff close a conversation from the thread (INB-08; FEAT-042 §3 close route). */
export async function closeByStaff(
  tx: Tx,
  input: { tenantId: string; conversationId: string; userId: string; version: number },
): Promise<Row> {
  const current = await lockRow(tx, input.tenantId, input.conversationId);
  // A stale version wins over "already closed": the client hasn't seen the latest state.
  if (current.version !== input.version) throw new StateChangedError(current);
  if (current.status === 'closed') throw new AlreadyClosedError(current);
  // Only the owner closes a taken-over conversation (FEAT-043 D6).
  const o = schema.conversationOwners;
  const [owner] = await tx
    .select({ userId: o.userId, visitorName: o.visitorName })
    .from(o)
    .where(and(eq(o.tenantId, input.tenantId), eq(o.conversationId, input.conversationId)));
  if (owner && owner.userId !== input.userId) throw new OwnedError(owner);
  return transition(tx, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    to: 'closed',
    reason: 'staff',
    actor: { type: 'user', id: input.userId },
    expectedVersion: input.version,
  });
}

/**
 * The agent-worker's half of auto-close (D3): closes the conversation with reason
 * `inactive` only if it is still open and still idle by `idleMs`; otherwise null. A
 * duplicate job is a no-op.
 */
export async function autoCloseIdle(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<Row | null> {
  let current: Row;
  try {
    current = await lockRow(tx, tenantId, conversationId);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) return null;
    throw err;
  }
  if (current.status === 'closed') return null;
  if (now.getTime() - current.lastMessageAt.getTime() < idleMs(current.channel)) return null;
  return transition(tx, {
    tenantId,
    conversationId,
    to: 'closed',
    reason: 'inactive',
    actor: { type: 'system' },
  });
}

/** Whether a closed conversation reopens on a new visitor message (INB-08, D5). */
export function reopenable(row: Row, now: Date = new Date()): boolean {
  return (
    row.status === 'closed' &&
    row.closeReason !== null &&
    REOPENABLE.includes(row.closeReason) &&
    row.closedAt !== null &&
    now.getTime() - row.closedAt.getTime() < REOPEN_MS
  );
}

export interface AutoCloseQueued {
  tenantId: string;
  queued: number;
}

/** The scheduler's half (D3): runs `inbox_queue_auto_close()` on the outbox zone. */
export async function queueAutoClose(zdb: ZoneDb): Promise<AutoCloseQueued[]> {
  const res = await zdb.db.execute<{ tenant_id: string; queued: number }>(
    sql`select tenant_id, queued from inbox_queue_auto_close()`,
  );
  return res.rows.map((r) => ({ tenantId: r.tenant_id, queued: Number(r.queued) }));
}
