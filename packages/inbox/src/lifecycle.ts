import { and, eq, schema, sql, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, type ActorType } from '@kaki/governance';

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
  human: ['ai', 'closed'],
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
] as const;

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
