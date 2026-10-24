# Handoff: FEAT-028 — Replay a past conversation against the current KB
Branch: feat/FEAT-028-conversation-replay · PR: none · Updated: 2026-10-24 by build (backend)
Stage done: build (T1–T5 of 8)
Next: build (UI) — kickoff: "Build FEAT-028 (UI) on branch feat/FEAT-028-conversation-replay. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (all `coach.use`): `GET /api/v1/coach/replay-candidates?cursor` → `ReplayCandidateList`; `POST /api/v1/coach/replays {conversationId, includeUnreviewed}` → 201 `ReplayResponse`; `GET /api/v1/coach/replays/:id` → `ReplayResponse`; `POST /api/v1/coach/replays/:id/next {}` → `ReplayNextResponse {turn, remaining}`. Contracts in the `Dashboard API: replay` section of `@kaki/contracts`, plus `REPLAY_LIMIT` (20).
- Errors the page must handle: 409 `replay_complete` (stop the drive loop, show done), 404 `conversation_gone`, 429 `rate_limited` (pause, retry after a minute), 422 `nothing_to_replay` on start.
- `ReplayTurn.replayed` is a `CoachMessage` (kind `replay`, `correction: null`) with the FEAT-027 explainer; outcome `ended` and reasons `crisis`/`abuse_warning`/`abuse_ended` already have sentences in `lib/coach.ts` (`REASON_TEXT`). `effects` are task codes (`crisis`, `abuse`, `out_of_scope`, others `unhandled`).
- `factsChanged` is null when pending or when the original had no agent reply.
- Deviation: replay sessions have no title (the design said "first question cut to 80"), because a title would copy visitor text into `coaching_*` against D7/AC-8. The picker shows `firstQuestion` from the candidates list instead.
- Deviation: the T2 contract unit test lives in `apps/api/src/replay-contract.test.ts` (`@kaki/contracts` has no test setup and `@kaki/agent` doesn't depend on it).
- Backend tests: `pnpm --filter @kaki/agent test` (replay-dispatch), `scripts/test-env.sh pnpm --filter @kaki/agent test:integration` (replay.int, 12 cases), `scripts/test-env.sh pnpm --filter @kaki/api test:integration` (replay.int, 9 cases), db RLS suite. `pnpm lint` and `pnpm format:check` green after T5.

## Left to CI or later
- E2E (`replay.e2e.ts`, T7) and screen renders: CI only, pending until the next CI run.
- Conversation-screen entry point: FEAT-042.

## Pending for Ken
- None.
