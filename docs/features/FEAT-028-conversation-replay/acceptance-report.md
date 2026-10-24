# Acceptance Report: FEAT-028 — Replay a past conversation against the current KB

> Verdict: **Accepted** (AGT-17 gets a partial Test ref: this report verifies its replay clause; FEAT-027's coaching clauses still need their own report) · Date: 2026-10-24
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-11) @ `737fc8d` · Sources: SRS v0.4 (AGT-17; NFR-01), use-cases v0.4 (UC-04 4b), ADR-009, ADR-014, ADR-015, ADR-025, ADR-027
> Repo state audited: `737fc8d` (implementation head); no test corrections were needed

## Verdict summary

FEAT-028 is accepted. Each of AC-1..AC-11 has tests that assert what the criterion says, except the E2E and axe half of AC-3 and AC-10, which runs in CI (pending, per STATE.md's cadence). The feature's test diff only adds lines: no skips, no loosened assertions, no thresholds or coverage settings changed. A mutation check (`REPLAY_LIMIT` 20 → 21) turned exactly the "first 20 of 34" test red. There are no rework or design-defect findings; three minor notes are under Findings.

This session didn't write the code. The standard was re-derived from AGT-17, UC-04 4b and design §6, not from tasks.md, and every green below was observed in this run.

## Audit standard

- **AGT-17 (M), replay clause:** "The owner can also replay a real past conversation against the current KB." Acceptance (shared with coaching): "Coaching conversations never reach visitors, are excluded from analytics and fair use, and are audit-logged." Encoded by AC-2..AC-9 (replay is a coaching session: no visitor writes, usage on the coaching session, audited). Faithful. The coaching clauses are FEAT-027's (merged without a verify stage), hence partial.
- **UC-04 4b:** "the system re-answers it with the current KB and shows both versions." Encoded by AC-2 (original replies grouped per question), AC-3 (current KB), AC-10 (both columns on SCR-APP-031). Faithful.
- **Binding NFRs:** NFR-01 (full reply p95 ≤ 8 s) AC-11, indicative on the fake provider; real-model latency is M1.5's. Tenant isolation (ADR-005) AC-1 and the RLS case; ADR-014 AC-9; ADR-015 AC-8; ADR-025 decision 7 AC-5.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | AGT-17, ADR-009, ADR-005 | `apps/api/test/replay.int.test.ts` "who can replay" (staff 403 `forbidden` and 401 on all four routes; tenant B 404 on A's conversation, replay and `…/next`; malformed ID 404; B's candidates exclude A's); `packages/db/test/rls.int.test.ts` replay-session case | faithful | green |
| AC-2 | UC-04 4b | api "picking and starting" (no empty conversations; first question, count, flagged, `lastReplayId`; every turn pending; 422 `invalid_body`, `nothing_to_replay`); agent `replay.int` candidates (newest first) and original replies grouped | faithful | green |
| AC-3 | AGT-17 "current KB" | agent `replay.int` "renders a changed fact's new value" (original `$55.00`, replayed `$62.00`, explainer `matched_facts`); "uses unreviewed facts only when included, and labels them" (`unreviewed_used`); E2E `e2e/tests/replay.e2e.ts` | faithful; see minor 1 | green; E2E pending CI |
| AC-4 | ADR-009 | agent `replay.int` "equals the reply a live visitor turn gives" (body, outcome, fact IDs vs `runVisitorTurn`) | faithful | green |
| AC-5 | ADR-025 d7 | `packages/agent/src/replay-dispatch.test.ts` (crisis, abuse warn then end, out of scope, base port has no writing side, `propose_correction` refused); agent `replay.int` (crisis text, effect `crisis done`, no flag; abuse warning then end, `status`, `flag_reasons`, `abuse_turns` unchanged) | faithful | green |
| AC-6 | AGT-17, ADR-009 | agent `replay.int` "no conversation, message or outbox rows; usage on the coaching session" (row counts equal; usage rows with `coaching_session_id`, `conversation_id` null) | faithful | green |
| AC-7 | design §3 | agent `replay.int` (in order, then `ReplayCompleteError`; concurrent calls store one row; 34 → 20, total 34); api 409 `replay_complete` | faithful; mutation (limit 21) → red | green |
| AC-8 | ADR-015 | agent `replay.int` "is deleted with its conversation" (sessions and messages gone; `ConversationGoneError`) and visitor text absent from `coaching_*`; api 404 `conversation_gone`, then 404 | faithful | green |
| AC-9 | AGT-17, ADR-014 | agent `replay.int` (`coach.replay.started`, `coach.replay.turn`; payloads free of the name and question words) | faithful | green |
| AC-10 | UC-04 4b, NFR-09 | `apps/dashboard/src/lib/replay.test.ts` (12: progress, "first 20 of N", effect sentences, drive loop stops on pause and error, 409 as done); api "keeps replay sessions out of the Coach chat list"; E2E renders and axe in `replay.e2e.ts` | faithful | unit and api green; E2E pending CI |
| AC-11 | NFR-01 | api "answers one question per call within 8 s" (fake provider) | faithful; indicative only | green |

## Corrected tests

None.

## Independent execution

All through `scripts/test-env.sh` (local Postgres 16 + pgvector; no Docker), at `737fc8d`:

- `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser, 0 violations), `pnpm typecheck` (26 tasks), `pnpm test` (23 tasks): green.
- `test:coverage` (unit + integration, thresholds): `@kaki/db` 106/106, `@kaki/inbox` 7/7, `@kaki/agent` 388/388 (replay.int 12): green. `@kaki/api` 222 passed, red only on `uploads.int` "the S3 presigner", which needs LocalStack through a container runtime (not touched by FEAT-028); rerun excluding that file, 175/175 with thresholds met.
- `drizzle-kit generate`: no drift. Migrations 0000–0028 applied to a fresh database by the db suite.
- E2E (`replay.e2e.ts`, renders, axe): not run here; pending CI's E2E job.

## Direct verification

- Invariants: replay runs on the dashboard zone through `withTenant`, tenant from the session (`apps/api/src/coach.ts`); `ReplayPorts` has no database handle; the rate limiter runs after the 404 check, so another tenant's ID doesn't spend the budget; no provider SDK outside `llm-gateway`; the migration keeps RLS and grants unchanged (the visitor role still has no grant, asserted in the RLS suite).
- ADR-027 is accepted and recorded; the RTM Design ref already lists it.

## Findings

**Rework:** none.

**Design defect:** none.

**Minor:**

1. `factsChanged` compares fact IDs, so editing a fact's price in place renders the new price but shows no "Uses different facts" chip (ui-design SCR-APP-031). AC-3 as written holds, and the E2E replaces the fact to show the chip. Owners will usually edit in place, so the chip should probably also compare fact versions. Already in pending-actions; a fit for FEAT-018, which reuses `replayQuestion`.
2. Design §5.1 says the replay session's title is the first question cut to 80; the build leaves it null, which follows D7 and AC-8 (no visitor text in `coaching_*`). The tests assert the null. The design line should be read as superseded by D7.
3. Deviations recorded by the build and accepted here: the "Replay a conversation" link stays in the Coach page head at every width (no overflow menu exists yet); the candidate row says "Replayed before · View"; a 429 disables Continue for 60 s.

## RTM

Test ref appended (Test ref column only):

- AGT-17: `features/FEAT-028-conversation-replay/acceptance-report.md (partial)`
