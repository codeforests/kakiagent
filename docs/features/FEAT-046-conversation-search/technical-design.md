# Technical design: FEAT-046 — Conversation search

> Implements: INB-11 (p: message text, which already finds the emails and phone numbers visitors type in chat; contact name, email and phone fields join the same search when FEAT-049 creates `contacts`, D1) · Realizes: UC-23 (p: traces only; staff find a conversation before steps 3–5) · Screens: SCR-APP-014 (p: search field, results, the top bar's search entry) (see [ui-design.md](ui-design.md)) · Module: `inbox` (`search.ts`), architecture §5.2, ADR-004, ADR-005, ADR-014, ADR-015
> Status: designed · 2026-11-03

## 1. Intent

Staff can find any conversation of their business by typing part of what was said: a name, an email, a phone number, an order number or a phrase. Results are the matching conversations in every state (closed ones too), newest activity first, each with the matching line and the hit marked. Opening a result opens the conversation at that message. Search stays inside the tenant, answers in under 2 seconds on 12 months of data at A1 volumes (INB-11), and never puts the search text in a URL or a log (ADR-014, GOV-04).

## 2. Codebase context

- **Inbox list** (`inbox/views.ts`, FEAT-042/043/044): `listConversations(tx, tenantId, q, names)` keysets on `(last_message_at, id)` with `encodeCursor`/`decodeCursor` and `BadCursorError`; `namedPeople` resolves owners and escalation assignees for a page; `toSummary` (`mappers.ts`) builds `ConversationSummary`. Search reuses all of these, so a result row is the same summary the list shows.
- **Route** `GET /api/v1/conversations` in `apps/api/src/inbox.ts`: `reader(req)` (`inbox.read`, every role), `withTenant(dashboardDb, …)`, `namesIn(tenantId)`, `badCursor(reply)`.
- **Messages** (`schema.ts` `messages`): `body` is already masked at the edge for NRIC, card and bank numbers (`piiMask`, ADR-015); emails and SG phone numbers stay in the text. Indexes are btree only; no `pg_trgm` yet. Extensions are created in migrations (`0001` creates `vector`).
- **Logging** (`platform/logger.ts`): Fastify logs each request's URL, query string included, and only top-level strings go through `maskLogText`. A query string carrying an email would be logged, so search text travels in a POST body (D3).
- **There is no `contacts` table yet** (`audit_pii.contact_id` notes "contacts arrives with FEAT-049"); the inbox row title is "Website visitor".
- **Dashboard**: `pages/inbox.tsx` (`InboxPage`, `InboxList` with tabs, Channel and Assigned to filters, `Row`), `pages/conversation.tsx` (`ConversationPane`, `ThreadLog` loads the latest 100 messages, "Load earlier" before that), `shell/app-shell.tsx` top bar (tenant switcher, AI status pill, account menu), `shell/icon.tsx` (no `search` glyph yet).

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: conversation search (INB-11; FEAT-046 §3)`)

```ts
export const ConversationSearchRequest = z.strictObject({
  /** Trimmed; 2–100 characters (code points) after whitespace is collapsed. */
  q: z.string().trim().min(2).max(100),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
export const SearchMatch = z.object({
  messageId: z.uuid(),
  author: z.enum(['visitor', 'agent', 'staff', 'system']),
  at: z.iso.datetime({ offset: true }),
  /** ≤ 160 characters of the message around the first hit; '…' marks a cut. */
  excerpt: z.string(),
  /** Hits inside `excerpt`, UTF-16 offsets, sorted, non-overlapping; may be empty. */
  ranges: z.array(z.object({ start: z.int().min(0), end: z.int().min(1) })).max(10),
});
export const ConversationSearchResult = z.object({ conversation: ConversationSummary, match: SearchMatch });
export const ConversationSearchResults = z.object({
  results: z.array(ConversationSearchResult),
  nextCursor: z.string().nullable(),
});
```

`POST /api/v1/conversations/search` (`inbox.read`, every role) → 200 `ConversationSearchResults`. Body errors → 400 as other routes (Zod); a malformed cursor → 400 `bad_cursor`; a query that is shorter than 2 characters after masking and whitespace collapsing → 400 `query_too_short`. No counts, no realtime. The route is registered before `/:id` routes; it is a POST so the text stays out of URLs, access logs and browser history (D3).

## 4. Schema changes (migration `0047_message_search.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE INDEX messages_search_trgm_idx ON messages USING gin (tenant_id, body gin_trgm_ops);
```

Declared in `schema.ts` too (`index('messages_search_trgm_idx').using('gin', t.tenantId, t.body.op('gin_trgm_ops'))`) so `drizzle-kit generate` reports no drift; the extensions are hand-written above the index. `btree_gin` puts `tenant_id` in the same GIN index, so a tenant's search reads only its own entries (D5). Both extensions are trusted on RDS PostgreSQL 16 and ship with the local and Testcontainers images. No new table, no RLS change: `messages` keeps its forced RLS and `app_dashboard` already reads it.

## 5. Component design

### 5.1 Inbox: `search.ts` (`packages/inbox/src/search.ts`, exported from the index)

- `searchPatterns(q: string): string[] | null`: `piiMask(q)` (so an NRIC typed in the box matches its stored token, never the raw number), collapse whitespace, trim; under 2 code points → null. Escape `\`, `%` and `_`; the base pattern is `%<q>%`. **Phone variant (D6):** if `q` minus spaces, dashes and a leading `+65`/`65` is an SG number (`[3689]\d{7}`), add `%dddddddd%`, `%dddd dddd%` and `%dddd-dddd%` (deduplicated), so "9123 4567" finds "+65 91234567" and back.
- `searchConversations(tx, tenantId, { q, cursor, limit }, names?)` → `{ results, nextCursor }` or throws `QueryTooShortError` / `BadCursorError`:
  ```sql
  with hits as (
    select distinct on (m.conversation_id) m.conversation_id, m.id, m.author, m.body, m.created_at
    from messages m
    where m.tenant_id = $t and (m.body ilike $p1 or m.body ilike $p2 …)
    order by m.conversation_id, m.seq desc)
  select c.*, c.last_message_at::text as at, h.* from conversations c
  join hits h on h.conversation_id = c.id
  where c.tenant_id = $t and ($cursor is null or (c.last_message_at, c.id) < ($at, $id))
  order by c.last_message_at desc, c.id desc limit $limit + 1
  ```
  Then `namedPeople` and `toSummary` for the page (the list's `lastMessage` subquery as in `listConversations`), and `excerptOf(body, needles)` per row. Ordered by last activity, like the inbox (D4); the match is the latest matching message of that conversation. If the volume test (§5.4) shows the CTE over a common term too slow, the build may switch to a correlated `exists` per conversation page; same contract, recorded in tasks.md.
- `excerptOf(body, needles)` (pure, unit-tested): case-insensitive (`toLocaleLowerCase('und')` on both) first hit of any needle; a window of ≤ 160 characters starting up to 40 before it, cut on a space where one is within 10 characters, `…` at a cut end; `ranges` = every hit in the window (≤ 10). No hit found in JS (case-folding differs from Postgres) → the first 160 characters, `ranges: []`. Never splits a surrogate pair.

### 5.2 API (`apps/api/src/inbox.ts`)

`app.post('/api/v1/conversations/search', …)`: `reader(req)`, `ConversationSearchRequest.parse(req.body)`, `withTenant(dashboardDb, s.tenantId, tx => searchConversations(tx, s.tenantId, body, namesIn(s.tenantId)))`, `ConversationSearchResults.parse(out)`; `BadCursorError` → `badCursor(reply)`; `QueryTooShortError` → 400 `query_too_short`. Nothing is audited (a read, like the list; D7) and nothing about the query is logged.

### 5.3 Dashboard (detail in ui-design.md)

- `lib/search.ts` (pure, unit-tested): `normaliseQuery`, `canSearch` (≥ 2 code points), `highlightParts(excerpt, ranges)` → text/mark segments, `authorLabel` ("Visitor", "Assistant", "Team", "Update"), `resultsStatus(n, more)`. `useInboxSearch()`: the query text in a module store (`useSyncExternalStore`) so it survives opening a result and coming back; `resetInboxSearch()` is called wherever the workspace switch clears the query cache. Never in the URL, `sessionStorage` or `localStorage`.
- `lib/api.ts` `searchConversations(body)`; `useInfiniteQuery` key `['conversation-search', q]`, `staleTime` 30 s, debounce 300 ms (Enter searches at once).
- `pages/inbox-search.tsx`: `SearchField` (top of the list pane) and `SearchResults` (rows reuse `Row`'s parts with the excerpt in place of the preview). `pages/inbox.tsx` swaps the tabs, filters and list for `SearchResults` while a search is active.
- Opening a result navigates to `/inbox/:id` with router state `{ matchId }`; `ConversationPane` passes it to `ThreadLog`, which scrolls that message into view (`block: 'center'`) and marks it (`bubble--match`) when it is among the loaded messages; otherwise the thread opens at the bottom as usual.
- Top bar: a `search` icon button "Search conversations" (`shell/app-shell.tsx`, after the tenant switcher) → `/inbox` with state `{ focusSearch: true }`; the inbox focuses the field. `shell/icon.tsx` gains `search`.

### 5.4 Volume test (`packages/inbox/test/search-volume.int.test.ts`)

Seeds tenant A with 12 months of A1 volume (60,000 conversations, 480,000 messages of generated multi-word text with `generate_series`, spread over 365 days, plus planted needles: one rare email, one SG phone written three ways, a Chinese name 陈美玲 in 30 messages, and a common word in ~10% of messages) and tenant B with 100,000 messages containing the same needles; `ANALYZE`. Times `searchConversations` (first page, 25) for the rare email, the phone in each form, a 2-character Chinese query 美玲, and the common word: each ≤ 2,000 ms (worst of 3 runs), and tenant A never sees B's needles. Timeout 180 s.

### 5.5 E2E (`e2e/tests/inbox-search.e2e.ts`)

Dev tenant: send a widget message with a unique token and an email, search it from the inbox (by token, by part of the email), open the result (thread scrolled, message marked), back keeps the results; the second tenant's search for the token finds nothing; axe at 1280 and at 375 (tall viewport).

## 6. Acceptance criteria

- **AC-1** (INB-11 "message text") A search finds every conversation with a message containing the text, case-insensitive, as a substring, in any state (closed included) and any author; each result carries its summary, the latest matching message's excerpt with the hits marked, ordered by last activity, paged by cursor without duplicates or gaps.
- **AC-2** (INB-11 "contact … email, phone", D1, D6) An email typed in chat is found by its whole or a part; an SG phone is found whether written `91234567`, `9123 4567`, `9123-4567` or `+65 9123 4567`, from any of those forms; a query for an NRIC finds its masked token and never needs the raw number stored.
- **AC-3** (INB-11 "within the tenant", ADR-005) Tenant B's search never returns tenant A's conversations or excerpts; the query runs under `withTenant` with an explicit tenant filter; the body takes no tenant ID (an extra key → 400).
- **AC-4** (INB-11 "≤ 2 seconds for 12 months of data at A1 volumes") The §5.4 volume test passes: each first page ≤ 2,000 ms, including the 2-character Chinese query and the common word.
- **AC-5** (GOV-04, ADR-014) The search text is sent only in a POST body; it appears in no URL, request log line, audit entry or browser storage (log capture in the API test).
- **AC-6** (input rules) Under 2 characters after trimming → 400 (Zod) or `query_too_short` after masking; over 100 → 400; `%`, `_` and `\` match literally; a malformed cursor → 400 `bad_cursor`.
- **AC-7** (SCR-APP-014, NFR-09, NFR-19) The search field, the searching, results, no-results, error and load-more states, the marked excerpt, opening a result at its message, back to the same results, and the top bar's search entry render as in ui-design.md; at 375 px nothing scrolls sideways; axe reports no serious violations.

## 7. Decisions

- **D1 — Message text now; contact fields with FEAT-049.** `contacts` doesn't exist until FEAT-049 (plan §5 order 046 → 049). Visitors type their email and phone in chat, so message text already finds most of them. FEAT-049's design adds one more `hits` source (contacts whose name, email or normalised phone match → their conversations) unioned in `searchConversations`; the contract doesn't change. INB-11 stays partial until then (Ken's decision card, 2026-11-03; recorded in pending-actions).
- **D2 — Substring matching with `pg_trgm`, not full-text search.** Staff search for fragments ("jane@", "4567", an order number) and Chinese, which the `simple` FTS parser can't segment. `ILIKE` on a trigram index gives substring, case-insensitive matching in both languages. The plan row's "FTS" part isn't used; no ranking is needed (D4).
- **D3 — POST, text never in a URL.** A GET query string would land in Fastify's request log, ALB/CloudFront logs and browser history; search text is often an email or phone (ADR-014, GOV-04). The dashboard keeps it in memory only.
- **D4 — Newest activity first, the latest matching message shown.** Staff usually look for a recent chat; the order matches the inbox and the existing keyset cursor. No relevance ranking.
- **D5 — One composite GIN index (`btree_gin`).** `(tenant_id, body gin_trgm_ops)` keeps each tenant's lookup to its own entries as tenants grow, instead of matching every tenant's messages and filtering after.
- **D6 — SG phone variants.** A phone-shaped query expands into the three common spellings, each index-backed. Other numbers match as typed.
- **D7 — No audit, no rate limit.** A search is a read like the list, by authenticated staff of the tenant; PII stays out of logs (D3). Data-subject searches across stores are FEAT-061's (SCR-APP-049), not this.
- **D8 — Search spans every view and channel.** Tabs and filters are hidden while searching; results show each conversation's state chip. Results are a snapshot (not patched by realtime); typing again or Try again refreshes.

## 8. Escalations and open items

- INB-11 contact fields (name, email, phone on `contacts`) are left to FEAT-049 (D1); FEAT-049's design must add them to `searchConversations` and its tests, and the RTM's INB-11 Test ref stays partial until then. Added to pending-actions.
- The plan row's "Postgres FTS" is replaced by substring matching on `pg_trgm` (D2); recorded for the plan's next revision.
- A conversation whose matching message is older than the thread's loaded 100 opens at the bottom (the excerpt shows the hit); jumping into older pages is left for later if staff ask.

## 9. Self-check

- INB-11's clauses → AC-1 (message text), AC-2 (email, phone in text; contact fields D1), AC-3 (within the tenant), AC-4 (≤ 2 s at A1 for 12 months).
- No new tenant table; one index and two extensions in a migration; tenant ID from the session; RLS plus an explicit tenant filter (ADR-005).
- ADR-014/GOV-04: no search text in URLs, logs or audit; ADR-015: masked bodies stay masked and the query is masked the same way.
- UI uses design.md's `text-input`, `button` (icon), `alert`, `chip`, `skeleton`, empty and error states, and accent-soft for the hit (as the source passage well's highlight); tokens only.

Traceability: INB-11 (p) → AC-1–AC-6; SCR-APP-014 → AC-7; ADR-005 → AC-3; ADR-014, GOV-04 → AC-5. IDs checked: INB-11, UC-23, SCR-APP-014, SCR-APP-049, GOV-04, NFR-09, NFR-19, ADR-004, ADR-005, ADR-014, ADR-015, FEAT-042, FEAT-043, FEAT-044, FEAT-049, FEAT-061 resolve.
