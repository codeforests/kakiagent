import type { ConversationSummary, Message } from '@kaki/contracts';
import { and, asc, desc, eq, gt, gte, lte, schema, sql, type Tx } from '@kaki/db';
import { audit } from '@kaki/governance';
import { piiMask } from '@kaki/platform';
import { enqueue } from '@kaki/platform/outbox';

/**
 * Conversation and message repository. Every function takes a transaction opened by
 * `withTenant`, so RLS applies; the explicit `tenant_id` predicates are a second
 * guard, not the only one (ADR-005). The state machine, takeover and the send gate
 * arrive with FEAT-040+ (ADR-013).
 */

export class NotFoundError extends Error {}

type MessageRow = typeof schema.messages.$inferSelect;
export type NoticeKind = (typeof schema.NOTICE_KINDS)[number];
type ConversationRow = typeof schema.conversations.$inferSelect;

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    author: row.author,
    body: row.body,
    inReplyTo: row.inReplyTo,
    disclosure: row.disclosure,
    notice: row.notice,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSummary(row: ConversationRow, lastMessage: string | null): ConversationSummary {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessage,
  };
}

export async function createConversation(
  tx: Tx,
  tenantId: string,
  visitorId: string,
): Promise<ConversationRow> {
  const [row] = await tx
    .insert(schema.conversations)
    .values({ tenantId, visitorId, channel: 'widget' })
    .returning();
  await audit.append(tx, tenantId, {
    action: 'conversation.started',
    actorType: 'visitor',
    actorId: visitorId,
    subjectType: 'conversation',
    subjectId: row!.id,
  });
  return row!;
}

async function visitorConversation(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  visitorId: string,
) {
  const [conv] = await tx
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.tenantId, tenantId),
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.visitorId, visitorId),
      ),
    );
  if (!conv) throw new NotFoundError('conversation not found');
  return conv;
}

/**
 * Stores a visitor message (masked at the edge, GOV-04) and, in the same transaction,
 * the outbox row that schedules the agent turn (ADR-012). Idempotent on
 * `clientMessageId`: a retried POST returns the original message and schedules nothing.
 */
export async function appendVisitorMessage(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    visitorId: string;
    text: string;
    clientMessageId: string;
  },
): Promise<{ message: MessageRow; created: boolean; conversation: ConversationRow }> {
  const conversation = await visitorConversation(
    tx,
    input.tenantId,
    input.conversationId,
    input.visitorId,
  );
  const [inserted] = await tx
    .insert(schema.messages)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      author: 'visitor',
      body: piiMask(input.text),
      clientMessageId: input.clientMessageId,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.tenantId, input.tenantId),
          eq(schema.messages.conversationId, input.conversationId),
          eq(schema.messages.clientMessageId, input.clientMessageId),
        ),
      );
    if (!existing) throw new Error('message conflict without a matching row');
    return { message: existing, created: false, conversation };
  }
  const [updated] = await tx
    .update(schema.conversations)
    .set({ lastMessageAt: inserted.createdAt })
    .where(
      and(
        eq(schema.conversations.tenantId, input.tenantId),
        eq(schema.conversations.id, input.conversationId),
      ),
    )
    .returning();
  await enqueue(tx, {
    tenantId: input.tenantId,
    topic: 'conversation-turns',
    groupKey: input.conversationId,
    payload: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: inserted.id,
    },
  });
  await audit.append(tx, input.tenantId, {
    action: 'message.received',
    actorType: 'visitor',
    actorId: input.visitorId,
    subjectType: 'message',
    subjectId: inserted.id,
    related: [{ type: 'conversation', id: input.conversationId }],
  });
  return { message: inserted, created: true, conversation: updated ?? conversation };
}

export async function getMessage(
  tx: Tx,
  tenantId: string,
  messageId: string,
): Promise<MessageRow | null> {
  const [row] = await tx
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.id, messageId)));
  return row ?? null;
}

/**
 * Stores the reply to a visitor message: the agent's answer, or a system text such as
 * the fallback (NFR-04). Returns null when a reply already exists (the unique
 * `in_reply_to` index makes turn processing idempotent under SQS at-least-once
 * delivery).
 */
export async function appendAgentReply(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    inReplyTo: string;
    text: string;
    author?: 'agent' | 'system';
    /** The facts the reply's slots rendered (AGT-01). */
    factIds?: string[];
    /** Set on the first agent or system message of the conversation (AGT-11). */
    disclosure?: string | null;
    /** A system notice shown with the reply (AGT-09 after hours; FEAT-023 D6). */
    notice?: { kind: NoticeKind; text: string } | null;
  },
): Promise<{ message: MessageRow; conversation: ConversationRow } | null> {
  const [inserted] = await tx
    .insert(schema.messages)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      author: input.author ?? 'agent',
      body: input.text,
      inReplyTo: input.inReplyTo,
      factIds: input.factIds ?? [],
      disclosure: input.disclosure ?? null,
      notice: input.notice?.text ?? null,
      noticeKind: input.notice?.kind ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) return null;
  const [conversation] = await tx
    .update(schema.conversations)
    .set({ lastMessageAt: inserted.createdAt })
    .where(
      and(
        eq(schema.conversations.tenantId, input.tenantId),
        eq(schema.conversations.id, input.conversationId),
      ),
    )
    .returning();
  await audit.append(tx, input.tenantId, {
    action: 'message.ai_sent',
    actorType: 'agent',
    subjectType: 'message',
    subjectId: inserted.id,
    related: [{ type: 'conversation', id: input.conversationId }],
  });
  return { message: inserted, conversation: conversation! };
}

export async function getConversation(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select()
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.tenantId, tenantId), eq(schema.conversations.id, conversationId)),
    );
  return row ?? null;
}

/** True when the visitor message already has its reply (the turn is done). */
export async function replyExists(tx: Tx, tenantId: string, messageId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.inReplyTo, messageId)));
  return Boolean(row);
}

/** True when the conversation already has an agent or system message (so it was disclosed). */
export async function hasAssistantMessage(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.tenantId, tenantId),
        eq(schema.messages.conversationId, conversationId),
        sql`${schema.messages.author} in ('agent', 'system')`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The last `limit` messages up to and including `upToSeq`, oldest first (the prompt history). */
export async function recentMessages(
  tx: Tx,
  input: { tenantId: string; conversationId: string; upToSeq: number; limit: number },
): Promise<MessageRow[]> {
  const rows = await tx
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.tenantId, input.tenantId),
        eq(schema.messages.conversationId, input.conversationId),
        lte(schema.messages.seq, input.upToSeq),
      ),
    )
    .orderBy(desc(schema.messages.seq))
    .limit(input.limit);
  return rows.reverse();
}

/** Messages after `afterSeq`, oldest first: the resume path for SSE and WebSocket (ADR-017). */
export async function messagesSince(
  tx: Tx,
  input: { tenantId: string; conversationId: string; afterSeq: number; visitorId?: string },
): Promise<MessageRow[]> {
  if (input.visitorId)
    await visitorConversation(tx, input.tenantId, input.conversationId, input.visitorId);
  return tx
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.tenantId, input.tenantId),
        eq(schema.messages.conversationId, input.conversationId),
        gt(schema.messages.seq, input.afterSeq),
      ),
    )
    .orderBy(asc(schema.messages.seq))
    .limit(500);
}

/** The bare dashboard conversation list (SCR-APP-014 arrives with FEAT-040). */
export async function listConversations(
  tx: Tx,
  tenantId: string,
  limit = 50,
): Promise<ConversationSummary[]> {
  const rows = await tx
    .select({
      conversation: schema.conversations,
      // Written out in full: Drizzle renders an interpolated column without its table
      // here, which would correlate the subquery with itself.
      lastMessage: sql<string | null>`(
        select m.body from messages m
        where m.tenant_id = "conversations"."tenant_id" and m.conversation_id = "conversations"."id"
        order by m.seq desc limit 1)`,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.tenantId, tenantId))
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(limit);
  return rows.map((r) => toSummary(r.conversation, r.lastMessage));
}

/**
 * Whether an agent or system message in the conversation carried a notice of `kind` at
 * or after `since` (any time, when `since` is null): the after-hours notice is shown once
 * per closed period (FEAT-023 D6).
 */
export async function noticeSince(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  kind: NoticeKind,
  since: Date | null,
): Promise<boolean> {
  const m = schema.messages;
  const [row] = await tx
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.tenantId, tenantId),
        eq(m.conversationId, conversationId),
        eq(m.noticeKind, kind),
        since ? gte(m.createdAt, since) : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}
