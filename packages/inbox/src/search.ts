import type { ConversationSearchResult, SearchMatch } from '@kaki/contracts';
import { and, desc, eq, schema, sql, type Tx } from '@kaki/db';
import { piiMask } from '@kaki/platform';
import { toSummary } from './mappers.js';
import { decodeCursor, encodeCursor, namedPeople, type OwnerNames } from './views.js';

/**
 * Conversation search (INB-11; FEAT-046 §5.1): substring, case-insensitive `ILIKE` over the
 * masked message text on the `(tenant_id, body gin_trgm_ops)` index (D2, D5), newest
 * activity first with the latest matching message (D4). The text is never logged (D3).
 * FEAT-049 adds contact fields as a second source of hits (D1).
 */

/** A query shorter than 2 characters once masked and collapsed (400 `query_too_short`). */
export class QueryTooShortError extends Error {}

const MIN_CHARS = 2;
const SG_PHONE_RE = /^(?:\+?65)?([3689]\d{7})$/;

/**
 * The literal texts to look for: the masked, collapsed query, plus the three common
 * spellings of a Singapore phone number when the query is one (D6). Null under 2 characters.
 */
export function searchTerms(q: string): string[] | null {
  const text = piiMask(q).replace(/\s+/gu, ' ').trim();
  if ([...text].length < MIN_CHARS) return null;
  const terms = [text];
  const phone = SG_PHONE_RE.exec(text.replace(/[\s-]/g, ''));
  if (phone) {
    const d = phone[1]!;
    terms.push(d, `${d.slice(0, 4)} ${d.slice(4)}`, `${d.slice(0, 4)}-${d.slice(4)}`);
  }
  return [...new Set(terms)];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** `ILIKE` patterns (`%term%`, with `\`, `%` and `_` escaped) for `searchTerms(q)`; null if too short. */
export function searchPatterns(q: string): string[] | null {
  return searchTerms(q)?.map((t) => `%${escapeLike(t)}%`) ?? null;
}

const WINDOW = 160;
const BEFORE = 40;
const SPACE_REACH = 10;
const MAX_RANGES = 10;
const CUT = '…';

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;

/** Every hit of any needle, merged into sorted non-overlapping ranges (UTF-16 offsets). */
function hitsIn(lower: string, needles: readonly string[]): { start: number; end: number }[] {
  const all: { start: number; end: number }[] = [];
  for (const n of needles) {
    const ln = n.toLocaleLowerCase('und');
    if (!ln) continue;
    for (let i = lower.indexOf(ln); i >= 0; i = lower.indexOf(ln, i + 1))
      all.push({ start: i, end: i + ln.length });
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { start: number; end: number }[] = [];
  for (const h of all) {
    const prev = merged.at(-1);
    if (prev && h.start <= prev.end) prev.end = Math.max(prev.end, h.end);
    else merged.push({ ...h });
  }
  return merged;
}

/**
 * ≤ 160 characters of `body` around the first hit, with every hit inside it as ranges
 * (FEAT-046 §5.1). Cuts on a nearby space and marks them with `…`; never splits a
 * surrogate pair. No hit found here (case folding differs from Postgres) → the start.
 */
export function excerptOf(
  body: string,
  needles: readonly string[],
): Pick<SearchMatch, 'excerpt' | 'ranges'> {
  const lower = body.toLocaleLowerCase('und');
  const hits = lower.length === body.length ? hitsIn(lower, needles) : [];
  const first = hits[0];
  let start = 0;
  if (first && first.start > BEFORE) {
    start = first.start - BEFORE;
    const space = body.indexOf(' ', start);
    if (space >= 0 && space < first.start && space - start <= SPACE_REACH) start = space + 1;
    if (isLow(body.charCodeAt(start))) start += 1;
  }
  const lead = start > 0 ? CUT : '';
  let end = start + WINDOW - lead.length;
  let tail = '';
  if (end < body.length) {
    end -= CUT.length;
    const space = body.lastIndexOf(' ', end);
    const mustKeep = first ? first.end : start;
    if (space > mustKeep && end - space <= SPACE_REACH) end = space;
    if (isHigh(body.charCodeAt(end - 1))) end -= 1;
    tail = CUT;
  } else end = body.length;
  const ranges = hits
    .filter((h) => h.start >= start && h.end <= end)
    .slice(0, MAX_RANGES)
    .map((h) => ({ start: h.start - start + lead.length, end: h.end - start + lead.length }));
  return { excerpt: lead + body.slice(start, end) + tail, ranges };
}

export interface SearchQuery {
  q: string;
  cursor?: string | undefined;
  limit: number;
}

const c = schema.conversations;

/**
 * One page of the conversations with a message matching `q`, newest activity first,
 * keyset on `(last_message_at, id)` like the inbox list. Throws `QueryTooShortError` or
 * `BadCursorError`. Every source filters on the tenant explicitly as well as RLS (ADR-005).
 */
export async function searchConversations(
  tx: Tx,
  tenantId: string,
  q: SearchQuery,
  names?: OwnerNames,
): Promise<{ results: ConversationSearchResult[]; nextCursor: string | null }> {
  const terms = searchTerms(q.q);
  if (!terms) throw new QueryTooShortError('query too short');
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const patterns = sql.join(
    terms.map((t) => sql`${`%${escapeLike(t)}%`}`),
    sql`, `,
  );
  // The latest matching message per conversation, through `inbox_search_hits` so the
  // trigram index applies under RLS (0047, build note B1). FEAT-049 unions contact hits here (D1).
  const fn = sql`inbox_search_hits(array[${patterns}]::text[])`;
  const hits = tx.$with('hits').as(
    tx
      .select({
        tenantId: sql<string>`h.tenant_id`.as('hit_tenant_id'),
        conversationId: sql<string>`h.conversation_id`.as('hit_conversation_id'),
        messageId: sql<string>`h.message_id`.as('hit_message_id'),
        author: sql<SearchMatch['author']>`h.author`.as('hit_author'),
        body: sql<string>`h.body`.as('hit_body'),
        at: sql<Date>`h.created_at`.as('hit_at'),
      })
      .from(sql`${fn} h`),
  );
  const rows = await tx
    .with(hits)
    .select({
      conversation: c,
      at: sql<string>`${c.lastMessageAt}::text`,
      lastMessage: sql<string | null>`(
        select coalesce(nullif(lm.body, ''), lm.notice) from messages lm
        where lm.tenant_id = "conversations"."tenant_id" and lm.conversation_id = "conversations"."id"
        order by lm.seq desc limit 1)`,
      hitMessageId: hits.messageId,
      hitAuthor: hits.author,
      hitBody: hits.body,
      hitAt: sql<string>`to_char(${hits.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(c)
    .innerJoin(hits, eq(hits.conversationId, c.id))
    .where(
      and(
        eq(c.tenantId, tenantId),
        eq(hits.tenantId, tenantId),
        after
          ? sql`(${c.lastMessageAt}, ${c.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(c.lastMessageAt), desc(c.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const { owners, escalations } = await namedPeople(
    tx,
    tenantId,
    page.map((r) => r.conversation.id),
    names,
  );
  return {
    results: page.map((r) => ({
      conversation: toSummary(
        r.conversation,
        r.lastMessage,
        owners.get(r.conversation.id) ?? null,
        escalations.get(r.conversation.id) ?? null,
      ),
      match: {
        messageId: r.hitMessageId,
        author: r.hitAuthor,
        at: r.hitAt,
        ...excerptOf(r.hitBody, terms),
      },
    })),
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor({ at: last.at, id: last.conversation.id })
        : null,
  };
}
