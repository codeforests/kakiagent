# Handoff: FEAT-019 — Coverage report
Branch: feat/FEAT-019-coverage-report · PR: none · Updated: 2026-10-24 by build (backend)
Stage done: build (T1–T6 of 10)
Next: build (UI, T7–T10) — kickoff: "Build FEAT-019 (UI) on branch feat/FEAT-019-coverage-report. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes: `GET /api/v1/kb/coverage` → `CoverageReport`; `PUT /api/v1/kb/coverage/topics/:topicId` `{ skipped }` → `{ topic: CoverageTopic }` (404 `not_found` for an unknown id). Both `kb.manage`. Contracts in `@kaki/contracts` (`CoverageReport`, `CoverageTopic`, `CoverageGap`, `CoverageTopicBody`, `CoverageTopicResponse`, `COVERAGE_GAP_LIMIT`, `GapReason`, `GapQuestion`).
- Topic ids are the template's (`fnb.dine-in`, `fnb.payment`, …). Answer a topic with the existing `POST /api/v1/kb/facts` (`type: 'faq'`); it then reads `covered` by question key.
- Gap items in the queue: `change: { kind: 'answer_gap' }`. Accept with `edit: { kind: 'add_faq', question, answer }` (none → 422 `invalid_correction`, a fact edit → 422 `not_editable`); success is `edited_and_accepted`, `replay: null`. Close as any item.
- **Deviation (additive):** `CorrectionItem.gap` = `{ question, asksTotal } | null | undefined` (`nullish`) for the SCR-APP-021 row ("Customers asked: “…”", "{n} times"); the design had it only on the detail. `CorrectionContext.gap` = `{ asks30d, asksTotal, lastAskedAt, questions[≤5] }` on gap items, null otherwise; gap items return `conversation: null` (their questions replace the one-conversation excerpt).
- Dashboard stubs from T2 so typecheck passes: `answer_gap` cases in `lib/coach.ts` (`diffRows` [], `changeSubject` "New FAQ", `confirmedLine` "answer") and `lib/corrections.ts` (`fixSummary` generic line, `noReplayCaption` as add_faq). T8 replaces `fixSummary` with the designed copy using `item.gap`.
- E2E (T9): group gaps with `select * from kb_gap_cluster()` as `app_outbox` or the superuser. A widget question marks a gap only when the turn ends `unavailable`, `unsure` or `escalated` with an `answer` task and an embedding; check which widget question ends that way on the fake provider (see the FEAT-019 cases at the end of `packages/agent/test/turn.int.test.ts`), or mark a message directly as the api test does.
- Backend layout: kb `coverage.ts` (`coverageReport`, gap stats come in through a port so kb never reads messages), kb `gap-cluster.ts` (`@kaki/kb/gap-cluster`, used by scheduler-worker), api `coverage.ts` and `gaps.ts` (inbox `gapCounts`/`gapQuestions` → kb port, correction context), tenancy `coverage.ts`, inbox `markQuestionGap`, `hasConversation`.

## Left to CI or later
- E2E (`coverage.e2e.ts`, T9) and screen renders run only in Ken's local CI.
- `apps/api/test/uploads.int.test.ts` (S3 presigner) can't run in cloud sessions (no S3 endpoint); it fails the same on the base commit.

## Pending for Ken
- Nothing blocks the UI build. Later check (pending-actions.md, from design): tune the two distances (0.25, 0.35) on real Cohere embeddings at the M1.5 real-model gate.
