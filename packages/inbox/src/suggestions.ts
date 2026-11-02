import { and, desc, eq, gte, inArray, schema, type Tx } from '@kaki/db';
import { audit, auditId } from '@kaki/governance';
import { piiMask } from '@kaki/platform';
import type { MessageRow } from './mappers.js';

/**
 * AI-suggested replies for staff (INB-03; FEAT-045 §5.2). The agent stores each draft here;
 * sending a message with its ID records the use, and the API proposes a `reply_edit`
 * correction when the staff member changed it (KB-18). Dashboard zone only (ADR-009).
 */

const s = schema.suggestions;
const m = schema.messages;

export type SuggestionRow = typeof schema.suggestions.$inferSelect;
export type SuggestionOutcome = (typeof schema.SUGGESTION_OUTCOMES)[number];

/** D5: at most this many suggestions per conversation in a rolling hour. */
export const SUGGESTIONS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

/** The conversation's newest visitor message: what a suggestion answers (D4). */
export async function latestVisitorMessage(
  tx: Tx,
  tenantId: string,
  conversationId: string,
): Promise<MessageRow | undefined> {
  const [row] = await tx
    .select()
    .from(m)
    .where(
      and(eq(m.tenantId, tenantId), eq(m.conversationId, conversationId), eq(m.author, 'visitor')),
    )
    .orderBy(desc(m.seq))
    .limit(1);
  return row;
}

/**
 * Seconds until another suggestion is allowed for the conversation, or 0 when one is (D5,
 * counted from `created_at` over the last hour).
 */
export async function suggestionRetryAfter(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - HOUR_MS);
  const rows = await tx
    .select({ createdAt: s.createdAt })
    .from(s)
    .where(
      and(eq(s.tenantId, tenantId), eq(s.conversationId, conversationId), gte(s.createdAt, since)),
    )
    .orderBy(desc(s.createdAt))
    .limit(SUGGESTIONS_PER_HOUR);
  if (rows.length < SUGGESTIONS_PER_HOUR) return 0;
  // The oldest of the last ten leaves the window first.
  const oldest = rows[rows.length - 1]!.createdAt;
  return Math.max(1, Math.ceil((oldest.getTime() + HOUR_MS - now.getTime()) / 1000));
}

/**
 * Stores a new suggestion and supersedes the conversation's earlier open ones. The body is
 * masked anyway (ADR-015, defence in depth). Auditing is the caller's (the agent's).
 */
export async function storeSuggestion(
  tx: Tx,
  input: {
    tenantId: string;
    id: string;
    conversationId: string;
    forMessageId: string;
    requestedBy: string;
    outcome: SuggestionOutcome;
    body: string | null;
    factIds: string[];
    language: 'en' | 'zh';
  },
): Promise<SuggestionRow> {
  await tx
    .update(s)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(s.tenantId, input.tenantId),
        eq(s.conversationId, input.conversationId),
        eq(s.status, 'open'),
      ),
    );
  const [row] = await tx
    .insert(s)
    .values({
      ...input,
      body: input.outcome === 'ready' && input.body !== null ? piiMask(input.body) : null,
      factIds: input.outcome === 'ready' ? input.factIds : [],
    })
    .returning();
  return row!;
}

/**
 * What counts as an edit (D8): case, runs of whitespace, and trailing punctuation and emoji
 * don't; any other change (a price, a date, a word) does.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\s\p{P}\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]+$/u, '');
}

/**
 * Records that a staff message was sent from a suggestion (§5.2), in the send transaction,
 * only when the message was just created. A suggestion that isn't this conversation's, isn't
 * `ready` or isn't open is ignored (D7): the message stays sent, with no correction. An
 * unedited draft's fact IDs are copied onto the message (ADR-008: the text was checked).
 */
export async function recordSuggestionUse(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    userId: string;
    suggestionId: string;
    message: MessageRow;
  },
): Promise<{ used: false } | { used: true; edited: boolean; factIds: string[] }> {
  const { tenantId, conversationId, message } = input;
  const [row] = await tx
    .select()
    .from(s)
    .where(and(eq(s.tenantId, tenantId), eq(s.id, input.suggestionId)))
    .for('update');
  if (
    !row ||
    row.conversationId !== conversationId ||
    row.outcome !== 'ready' ||
    row.status !== 'open' ||
    row.body === null
  )
    return { used: false };
  const edited = normalise(message.body) !== normalise(piiMask(row.body));
  const usedAt = new Date();
  await tx
    .update(s)
    .set({ status: edited ? 'sent_edited' : 'sent', sentMessageId: message.id, usedAt })
    .where(and(eq(s.tenantId, tenantId), eq(s.id, row.id)));
  if (!edited && row.factIds.length > 0)
    await tx
      .update(m)
      .set({ factIds: row.factIds })
      .where(and(eq(m.tenantId, tenantId), eq(m.id, message.id)));
  await audit.append(tx, tenantId, {
    action: 'inbox.suggestion.sent',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'conversation',
    subjectId: conversationId,
    related: [
      { type: 'suggestion', id: row.id },
      { type: 'message', id: message.id },
    ],
    payload: { suggestionId: auditId(row.id), edited },
  });
  return { used: true, edited, factIds: row.factIds };
}

/** One suggestion, for the correction item's context (§5.3). */
export async function getSuggestion(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<SuggestionRow | undefined> {
  const [row] = await tx
    .select()
    .from(s)
    .where(and(eq(s.tenantId, tenantId), eq(s.id, id)));
  return row;
}

/** Visitor-question text for many suggestions at once (the corrections list row). */
export async function suggestionQuestions(
  tx: Tx,
  tenantId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: s.id, body: m.body })
    .from(s)
    .innerJoin(m, and(eq(m.tenantId, s.tenantId), eq(m.id, s.forMessageId)))
    .where(and(eq(s.tenantId, tenantId), inArray(s.id, ids)));
  return new Map(rows.map((r) => [r.id, r.body]));
}
