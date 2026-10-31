import { and, desc, eq, inArray, or, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import { piiMask } from '@kaki/platform';
import {
  ConversationNotFoundError,
  OwnedError,
  StateChangedError,
  transition,
} from './lifecycle.js';
import type { ConversationRow, MessageRow } from './mappers.js';

/**
 * Take over and hand back, one owner at a time (INB-02, INB-09, ADR-013 d2; FEAT-043 §5.1).
 * The `conversation_owners` primary key decides a simultaneous take-over; `transition` moves
 * the status in the same transaction and deletes the row on every close and on hand-back.
 */

/** The caller already owns it. */
export class AlreadyOwnerError extends Error {}
/** Only the owner may do this; carries the current conversation row. */
export class NotOwnerError extends Error {
  constructor(readonly conversation: ConversationRow) {
    super('not the owner');
  }
}
/** Nobody owns it: take it over instead of requesting it. */
export class NotOwnedError extends Error {}

export interface Owner {
  userId: string;
  /** The display-name snapshot the visitor sees; null → "A team member" (D3). */
  visitorName: string | null;
  since: Date;
}

const o = schema.conversationOwners;
const c = schema.conversations;
const m = schema.messages;

export async function ownerOf(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<Owner | null> {
  const [row] = await tx
    .select({ userId: o.userId, visitorName: o.visitorName, since: o.since })
    .from(o)
    .where(and(eq(o.tenantId, tenantId), eq(o.conversationId, conversationId)));
  return row ?? null;
}

/** Owners of a page of conversations, by conversation ID. */
export async function ownersOf(
  tx: Tx,
  tenantId: string,
  conversationIds: readonly string[],
): Promise<Map<string, Owner>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await tx
    .select({
      conversationId: o.conversationId,
      userId: o.userId,
      visitorName: o.visitorName,
      since: o.since,
    })
    .from(o)
    .where(and(eq(o.tenantId, tenantId), inArray(o.conversationId, [...conversationIds])));
  return new Map(rows.map(({ conversationId, ...owner }) => [conversationId, owner]));
}

export type StaffNoticeKind = 'staff_joined' | 'staff_left';
type Lang = 'en' | 'zh';

/** The visitor-facing notice texts (D4), with the snapshot name or "A team member". */
export function staffNoticeText(kind: StaffNoticeKind, name: string | null, lang: Lang): string {
  if (lang === 'zh') {
    const who = name ?? '团队成员';
    return kind === 'staff_joined'
      ? `${who}已加入对话。`
      : `${who}已离开对话，AI 助手会继续为您服务。`;
  }
  const who = name ?? 'A team member';
  return kind === 'staff_joined'
    ? `${who} joined the chat.`
    : `${who} left the chat. The assistant will keep helping you.`;
}

/** The conversation's language: that of its latest agent or system message, else English. */
async function conversationLanguage(tx: Tx, tenantId: string, conversationId: string) {
  const [row] = await tx
    .select({ language: m.language })
    .from(m)
    .where(
      and(
        eq(m.tenantId, tenantId),
        eq(m.conversationId, conversationId),
        or(eq(m.author, 'agent'), eq(m.author, 'system')),
        sql`${m.language} is not null`,
      ),
    )
    .orderBy(desc(m.seq))
    .limit(1);
  return row?.language ?? 'en';
}

const touch = (tx: Tx, tenantId: string, conversationId: string) =>
  tx
    .update(c)
    .set({ lastMessageAt: sql`now()` })
    .where(and(eq(c.tenantId, tenantId), eq(c.id, conversationId)));

/** Stores the staff joined or left notice: a system message in the conversation's language. */
export async function staffNotice(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    kind: StaffNoticeKind;
    userId: string;
    name: string | null;
  },
): Promise<MessageRow> {
  const language = await conversationLanguage(tx, input.tenantId, input.conversationId);
  const [row] = await tx
    .insert(m)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      author: 'system',
      body: '',
      notice: staffNoticeText(input.kind, input.name, language),
      noticeKind: input.kind,
      authorUserId: input.userId,
      authorName: input.name,
      language,
    })
    .returning();
  await touch(tx, input.tenantId, input.conversationId);
  return row!;
}

async function lockConversation(tx: Tx, tenantId: string, conversationId: string) {
  const [row] = await tx
    .select()
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.id, conversationId)))
    .for('update');
  if (!row) throw new ConversationNotFoundError('conversation not found');
  return row;
}

export interface TakeOverInput {
  tenantId: string;
  conversationId: string;
  userId: string;
  /** The display-name snapshot (identity `displayNameOf`, D3). */
  visitorName: string | null;
  version: number;
  /** Take it from this owner (owners and admins; the API checks `inbox.reassign`, D1). */
  from?: string | undefined;
}

export interface TakeOverResult {
  conversation: ConversationRow;
  notice: MessageRow;
  /** Set when it was taken from someone (D1): tell them. */
  previousOwner?: string;
}

/**
 * Takes the conversation over (UC-23 3). The insert decides a race: a second caller blocks on
 * the primary key until the first commits, inserts nothing and gets `OwnedError` naming the
 * winner (INB-09). A closed conversation, or a stale version, rolls the insert back with it.
 */
export async function takeOver(tx: Tx, input: TakeOverInput): Promise<TakeOverResult> {
  const { tenantId, conversationId, userId } = input;
  if (input.from !== undefined) {
    if (input.from === userId) throw new AlreadyOwnerError('already the owner');
    const current = await lockConversation(tx, tenantId, conversationId);
    const [moved] = await tx
      .update(o)
      .set({ userId, visitorName: input.visitorName, since: sql`now()` })
      .where(
        and(
          eq(o.tenantId, tenantId),
          eq(o.conversationId, conversationId),
          eq(o.userId, input.from),
        ),
      )
      .returning();
    if (moved) {
      if (current.version !== input.version) throw new StateChangedError(current);
      await audit.append(tx, tenantId, {
        action: 'conversation.owner_changed',
        actorType: 'user',
        actorId: userId,
        subjectType: 'conversation',
        subjectId: conversationId,
        related: [{ type: 'user', id: input.from }],
        payload: {
          from: auditCode('human'),
          to: auditCode('human'),
          reason: auditCode('taken_from'),
        },
      });
      const notice = await staffNotice(tx, {
        tenantId,
        conversationId,
        kind: 'staff_joined',
        userId,
        name: input.visitorName,
      });
      return { conversation: current, notice, previousOwner: input.from };
    }
    const owner = await ownerOf(tx, tenantId, conversationId);
    if (owner?.userId === userId) throw new AlreadyOwnerError('already the owner');
    if (owner) throw new OwnedError(owner);
    // `from` no longer owns it and nobody else does: an ordinary take-over follows.
  }
  const inserted = await tx
    .insert(o)
    .values({ tenantId, conversationId, userId, visitorName: input.visitorName })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    const owner = await ownerOf(tx, tenantId, conversationId);
    if (!owner) throw new ConversationNotFoundError('conversation not found');
    if (owner.userId === userId) throw new AlreadyOwnerError('already the owner');
    throw new OwnedError(owner);
  }
  const conversation = await transition(tx, {
    tenantId,
    conversationId,
    to: 'human',
    actor: { type: 'user', id: userId },
    expectedVersion: input.version,
  });
  const notice = await staffNotice(tx, {
    tenantId,
    conversationId,
    kind: 'staff_joined',
    userId,
    name: input.visitorName,
  });
  return { conversation, notice };
}

/** The owner hands back to the AI (UC-23 5): no owner, status `ai`, the left notice. */
export async function handBack(
  tx: Tx,
  input: { tenantId: string; conversationId: string; userId: string; version: number },
): Promise<{ conversation: ConversationRow; notice: MessageRow }> {
  const { tenantId, conversationId, userId } = input;
  const [mine] = await tx
    .delete(o)
    .where(
      and(eq(o.tenantId, tenantId), eq(o.conversationId, conversationId), eq(o.userId, userId)),
    )
    .returning();
  if (!mine) throw new NotOwnerError(await lockConversation(tx, tenantId, conversationId));
  const conversation = await transition(tx, {
    tenantId,
    conversationId,
    to: 'ai',
    actor: { type: 'user', id: userId },
    expectedVersion: input.version,
  });
  const notice = await staffNotice(tx, {
    tenantId,
    conversationId,
    kind: 'staff_left',
    userId,
    name: mine.visitorName,
  });
  return { conversation, notice };
}

/** Asks the owner for the conversation (INB-09): one audit entry; returns the owner's ID. */
export async function requestHandover(
  tx: Tx,
  input: { tenantId: string; conversationId: string; userId: string },
): Promise<string> {
  const owner = await ownerOf(tx, input.tenantId, input.conversationId);
  if (!owner) throw new NotOwnedError('nobody owns it');
  if (owner.userId === input.userId) throw new AlreadyOwnerError('already the owner');
  await audit.append(tx, input.tenantId, {
    action: 'conversation.handover_requested',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'conversation',
    subjectId: input.conversationId,
    related: [{ type: 'user', id: owner.userId }],
    payload: { reason: auditCode('handover_requested') },
  });
  return owner.userId;
}

/**
 * The owner's reply to the visitor (INB-02): masked at the edge (ADR-015), labelled with the
 * owner's snapshot name, and idempotent on `clientMessageId` (a retry returns the stored row).
 */
export async function sendStaffMessage(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    userId: string;
    body: string;
    clientMessageId: string;
  },
): Promise<{ message: MessageRow; created: boolean }> {
  const { tenantId, conversationId, userId } = input;
  const [owner] = await tx
    .select({ userId: o.userId, visitorName: o.visitorName })
    .from(o)
    .where(and(eq(o.tenantId, tenantId), eq(o.conversationId, conversationId)))
    .for('share');
  const stored = async () => {
    const [row] = await tx
      .select()
      .from(m)
      .where(
        and(
          eq(m.tenantId, tenantId),
          eq(m.conversationId, conversationId),
          eq(m.clientMessageId, input.clientMessageId),
          eq(m.author, 'staff'),
          eq(m.authorUserId, userId),
        ),
      );
    return row;
  };
  if (owner?.userId !== userId) {
    // A retry of a message sent before a hand-back still returns it.
    const prior = await stored();
    if (prior) return { message: prior, created: false };
    throw new NotOwnerError(await lockConversation(tx, tenantId, conversationId));
  }
  const [inserted] = await tx
    .insert(m)
    .values({
      tenantId,
      conversationId,
      author: 'staff',
      body: piiMask(input.body),
      clientMessageId: input.clientMessageId,
      authorUserId: userId,
      authorName: owner.visitorName,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const prior = await stored();
    if (!prior) throw new Error('client message ID already used');
    return { message: prior, created: false };
  }
  await touch(tx, tenantId, conversationId);
  return { message: inserted, created: true };
}
