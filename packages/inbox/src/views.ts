import type {
  ConversationSummary,
  InboxCounts,
  InboxView,
  IntentSignal,
  ThreadEvent,
  ThreadMessage,
} from '@kaki/contracts';
import { and, desc, eq, lt, schema, sql, type Tx } from '@kaki/db';

type SQL = ReturnType<typeof eq>;
import { toMessage, toSummary } from './mappers.js';
import { LIFECYCLE_ACTIONS } from './lifecycle.js';

/**
 * The inbox's read models (INB-01, INB-04; FEAT-042 §5.2): the views with keyset
 * pagination, the tab counts, the thread with its state dividers, and the sidebar.
 */

export class BadCursorError extends Error {}

interface Cursor {
  /** `last_message_at` as Postgres text: keeps the microseconds a JS Date would drop. */
  at: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AT_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.at, c.id])).toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'string' &&
      AT_RE.test(v[0]) &&
      UUID_RE.test(v[1])
    )
      return { at: v[0], id: v[1] };
  } catch {
    // fall through
  }
  throw new BadCursorError('malformed cursor');
}

const c = schema.conversations;

function viewFilter(view: InboxView): SQL {
  switch (view) {
    case 'open':
      return sql`${c.status} <> 'closed'`;
    case 'escalated':
      return eq(c.status, 'escalated');
    case 'approval':
      return eq(c.status, 'waiting_approval');
    case 'flagged':
      return sql`${c.flaggedAt} is not null`;
    case 'closed':
      return eq(c.status, 'closed');
  }
}

export interface ListQuery {
  view: InboxView;
  channel?: 'widget' | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** One page of a view, newest activity first, keyset on `(last_message_at, id)`. */
export async function listConversations(
  tx: Tx,
  tenantId: string,
  q: ListQuery,
): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await tx
    .select({
      conversation: c,
      at: sql<string>`${c.lastMessageAt}::text`,
      // Written out in full: Drizzle renders an interpolated column without its table
      // here, which would correlate the subquery with itself.
      lastMessage: sql<string | null>`(
        select m.body from messages m
        where m.tenant_id = "conversations"."tenant_id" and m.conversation_id = "conversations"."id"
        order by m.seq desc limit 1)`,
    })
    .from(c)
    .where(
      and(
        eq(c.tenantId, tenantId),
        viewFilter(q.view),
        q.channel ? eq(c.channel, q.channel) : undefined,
        after
          ? sql`(${c.lastMessageAt}, ${c.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(c.lastMessageAt), desc(c.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    conversations: page.map((r) => toSummary(r.conversation, r.lastMessage)),
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor({ at: last.at, id: last.conversation.id })
        : null,
  };
}

/** One conversation's summary with its last message body, as the list shows it; null if absent. */
export async function conversationSummary(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ConversationSummary | null> {
  const [row] = await tx
    .select({
      conversation: c,
      lastMessage: sql<string | null>`(
        select m.body from messages m
        where m.tenant_id = "conversations"."tenant_id" and m.conversation_id = "conversations"."id"
        order by m.seq desc limit 1)`,
    })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.id, conversationId)));
  return row ? toSummary(row.conversation, row.lastMessage) : null;
}

/** The tab counts, in one query (closed isn't counted). */
export async function inboxCounts(tx: Tx, tenantId: string): Promise<InboxCounts> {
  const [row] = await tx
    .select({
      open: sql<number>`count(*) filter (where ${c.status} <> 'closed')::int`,
      escalated: sql<number>`count(*) filter (where ${c.status} = 'escalated')::int`,
      approval: sql<number>`count(*) filter (where ${c.status} = 'waiting_approval')::int`,
      flagged: sql<number>`count(*) filter (where ${c.flaggedAt} is not null)::int`,
    })
    .from(c)
    .where(eq(c.tenantId, tenantId));
  return {
    open: Number(row?.open ?? 0),
    escalated: Number(row?.escalated ?? 0),
    approval: Number(row?.approval ?? 0),
    flagged: Number(row?.flagged ?? 0),
  };
}

const m = schema.messages;

/** The latest `limit` messages (before `seq` `before`, when given), ascending. */
export async function getThread(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  opts: { before?: number | undefined; limit?: number } = {},
): Promise<{ messages: ThreadMessage[]; hasEarlier: boolean }> {
  const limit = opts.limit ?? 100;
  const rows = await tx
    .select()
    .from(m)
    .where(
      and(
        eq(m.tenantId, tenantId),
        eq(m.conversationId, conversationId),
        opts.before !== undefined ? lt(m.seq, opts.before) : undefined,
      ),
    )
    .orderBy(desc(m.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  return {
    messages: page.map((r) => ({ ...toMessage(r), factIds: r.factIds })),
    hasEarlier: rows.length > limit,
  };
}

/** A thread divider before the API adds the actor's name (D7). */
export type ThreadEventRow = Omit<ThreadEvent, 'actor'> & {
  actor: { type: ThreadEvent['actor']['type']; id: string | null };
};

const STATUSES = new Set<string>(schema.CONVERSATION_STATUSES);
const REASONS = new Set<string>([...schema.CLOSE_REASONS, 'reopened']);
const asStatus = (v: unknown) =>
  typeof v === 'string' && STATUSES.has(v) ? (v as ThreadEvent['to'] & string) : null;

/**
 * The conversation's lifecycle and flag changes, oldest first, from the audit log
 * (D7): entries whose subjects include `conversation:<id>`.
 */
export async function threadEvents(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<ThreadEventRow[]> {
  const a = schema.auditEntries;
  const actions = [...LIFECYCLE_ACTIONS, 'conversation.flagged'];
  const rows = await tx
    .select({
      ts: a.ts,
      eventType: a.eventType,
      actorType: a.actorType,
      actorRef: a.actorRef,
      payload: a.payload,
    })
    .from(a)
    .where(
      and(
        eq(a.tenantId, tenantId),
        sql`${a.subjectRefs} @> array[${`conversation:${conversationId}`}]::text[]`,
        sql`${a.eventType} in (${sql.join(
          actions.map((x) => sql`${x}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(a.seq);
  return rows.map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const flagged = r.eventType === 'conversation.flagged';
    const reason = typeof p.reason === 'string' ? p.reason : null;
    return {
      at: r.ts.toISOString(),
      kind: flagged ? 'flagged' : 'state',
      from: flagged ? null : asStatus(p.from),
      to: flagged ? null : asStatus(p.to),
      reason: flagged
        ? reason === 'abuse' || reason === 'crisis'
          ? reason
          : null
        : reason && REASONS.has(reason)
          ? (reason as ThreadEvent['reason'])
          : null,
      actor: {
        type: r.actorType === 'operator' ? 'system' : r.actorType,
        id: r.actorType === 'user' ? r.actorRef : null,
      },
    } satisfies ThreadEventRow;
  });
}

/** The facts the conversation's AI answers used, most used first. */
export async function sidebarFacts(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<Array<{ factId: string; uses: number }>> {
  const res = await tx.execute<{ fact_id: string; uses: number }>(sql`
    select f.fact_id, count(*)::int as uses
    from messages, unnest(messages.fact_ids) as f(fact_id)
    where messages.tenant_id = ${tenantId} and messages.conversation_id = ${conversationId}
      and messages.author = 'agent'
    group by f.fact_id order by uses desc, f.fact_id`);
  return res.rows.map((r) => ({ factId: r.fact_id, uses: Number(r.uses) }));
}

/** Triage task kind → the sidebar's intent signal (D4); `correct` is coaching only. */
export const INTENT_OF_TASK: Readonly<
  Record<(typeof schema.MESSAGE_TASK_KINDS)[number], IntentSignal | null>
> = {
  answer: 'asked_questions',
  request_commitment: 'wants_to_order',
  capture_lead: 'left_details',
  escalate: 'asked_for_person',
  handoff_channel: 'switch_channel',
  withdraw_consent: 'privacy_request',
  data_request: 'privacy_request',
  out_of_scope: 'out_of_scope',
  abuse: 'abuse',
  crisis: 'crisis',
  correct: null,
};

/** How many AI turns carried each intent signal, most frequent first. */
export async function intentCounts(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<Array<{ signal: IntentSignal; count: number }>> {
  const res = await tx.execute<{ kind: string; n: number }>(sql`
    select k.kind, count(*)::int as n
    from messages, unnest(messages.task_kinds) as k(kind)
    where messages.tenant_id = ${tenantId} and messages.conversation_id = ${conversationId}
    group by k.kind`);
  const counts = new Map<IntentSignal, number>();
  for (const r of res.rows) {
    const signal = INTENT_OF_TASK[r.kind as keyof typeof INTENT_OF_TASK] ?? null;
    if (signal) counts.set(signal, (counts.get(signal) ?? 0) + Number(r.n));
  }
  return [...counts]
    .map(([signal, count]) => ({ signal, count }))
    .sort((x, y) => y.count - x.count || x.signal.localeCompare(y.signal));
}

/**
 * The visitor's history (the contact link until FEAT-049's contacts, D5): first seen
 * across their conversations, and how many they had before this one.
 */
export async function visitorHistory(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<{ firstSeenAt: Date; previousConversations: number } | null> {
  const res = await tx.execute<{ first_seen: string; previous: number }>(sql`
    select min(o.created_at) as first_seen,
           (count(*) filter (where o.created_at < cur.created_at))::int as previous
    from conversations cur
    join conversations o on o.tenant_id = cur.tenant_id and o.visitor_id = cur.visitor_id
    where cur.tenant_id = ${tenantId} and cur.id = ${conversationId}
    group by cur.id`);
  const row = res.rows[0];
  if (!row) return null;
  return { firstSeenAt: new Date(row.first_seen), previousConversations: Number(row.previous) };
}
