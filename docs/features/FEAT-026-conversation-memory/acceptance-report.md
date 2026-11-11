# Acceptance report: FEAT-026 — Conversation memory and summarisation

> Verified 2026-11-11 by an independent verify session · Branch `feat/FEAT-026-conversation-memory` · PR #65

## Verdict summary

**Accepted.** AC-1 to AC-10 hold; every suite was re-run in this session and is green. Three gaps in test coverage (AC-2's gate-closed case, AC-3's concurrent fold, D5's 30-message cap) were closed with new tests in `memory.int.test.ts`. AGT-12's real-model half (the `judge: memory` criterion) scores only on the real-model eval run, so its Test ref is partial. One low-severity observation on lag beyond 200 messages (Findings).

## Audit standard

AGT-12 (Must): "the agent uses the conversation's history, including history carried over from a linked channel (CHN-07). Long conversations are summarised so that facts the visitor gave (name, need, quantities) are not lost. Acceptance: in a 40-turn evaluation conversation, the agent still uses details given in turn 2." UC-20 steps 3–5 and UC-26 step 4. The design's §6 criteria encode all three clauses (history: AC-1/4; linked channel: AC-7; summarised and not lost: AC-3/5/6), plus the invariants ADR-005 (AC-9), ADR-008/015 (AC-5), ADR-009 (AC-8), ADR-012 (AC-2/3) and ADR-007/021 (AC-10). No misencoding found.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | AGT-12; ADR-007 cost | agent `memory.int` "AC-1: a short chat…", "D5, AC-1 (verify): …newest 30"; `memory.test` foldPlan "not due below 20" | Yes: no job, no memory, no `summarise` call, all messages loaded; cap of 30 now tested | Pass |
| AC-2 | AGT-12; ADR-012 | `memory.int` "AC-2, AC-3, AC-10…" (job on group `memory:<id>`), "AC-2 (verify): a gate-closed turn…" | Yes; gate-closed case added by this session | Pass |
| AC-3 | AGT-12 | `memory.int` "AC-2, AC-3, AC-10…" (cutoff = all but last 10, provider failure writes nothing, duplicate skipped, other tenant skipped), "AC-3 (verify): two concurrent folds…"; `memory.test` "returns null on invalid output…" | Yes; concurrent case added. Re-enqueue follows from the enqueue condition in `store()` (unfolded ≥ 20) | Pass |
| AC-4 | AGT-12; UC-20 step 5 | `memory.int` "AC-4: suggestions and replay…", "AC-4, AC-7: the next turn…"; `compose.test` "the conversation memory in the reply" | Yes: `<memory>` opens the tail on every attempt, triage tail without the name, verbatim only after `upto_seq`, as-of-question loading | Pass |
| AC-5 | ADR-015, ADR-008, D2 | `memory.test` "cleanMemory (D2, AC-5)", "parseMemory…" | Yes: email, phone, amounts (S$, $, 元) dropped, NRIC masked, bounded | Pass |
| AC-6 | AGT-12 acceptance | eval `feat-026-memory.json` (8 cases, 40-turn case, `remembers`/`memory-excludes`); `pnpm eval` memory 8/8 = 1.000 (≥ 0.9) | Fake half yes; `judge: memory` needs the real-model run | Pass (partial) |
| AC-7 | AGT-12 CHN-07; UC-26 step 4 | `memory.int` "AC-4, AC-7…" after a move to Telegram | Yes | Pass |
| AC-8 | AGT-07 via ADR-009 | eval `rt-mem-*` in `feat-025-red-team.json`; `safety.test` data rule names `<memory>`; red-team 54/54 | Yes | Pass |
| AC-9 | ADR-005, ADR-015 | db `rls.int` "conversation memory (FEAT-026)" | Yes: cross-tenant read/insert denied, visitor select+insert, dashboard select only, no update/delete, cascade on conversation delete | Pass |
| AC-10 | ADR-007, ADR-021 | `memory.int` ledger check (purpose `summarise`, tenant); eval cost line includes folds | Yes | Pass |

## Changed existing tests (reviewed, not weakened)

- `compose.test.ts` "keeps only the last 10 messages" → "sends the history as loaded": the 10-slice moved from the prompt to the loader (design §5.4), and the loader's bound is now tested in `memory.int` (D5). Not a weakening.
- `safety.test.ts`: the data-rule string gains `<memory>`; same assertion.
- No skips, deleted cases or loosened matchers in the diff.

## Corrected tests

None rejected. Added (commit `FEAT-026 acceptance: add tests…`): AC-2 gate-closed, AC-3 concurrent fold, D5 cap.

## Independent execution

`scripts/test-env.sh scripts/check-summary.sh` in this session: format:check, lint (incl. dependency-cruiser and RTM), typecheck PASS; `pnpm test` 160 files / 1852 tests PASS; coverage `@kaki/agent` 562, `@kaki/db` 237, `@kaki/inbox` 126 PASS (contracts, agent-worker pass); `pnpm eval` PASS (memory 8/8, red-team 54/54, S$0.00096 per conversation ≤ S$0.03). `memory.int` with the new cases: 7/7 PASS.

## Direct verification

- Invariants: the summariser goes through `llm-gateway` (`summarise` logical model); the table has forced RLS, a policy, `TENANT_SCOPED_TABLES` entry and an RLS case; the fold is an outbox job enqueued in the reply's transaction; the memory never carries assistant-quoted figures (`cleanMemory` in code, D2); memory reaches prompts fenced as data.
- No UI, so no screens or E2E owed; GitHub CI runs the full suite.

## Findings

- **Observation (low), follow-up:** `runSummariseJob` reads at most the newest 200 unfolded messages (`FOLD_READ_LIMIT`). If more than 200 build up after the last memory (the summariser down for a long time, or a very long staff-run stretch), the fold's cutoff passes over the older ones and they are never summarised. Unlikely at SME volumes; fold the oldest window first, or loop, in a later change. Added to pending actions.

## RTM

`node scripts/check-rtm.mjs FEAT-026 --stage verify`: RTM check passed (FEAT-026). AGT-12 Test ref appended (partial: `judge: memory` on the real-model eval run).

## CI

CI_LINE
