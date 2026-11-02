# Acceptance Report: FEAT-027 — Coaching mode

> Verdict: **Accepted** (retrospective: FEAT-027 merged 2026-10-24 in PR #25 without a verify stage; this report closes that gap) · Date: 2026-11-02
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-15) · Sources: SRS v0.4 (AGT-17, ONB-05, KB-16, KB-18, AGT-04, AGT-16; NFR-01), use-cases v0.4 (UC-04 main flow, 2a, 4, 5a), ADR-009, ADR-014, ADR-025, ADR-026
> Repo state audited: `main` at `2b86ba8` (FEAT-027 code as merged in `55f81cc`, plus later features' additions to its tests); no test corrections were needed

## Verdict summary

FEAT-027 is accepted. Each of AC-1..AC-15 has tests that assert what the criterion says, and every one was observed green in this session or in GitHub CI. Because the verify stage was skipped at merge, this audit runs against `main` nine features later, so it also checks that the coaching tests weren't weakened since: they weren't (see "Test diff since the merge").

This session didn't write the code. The standard was re-derived from AGT-17, ONB-05, UC-04 and design §6, not from `tasks.md`.

## Audit standard

- **AGT-17 (M), coaching clauses:** the owner asks questions, sees which facts the answer used, and teaches corrections that become proposals; confirming one is live for visitors within 60 seconds; coaching never reaches visitors, is excluded from analytics and fair use, and is audit-logged. Encoded by AC-1..AC-9, AC-11, AC-12. The replay clause is FEAT-028's (its own report).
- **ONB-05 (M):** a test-your-bot playground before going live, provided by coaching mode. Encoded by AC-2, AC-8, AC-11 (works before any channel is live) and AC-13 (SCR-APP-010, the setup's test step).
- **UC-04:** 1–3 AC-2; 2a AC-4; 4–5 AC-5; 5a AC-7; 6–7 AC-6.
- **Cross-cutting:** KB-16 (unreviewed facts) AC-3; KB-18 (corrections queue) AC-5..AC-7; AGT-16/ADR-026 (visitors can't correct) AC-10; ADR-005 tenant isolation AC-1 and the RLS case; ADR-014 AC-9; NFR-01 AC-15 (indicative on the fake provider); AGT-14 AC-14.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | AGT-17, ADR-009 access | api `coach.int` "refuses staff with 403 and no session with 401 on every route", "gives tenant B 404 for tenant A's sessions and corrections, and for malformed IDs" | Yes: all routes, both refusals, cross-tenant 404 | Pass |
| AC-2 | AGT-17, ONB-05; UC-04 1–3 | api `coach.int` "answers with the explainer within the 8 s bound…"; agent `coach.int` "is grounded and verified, with an explainer…" | Yes: price from the slot, explainer facts with type and status, reason codes | Pass |
| AC-3 | KB-16 | agent `coach.int` "leaves unreviewed facts out unless asked, and labels them when used"; kb `corrections.int` and coaching search tests | Yes: flag off/on, `visitorsWouldGet: 'without_unreviewed'`; rejected, conflicted, disabled never used | Pass |
| AC-4 | UC-04 2a, AGT-04 | agent `coach.int` "gives the AGT-04 text to an out-of-scope question" | Yes: the same text a visitor gets | Pass |
| AC-5 | KB-18; UC-04 4–5 | agent `coach.int` "stores an open proposal and makes no reply-model call…"; api `coach.int` "proposes, then a confirm…" | Yes: open `coaching` row with `fact_refs`, before/after, visitor search still the old price before confirm | Pass |
| AC-6 | AGT-17 "within 60 seconds"; UC-04 6–7 | api `coach.int` "proposes, then a confirm makes visitors see the new price, with before and after"; E2E `coach.e2e.ts` (widget quotes the new price) | Yes: `searchVisitorFacts` returns the new value straight after the response; one audit entry | Pass (E2E in CI) |
| AC-7 | UC-04 5a | api `coach.int` "dismisses with no fact change; deciding twice is correction_closed", "is correction_stale when the fact changed…" | Yes: both 409 codes, nothing changed | Pass |
| AC-8 | AGT-17 isolation, ONB-05 | api `coach.int` "a turn" (no `conversations`/`messages`/`outbox` rows); agent `coach.int` "writes no conversations… usage is keyed by the session"; db `rls.int` "coaching and corrections (FEAT-027)" | Yes: `coaching_session_id` set, `conversation_id` null; no `app_agent_visitor` grant | Pass |
| AC-9 | ADR-014 | agent `coach.int` "stores the masked text and audits codes and IDs only"; api `coach.int` payload check (no fact name or price; UUIDs stripped first) | Yes | Pass |
| AC-10 | AGT-16, ADR-026 | agent `coach.test` "is refused without a correct task, and in a visitor context", "lists correct; the visitor prompt never does" | Yes: `scope` refusal, visitor plans never dispatch `correct` | Pass |
| AC-11 | ONB-05 "before going live" | agent `coach.int` "works while paused or not live…"; api `coach.int` "coaching still answers… offline notice" (added by FEAT-034) | Yes: `fallback_paused`, `not_live` | Pass |
| AC-12 | D10 hours | agent `coach.int` "proposes sat and sun, and confirming saves the profile that the visitor slot reads", "a profile saved in between makes the confirm stale…"; api `coach.int` "confirms an hours change through the business profile" | Yes | Pass |
| AC-13 | ui-design, axe | E2E `coach.e2e.ts` (SCR-APP-030 states, SCR-APP-010, `expectNoSeriousA11yViolations`); dashboard `lib/coach.test.ts` (quick panel prefill, narrow route) | Yes: the panel confirms only on the Confirm tap (same `CoachChat`) | Pass (E2E in CI) |
| AC-14 | plan §3, AGT-14 | evals `coaching.test.ts`; `pnpm eval` coaching subset | Yes on the fake provider; real-model run pending (pending-actions.md) | Pass (fake) |
| AC-15 | NFR-01 | api `coach.int` "answers with the explainer within the 8 s bound…" (`elapsed < 8000`) | Indicative only: fake provider; real latency is M1.5's | Pass |

## Corrected tests

None.

## Test diff since the merge

`git diff 55f81cc origin/main` over the coaching tests (`apps/api/test/coach.int.test.ts`, `packages/agent/test/coach.int.test.ts`, `e2e/tests/coach.e2e.ts`) only adds cases or adapts to later features: FEAT-034's offline case, FEAT-054's blocked-topic case, FEAT-057's `ai_paused_at`/`ai_paused_by` columns, FEAT-035's wizard (Continue became a button), and the AC-9 payload check now strips UUIDs before matching `/fudge|58/i` (it failed about one run in eight on a random ID; the content check is unchanged). No skips, no loosened assertions, no threshold changes.

## Independent execution

Through `scripts/test-env.sh` (local Postgres 16 + pgvector; no Docker), on `main` at `2b86ba8`, 2026-11-02:

- Integration: api 30 files, 354 passed and 1 skipped; red only on `uploads.int` "the S3 presigner", which needs LocalStack through a container runtime (not FEAT-027's). `coach.int` alone: 12/12. agent 105, kb 151, db 183 (RLS suite): green.
- Unit: agent 369, kb 218, evals 33, dashboard 190: green.
- `pnpm eval`: every subset ok; coaching 18/18 = 1.000 (threshold 0.9), 4 naturally worded cases real-model only.
- E2E (`coach.e2e.ts`, axe on SCR-APP-030 and SCR-APP-010): green in GitHub CI run 96 (`037a1d5`, 2026-11-01, all three browsers), and re-run on this PR's branch (recorded in the PR).

## Direct verification

- Invariants: coaching runs in the api on the dashboard zone through `withTenant`, tenant from the session (`apps/api/src/coach.ts`); the scope is fixed by the entry point (ADR-009), and corrections are proposals in `corrections`, never direct fact edits (ADR-010); no provider SDK outside `llm-gateway`; the three new tables have forced RLS and RLS cases.
- RTM Design ref for ONB-05 and AGT-17 already lists FEAT-027's design and ADR-026.

## Findings

**Rework:** none.

**Design defect:** none.

**Minor:**

1. The chats list has no creator name (`CoachSession` has no creator field), as the build noted; fine for one-owner tenants, worth adding with team-heavy tenants.
2. The process gap itself: the feature merged without this report. The verify stage now runs `node scripts/check-rtm.mjs FEAT-NNN --stage verify`, and `pnpm lint` runs the RTM check on every feature, so a missing Design, Plan or Test ref fails the checks.

## RTM

Test ref appended (Test ref column only):

- ONB-05: `features/FEAT-027-coaching/acceptance-report.md`
- AGT-17: `features/FEAT-027-coaching/acceptance-report.md (coaching clauses; with FEAT-028's replay, AGT-17 is complete)`
