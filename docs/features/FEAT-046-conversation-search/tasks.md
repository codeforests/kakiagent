# Tasks: FEAT-046 — Conversation search

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-11-03 (design)

- [x] T1 — Schema and contracts: `0047_message_search.sql` (`pg_trgm`, `btree_gin`, `messages_search_trgm_idx`) + the index in `schema.ts`; contracts section "conversation search" (`ConversationSearchRequest`, `SearchMatch`, `ConversationSearchResult`, `ConversationSearchResults`) (design §3, §4; AC-1, AC-6)
      Done when: `drizzle-kit generate` reports no drift after 0047; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes (migrations apply; the index exists with both columns); `pnpm --filter @kaki/contracts test` passes with round-trips, a 1-character and a 101-character `q` refused, an extra key refused.
- [ ] T2 — Inbox: `search.ts` (`searchPatterns` with masking, escaping and the SG phone variants; `excerptOf`; `searchConversations` with keyset paging, `namedPeople`, `toSummary`; `QueryTooShortError`), exported from the index (design §5.1; AC-1–AC-3, AC-6)
      Done when: `pnpm --filter @kaki/inbox test` passes with unit tests for `searchPatterns` (escapes `%`, `_`, `\`; NRIC masked; `9123 4567`, `+65-9123-4567` and `91234567` give the same three variants; under 2 after masking → null) and `excerptOf` (window and `…` cuts, ranges for several hits, Chinese, emoji not split, no-hit fallback); `scripts/test-env.sh pnpm --filter @kaki/inbox test:integration` passes with `search.int.test.ts`: substring and case-insensitive hits in visitor, agent and staff messages; closed conversations included; latest matching message chosen; order by last activity; two pages with no duplicates or gaps; `50%` matches literally; email part, phone in each spelling, Chinese name; tenant B sees none of A's.
- [ ] T3 — Volume test `packages/inbox/test/search-volume.int.test.ts` (design §5.4; AC-4)
      Done when: it passes through `scripts/test-env.sh` with every timed search ≤ 2,000 ms (worst of 3); record the timings and the plan used (`EXPLAIN (ANALYZE, BUFFERS)` summary line for the rare and common terms) in the Verification evidence. If a search is over, try the `exists` form (design §5.1) before stopping with a note.
- [ ] T4 — API: `POST /api/v1/conversations/search` in `apps/api/src/inbox.ts` (design §3, §5.2; AC-1, AC-3, AC-5, AC-6)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/api test:integration` passes with `search.int.test.ts`: 200 with summaries and marked excerpts for owner and agent roles; 401 without a session; 400 for a short, long or extra-key body, `query_too_short` for a query that masks below 2, `bad_cursor`; tenant B's session finds nothing of A's; a captured log stream contains neither the query text nor an email from it. The api typechecks.

## Build session 2 (UI)

- [ ] T5 — Dashboard: `lib/search.ts` (`normaliseQuery`, `canSearch`, `highlightParts`, `authorLabel`, `resultsStatus`, `useInboxSearch`/`resetInboxSearch`) with unit tests; `lib/api.ts` `searchConversations`; `pages/inbox-search.tsx` (`SearchField`, `SearchResults`); `pages/inbox.tsx` swaps tabs, filters and list while searching; `ThreadLog` scroll-to and `bubble--match` from router state; top bar search button and `search` icon; `resetInboxSearch` on workspace switch; CSS with tokens only (design §5.3; ui-design SCR-APP-014; AC-7)
      Done when: `pnpm --filter @kaki/dashboard test` passes and the dashboard typechecks; a stubbed-API Playwright check at 1280 and 375: typing "jane" searches once after the pause (one POST, body `q`), rows show the author label and a `mark` around the hit, the no-results and error states, Escape restores the tabs, opening a result marks the matched bubble, Back keeps the results, the top bar button focuses the field, `scrollWidth` 375 (log only the asserted fields).
- [ ] T6 — E2E `e2e/tests/inbox-search.e2e.ts` (design §5.5; AC-1, AC-3, AC-7)
      Done when: the spec is written and lints; it runs in the verify stage's GitHub CI.
      Note: no Docker in cloud sessions, so E2E and screen renders run in CI (STATE.md).
- [ ] T7 — Verify: full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for db, inbox, api through `scripts/test-env.sh scripts/check-summary.sh`; tick tasks; status `developer-done`.

## Verification evidence

- T1: `drizzle-kit generate` after 0047 → "No schema changes"; `@kaki/db` integration 4 files / 189 tests pass (new `message-search-index.int.test.ts`: both extensions, `USING gin (tenant_id, body gin_trgm_ops)`); `@kaki/contracts` 14 files / 51 tests pass (`search.test.ts`: round-trip, 1 and 101 code points refused, emoji counted as one, extra key refused).
- (T2–T7 below; one bullet per AC at T7)
