# Handoff: FEAT-046 — Conversation search
Branch: feat/FEAT-046-conversation-search · PR: none · Updated: 2026-11-03 by build (backend)
Stage done: build (T1–T4 of 7)
Next: build (UI, T5–T7) — kickoff: "Build FEAT-046 (UI) on branch feat/FEAT-046-conversation-search.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Route: `POST /api/v1/conversations/search`, body `ConversationSearchRequest` `{ q, cursor?, limit? }` (strict; `q` is trimmed and whitespace-collapsed by Zod, 2–100 code points), → 200 `ConversationSearchResults` `{ results: [{ conversation: ConversationSummary, match: SearchMatch }], nextCursor }`. `SearchMatch` = `{ messageId, author, at, excerpt, ranges: [{ start, end }] }`; ranges are UTF-16 offsets into `excerpt`, sorted, non-overlapping, may be empty; `excerpt` may start/end with `…`.
- Errors: 400 `bad_request` (Zod, also for a query that collapses below 2), 400 `bad_cursor`, 400 `query_too_short` (guard; not reachable over HTTP today), 401/403 as other inbox routes. Every role with `inbox.read` may search.
- The UI's `normaliseQuery` should collapse whitespace the same way (`/\s+/gu` → ' ', trim) and count code points (`[...s].length`), so `canSearch` agrees with the server.
- Opening a result: `match.messageId` is the message to scroll to and mark (`bubble--match`); results include closed conversations.
- Build note B1 (tasks.md): the search reads through SECURITY DEFINER `inbox_search_hits()` because RLS keeps `ILIKE` from being an index condition. Contract unchanged; nothing for the UI to do.
- The dashboard's `pnpm tokens` must run before dashboard tests in a fresh clone.

## Left to CI or later
- E2E (`inbox-search.e2e.ts`) and screen renders run in the verify stage's GitHub CI.
- `apps/api` `uploads.int.test.ts` needs S3 (Testcontainers or `KAKI_TEST_S3_ENDPOINT`); it fails in cloud sessions for that reason only.
- Full `pnpm lint`, `pnpm typecheck`, `pnpm format:check` and coverage run in T7.

## Pending for Ken
- None. For the verify stage: check build note B1 (new NOLOGIN role and SECURITY DEFINER read) against ADR-005.
