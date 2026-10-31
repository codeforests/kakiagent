import { and, asc, desc, eq, gt, gte, lt, lte, or, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import { piiMask } from '@kaki/platform';
import { enqueue } from '@kaki/platform/outbox';
import { reopenable, transition } from './lifecycle.js';

export * from './lifecycle.js';
export * from './views.js';

/**
 * Conversation and message repository. Every function takes a transaction opened by
 * `withTenant`, so RLS applies; the explicit `tenant_id` predicates are a second
 * guard, not the only one (ADR-005). Status changes go only through `lifecycle.ts`
 * (FEAT-042, ADR-013 d1); the inbox's read models are in `views.ts`.
 */

export class NotFoundError extends Error {}
/** A new visitor message to a closed conversation (FEAT-033 D5): the API answers 409. */
export class ConversationClosedError extends Error {}

export * from './mappers.js';
import type { ConversationRow, FlagReason, MessageRow, NoticeKind } from './mappers.js';

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
  const existing = async () => {
    const [row] = await tx
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.tenantId, input.tenantId),
          eq(schema.messages.conversationId, input.conversationId),
          eq(schema.messages.clientMessageId, input.clientMessageId),
        ),
      );
    return row;
  };
  // A retry of a stored message stays idempotent even after the chat ended (FEAT-033 D5).
  let current = conversation;
  if (conversation.status === 'closed') {
    const stored = await existing();
    if (stored) return { message: stored, created: false, conversation };
    // A staff or inactivity close within 7 days reopens the same conversation (INB-08, D5).
    if (!reopenable(conversation)) throw new ConversationClosedError('conversation is closed');
    current = await transition(tx, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      to: 'ai',
      actor: { type: 'visitor', id: input.visitorId },
    });
  }
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
    const stored = await existing();
    if (!stored) throw new Error('message conflict without a matching row');
    return { message: stored, created: false, conversation };
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
  return { message: inserted, created: true, conversation: updated ?? current };
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
    /** The reply language the agent decided (FEAT-033 D3): the widget's chrome follows it. */
    language?: 'en' | 'zh' | null;
    /** Triage's task kinds for the turn (FEAT-042 D4): the sidebar's intent signals. */
    taskKinds?: readonly (typeof schema.MESSAGE_TASK_KINDS)[number][];
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
      language: input.language ?? null,
      taskKinds: [...new Set(input.taskKinds ?? [])],
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

/**
 * Flags the conversation for staff (AGT-13; FEAT-025 §5.5): the first flag sets
 * `flagged_at`, and each reason is kept once. Audited only when the reason is new, so a
 * repeated crisis message or a redelivered turn doesn't add entries.
 */
export async function flagConversation(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  reason: FlagReason,
): Promise<ConversationRow | null> {
  const c = schema.conversations;
  const [row] = await tx
    .update(c)
    .set({
      flaggedAt: sql`coalesce(${c.flaggedAt}, now())`,
      flagReasons: sql`array_append(${c.flagReasons}, ${reason}::text)`,
    })
    .where(
      and(
        eq(c.tenantId, tenantId),
        eq(c.id, conversationId),
        sql`not (${reason}::text = any(${c.flagReasons}))`,
      ),
    )
    .returning();
  if (!row) return getConversation(tx, tenantId, conversationId);
  await audit.append(tx, tenantId, {
    action: 'conversation.flagged',
    actorType: 'agent',
    subjectType: 'conversation',
    subjectId: conversationId,
    payload: { reason: auditCode(reason) },
  });
  return row;
}

/**
 * Records that triage tagged this turn (the visitor message `turnId`) as abuse and
 * returns how many distinct abuse turns the conversation has (FEAT-025 D2). Counting
 * turn IDs keeps a redelivered turn from counting twice.
 */
export async function recordAbuse(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  turnId: string,
): Promise<number> {
  const c = schema.conversations;
  const [row] = await tx
    .update(c)
    .set({
      abuseTurns: sql`case when ${turnId}::uuid = any(${c.abuseTurns}) then ${c.abuseTurns}
                      else array_append(${c.abuseTurns}, ${turnId}::uuid) end`,
    })
    .where(and(eq(c.tenantId, tenantId), eq(c.id, conversationId)))
    .returning({ n: sql<number>`cardinality(${c.abuseTurns})::int` });
  if (!row) throw new NotFoundError('conversation not found');
  return row.n;
}

/**
 * Ends the AI's part in the conversation (AGT-13 repeated abuse; FEAT-025 D2): an AI
 * conversation closes with reason `abuse` through the lifecycle (FEAT-042 D6), so the send
 * gate keeps the AI silent (ADR-013 d3). Only from `ai`; false otherwise.
 */
export async function endAiConversation(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  _reason: FlagReason,
): Promise<boolean> {
  const conversation = await getConversation(tx, tenantId, conversationId);
  if (conversation?.status !== 'ai') return false;
  await transition(tx, {
    tenantId,
    conversationId,
    to: 'closed',
    reason: 'abuse',
    actor: { type: 'agent' },
  });
  return true;
}

/**
 * The visitor ends their chat (CHN-13, FEAT-033 §5.1): closes it from any open state
 * with reason `visitor` so the send gate keeps the AI silent. Idempotent: `ended` is
 * false, and nothing is audited, when the conversation was already closed.
 */
export async function endVisitorConversation(
  tx: Tx,
  input: { tenantId: string; conversationId: string; visitorId: string },
): Promise<{ conversation: ConversationRow; ended: boolean }> {
  const conversation = await visitorConversation(
    tx,
    input.tenantId,
    input.conversationId,
    input.visitorId,
  );
  if (conversation.status === 'closed') return { conversation, ended: false };
  const closed = await transition(tx, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    to: 'closed',
    reason: 'visitor',
    actor: { type: 'visitor', id: input.visitorId },
  });
  return { conversation: closed, ended: true };
}

/** A conversation with at least one visitor message, for replay (FEAT-028 §3). */
export interface AskedConversation {
  conversation: ConversationRow;
  /** The first visitor message, masked at the edge. */
  firstQuestion: string;
  /** How many visitor messages it has. */
  questions: number;
}

const visitorMessagesOf = sql`from messages m
  where m.tenant_id = "conversations"."tenant_id" and m.conversation_id = "conversations"."id"
    and m.author = 'visitor'`;

/**
 * The tenant's conversations that have a visitor message, newest last message first,
 * after the `(lastMessageAt, id)` keyset position when given (FEAT-028 replay picker).
 */
export async function listAskedConversations(
  tx: Tx,
  tenantId: string,
  input: { after?: { lastMessageAt: Date; id: string }; limit: number },
): Promise<AskedConversation[]> {
  const c = schema.conversations;
  const after = input.after;
  const rows = await tx
    .select({
      conversation: c,
      firstQuestion: sql<string>`(select m.body ${visitorMessagesOf} order by m.seq limit 1)`,
      questions: sql<number>`(select count(*)::int ${visitorMessagesOf})`,
    })
    .from(c)
    .where(
      and(
        eq(c.tenantId, tenantId),
        sql`exists (select 1 ${visitorMessagesOf})`,
        after
          ? or(
              lt(c.lastMessageAt, after.lastMessageAt),
              and(eq(c.lastMessageAt, after.lastMessageAt), lt(c.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(c.lastMessageAt), desc(c.id))
    .limit(input.limit);
  return rows.map((r) => ({ ...r, questions: Number(r.questions) }));
}

/** How many visitor messages a conversation has. */
export async function visitorMessageCount(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<number> {
  const m = schema.messages;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(m)
    .where(
      and(eq(m.tenantId, tenantId), eq(m.conversationId, conversationId), eq(m.author, 'visitor')),
    );
  return Number(row?.n ?? 0);
}

/**
 * Past visitor questions whose agent reply rendered one of `factIds` (AGT-01's
 * `fact_ids`), asked before `before`: the questions a correction replays (KB-18; FEAT-018
 * §5.3, D4). Newest first, at most `limit`; `matched` counts them all.
 */
export async function pastQuestionsUsing(
  tx: Tx,
  input: { tenantId: string; factIds: string[]; before: Date; limit: number },
): Promise<{ questions: { messageId: string; conversationId: string }[]; matched: number }> {
  if (!input.factIds.length) return { questions: [], matched: 0 };
  const ids = sql`array[${sql.join(
    input.factIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const res = await tx.execute<{ id: string; conversation_id: string; matched: number }>(sql`
    with q as (
      select distinct v.id, v.conversation_id, v.created_at
      from messages a
      join messages v on v.tenant_id = a.tenant_id and v.id = a.in_reply_to
      where a.tenant_id = ${input.tenantId} and a.author = 'agent' and v.author = 'visitor'
        and a.fact_ids && ${ids} and a.created_at < ${input.before.toISOString()}
    )
    select q.id, q.conversation_id, (select count(*) from q)::int as matched
    from q order by q.created_at desc, q.id desc limit ${input.limit}`);
  return {
    questions: res.rows.map((r) => ({ messageId: r.id, conversationId: r.conversation_id })),
    matched: res.rows[0] ? Number(res.rows[0].matched) : 0,
  };
}

/** The last `limit` messages of a conversation up to `upTo`, oldest first (a correction's excerpt). */
export async function messagesUpTo(
  tx: Tx,
  input: { tenantId: string; conversationId: string; upTo: Date; limit: number },
): Promise<MessageRow[]> {
  const rows = await tx
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.tenantId, input.tenantId),
        eq(schema.messages.conversationId, input.conversationId),
        lte(schema.messages.createdAt, input.upTo),
      ),
    )
    .orderBy(desc(schema.messages.seq))
    .limit(input.limit);
  return rows.reverse();
}

// ---- Coverage gaps (KB-09; FEAT-019 §5.1) ---------------------------------------------

export type GapReason = (typeof schema.GAP_REASONS)[number];

/**
 * Marks a visitor question the turn couldn't answer as a coverage gap, with the vector
 * retrieval used (D2). Only the first mark counts, so a redelivered turn marks it once.
 */
export async function markQuestionGap(
  tx: Tx,
  input: { tenantId: string; messageId: string; reason: GapReason; embedding: number[] },
): Promise<boolean> {
  const rows = await tx
    .update(schema.messages)
    .set({ gapReason: input.reason, gapEmbedding: input.embedding })
    .where(
      and(
        eq(schema.messages.tenantId, input.tenantId),
        eq(schema.messages.id, input.messageId),
        eq(schema.messages.author, 'visitor'),
        sql`${schema.messages.gapReason} is null`,
      ),
    )
    .returning({ id: schema.messages.id });
  return rows.length > 0;
}

export interface GapQuestionRow {
  messageId: string;
  conversationId: string;
  /** Masked at the edge when stored (ADR-015). */
  body: string;
  askedAt: Date;
  reason: GapReason;
}

/** The newest `perItem` questions filed under each coverage-gap item, newest first. */
export async function gapQuestions(
  tx: Tx,
  tenantId: string,
  correctionIds: string[],
  opts: { perItem: number },
): Promise<Map<string, GapQuestionRow[]>> {
  const out = new Map<string, GapQuestionRow[]>();
  if (correctionIds.length === 0) return out;
  const rows = await tx.execute<{
    correction_id: string;
    id: string;
    conversation_id: string;
    body: string;
    created_at: string | Date;
    gap_reason: GapReason;
  }>(sql`
    select correction_id, id, conversation_id, body, created_at, gap_reason from (
      select m.gap_correction_id as correction_id, m.id, m.conversation_id, m.body, m.created_at,
             m.gap_reason,
             row_number() over (partition by m.gap_correction_id order by m.created_at desc, m.id) as n
      from messages m
      where m.tenant_id = ${tenantId}
        and m.gap_correction_id in (${sql.join(
          correctionIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
    ) q
    where n <= ${opts.perItem}
    order by correction_id, n`);
  for (const r of rows.rows) {
    const list = out.get(r.correction_id) ?? [];
    list.push({
      messageId: r.id,
      conversationId: r.conversation_id,
      body: r.body,
      askedAt: new Date(r.created_at),
      reason: r.gap_reason,
    });
    out.set(r.correction_id, list);
  }
  return out;
}

export interface GapCount {
  asksSince: number;
  asksTotal: number;
  firstAskedAt: Date;
  lastAskedAt: Date;
  reasons: GapReason[];
}

/** Per coverage-gap item: asks since `since`, all asks, first and last ask, and the reasons. */
export async function gapCounts(
  tx: Tx,
  tenantId: string,
  correctionIds: string[],
  since: Date,
): Promise<Map<string, GapCount>> {
  const out = new Map<string, GapCount>();
  if (correctionIds.length === 0) return out;
  const rows = await tx.execute<{
    correction_id: string;
    asks_since: number;
    asks_total: number;
    first_at: string | Date;
    last_at: string | Date;
    reasons: GapReason[];
  }>(sql`
    select m.gap_correction_id as correction_id,
           (count(*) filter (where m.created_at >= ${since.toISOString()}::timestamptz))::int as asks_since,
           count(*)::int as asks_total, min(m.created_at) as first_at, max(m.created_at) as last_at,
           array_agg(distinct m.gap_reason order by m.gap_reason) as reasons
    from messages m
    where m.tenant_id = ${tenantId}
      and m.gap_correction_id in (${sql.join(
        correctionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    group by m.gap_correction_id`);
  for (const r of rows.rows)
    out.set(r.correction_id, {
      asksSince: r.asks_since,
      asksTotal: r.asks_total,
      firstAskedAt: new Date(r.first_at),
      lastAskedAt: new Date(r.last_at),
      reasons: r.reasons,
    });
  return out;
}

/** The tenant has had at least one conversation: Coverage's go-live until FEAT-034 (D4). */
export async function hasConversation(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(eq(schema.conversations.tenantId, tenantId))
    .limit(1);
  return rows.length > 0;
}
