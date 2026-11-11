import type { SummariseJob } from '@kaki/contracts';
import { and, desc, eq, lt, schema, sql, type Tx } from '@kaki/db';
import { messagesBetween, type MessageRow } from '@kaki/inbox';
import type { LlmGateway } from '@kaki/llm-gateway';
import {
  cleanMemory,
  foldPlan,
  MEMORY_MAX_VERBATIM,
  parseMemory,
  summarise,
  type ConversationMemory,
} from './memory.js';

/**
 * Conversation memory rows (FEAT-026 §5.2), append-only (D3): the visitor zone inserts
 * (the fold) and reads (turns); the dashboard zone reads (suggestions, replay).
 */

export interface StoredMemory {
  uptoSeq: number;
  memory: ConversationMemory;
}

/** The newest memory with `upto_seq < beforeSeq` (or the newest of all), or null. */
export async function latestMemory(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  beforeSeq?: number,
): Promise<StoredMemory | null> {
  const t = schema.conversationSummaries;
  const [row] = await tx
    .select({ uptoSeq: t.uptoSeq, memory: t.memory })
    .from(t)
    .where(
      and(
        eq(t.tenantId, tenantId),
        eq(t.conversationId, conversationId),
        beforeSeq === undefined ? undefined : lt(t.uptoSeq, beforeSeq),
      ),
    )
    .orderBy(desc(t.uptoSeq))
    .limit(1);
  if (!row) return null;
  const memory = parseMemory(row.memory);
  return memory ? { uptoSeq: row.uptoSeq, memory } : null;
}

/** Inserts a fold; a concurrent identical fold loses on the unique key and writes nothing. */
export async function saveMemory(
  tx: Tx,
  row: {
    tenantId: string;
    conversationId: string;
    uptoSeq: number;
    memory: ConversationMemory;
    messagesFolded: number;
  },
): Promise<boolean> {
  const written = await tx
    .insert(schema.conversationSummaries)
    .values(row)
    .onConflictDoNothing({
      target: [
        schema.conversationSummaries.tenantId,
        schema.conversationSummaries.conversationId,
        schema.conversationSummaries.uptoSeq,
      ],
    })
    .returning({ id: schema.conversationSummaries.id });
  return written.length > 0;
}

export interface ConversationHistory {
  memory: ConversationMemory | null;
  /** Every message after the memory, oldest first, at most `MEMORY_MAX_VERBATIM` (D5). */
  messages: MessageRow[];
  /** How many messages are after the memory in all (lag shows when this exceeds the cap). */
  unfolded: number;
}

/**
 * The one history loader for visitor turns, suggested replies and replay (§5.4): the latest
 * memory before `upToSeq` and the messages after it up to `upToSeq`.
 */
export async function loadConversationHistory(
  tx: Tx,
  input: { tenantId: string; conversationId: string; upToSeq: number },
): Promise<ConversationHistory> {
  const stored = await latestMemory(tx, input.tenantId, input.conversationId, input.upToSeq);
  const { rows, total } = await messagesBetween(tx, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    afterSeq: stored?.uptoSeq ?? 0,
    upToSeq: input.upToSeq,
    limit: MEMORY_MAX_VERBATIM,
  });
  return { memory: stored?.memory ?? null, messages: rows, unfolded: total };
}

export type SummariseOutcome = 'skipped' | 'failed' | 'saved' | 'raced';

/** How many messages a fold reads at most: enough for a lagging conversation, bounded. */
const FOLD_READ_LIMIT = 200;

/**
 * Runs one `summarise` job (§5.3) in the visitor zone: re-reads what's unfolded, folds all
 * but the last `MEMORY_KEEP` into a new memory row, or does nothing when nothing is due
 * (a duplicate or stale job is a no-op, ADR-012). The model call is outside a transaction.
 */
export async function runSummariseJob(
  deps: {
    llm: LlmGateway;
    withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  },
  job: SummariseJob,
): Promise<{ outcome: SummariseOutcome; folded: number }> {
  const { tenantId, conversationId } = job;
  const prep = await deps.withTx(async (tx) => {
    const previous = await latestMemory(tx, tenantId, conversationId);
    const [last] = await tx
      .select({ seq: sql<number>`max(${schema.messages.seq})`.mapWith(Number) })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.tenantId, tenantId),
          eq(schema.messages.conversationId, conversationId),
        ),
      );
    const { rows } = await messagesBetween(tx, {
      tenantId,
      conversationId,
      afterSeq: previous?.uptoSeq ?? 0,
      upToSeq: last?.seq ?? 0,
      limit: FOLD_READ_LIMIT,
    });
    return { previous, rows };
  });
  const plan = foldPlan(prep.rows);
  if (!plan.due) return { outcome: 'skipped', folded: 0 };
  const folding = prep.rows.filter((m) => m.seq <= plan.cutoffSeq);
  const memory = await summarise(deps.llm, {
    previous: prep.previous?.memory ?? null,
    messages: folding.map((m) => ({ seq: m.seq, author: m.author, body: m.body })),
    meta: { tenantId, conversationId },
  });
  if (!memory) return { outcome: 'failed', folded: 0 };
  const saved = await deps.withTx((tx) =>
    saveMemory(tx, {
      tenantId,
      conversationId,
      uptoSeq: plan.cutoffSeq,
      memory: cleanMemory(memory),
      messagesFolded: folding.length,
    }),
  );
  return { outcome: saved ? 'saved' : 'raced', folded: saved ? folding.length : 0 };
}
