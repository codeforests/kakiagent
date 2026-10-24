# Tasks: FEAT-018 — Correction queue, stale-fact scan and old-versus-new replay

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-24

- [x] T1 — Schema: `0029_corrections_queue.sql` and Drizzle: `corrections.accepted_change` with its check, the open-stale partial unique index and the closed-list index; `coaching_sessions` origin `correction`, `correction_id` (FK, unique), `replay_question_ids`, `replay_matched`; `coaching_messages.replay_conversation_id` (FK to conversations on delete cascade, backfilled, check); GIN index on `messages.fact_ids`; `tenants.fact_review_months` with check and the dashboard column grant; role `kaki_stale_scan`, its grants and policies, and `kb_stale_scan()` executable by `app_outbox` only (design §4; D1, D8, D9)
      Done when: `pnpm db:setup` applies 0029 on a database at 0028; `drizzle-kit generate` reports no drift; the RLS suite passes with tenant-B cases for a stale item and a correction session; db integration tests: the scan flags an overdue approved fact once, skips needs_review, disabled and expired promotions, honours a tenant's months, closes an item after re-confirmation; deleting a conversation removes a correction session's answers from it; no login role but `app_outbox` can execute the function.
- [x] T2 — Contracts: the §3 corrections section (`CorrectionSource`, `CorrectionItem`, `CorrectionFact`, `CorrectionContext`, `CorrectionEdit`, `CorrectionReplay`, `CorrectionReplayTurn`, `ReviewIntervals`, list query, accept body), `ProposedChange` kind `reconfirm`, review summary `openCorrections` and `overdueFacts`, `CorrectionConfirmResponse.replayQuestions` (design §3)
      Done when: workspace typecheck passes; contracts unit tests parse a sample item, replay and intervals, and reject months 0 and 25 and an `edit_hours` edit.
- [x] T3 — KB and tenancy: `listCorrections`, `correctionFacts`, `correctionCounts`, `acceptCorrection` (edit path, `accepted_change`, `edited_and_accepted`, `reconfirm`), `reconfirmFact`, `correctionFactInput` for the effective change, `proposeCorrection` origin, `runStaleScan`; tenancy `reviewIntervals`/`saveReviewIntervals`; audit entries (design §5.1, §5.2; D2, D6, D7; AC-2–AC-6, AC-9)
      Done when: kb and tenancy unit and integration tests pass: open items leave `visitor_facts` unchanged; accept, edit-and-accept, close and re-confirm each change exactly what §6 says; stale and closed errors; invalid and no-op edits; the re-confirmed fact is still found by `searchVisitorFacts`; counts; audit payloads codes and IDs only; FEAT-027's coaching confirm tests still pass.
- [x] T4 — Scheduler: `STALE_SCAN_INTERVAL_MS` (24 h, first run at start-up) running `runStaleScan` with a log line, in `.env.example` (design §5.5; AC-5)
      Done when: scheduler-worker typecheck passes; a unit test with a fake zone checks the run logs counts and survives an error.
- [x] T5 — Inbox and agent: `pastQuestionsUsing`; `startCorrectionReplay`, `getCorrectionReplay`, `correctionReplayNext`; `replay.ts` changes (`replay_conversation_id`, per-conversation abuse count, origin checks, `originalRepliesFor` exported); `listSessions` excludes `correction` (design §5.3, §5.4; D3–D5, D9; AC-7, AC-8)
      Done when: agent and inbox integration tests on the fake provider pass: 25 matching questions → 20 newest before acceptance, `matched` 25; a replayed answer renders the new value; order, 409 after the last; idempotent start; add_faq, hours and reconfirm have no replay; no `conversations`/`messages`/`outbox` writes and usage rows carry `coaching_session_id`; a deleted conversation drops its question; FEAT-028's replay tests still pass.
- [ ] T6 — API: `registerCorrectionRoutes` (list, detail, accept, close, replay next), review-interval routes, summary fields, coach confirm starting the replay, error mapping (`not_editable`), rate limit (design §3, §5.5; AC-1, AC-3, AC-4, AC-7, AC-10, AC-12)
      Done when: api integration tests pass for every designed success and error, including agent-role 403, 401, tenant B's 404s and empty list, 409 `correction_closed`/`correction_stale`, 422 `invalid_correction`/`not_editable`, the 429, the lazy replay start, and one `…/replay/next` under 8 s on the fake provider.

## Build session 2 (UI)

- [ ] T7 — Dashboard: shared `pages/answer-compare.tsx` (moved from `replay.tsx`, FEAT-028 unchanged), `lib/corrections.ts`, `pages/corrections.tsx` (SCR-APP-021 with filters, closed view, review-intervals dialog), `pages/correction.tsx` (SCR-APP-022: open, stale, editing, applying, applied with replay drive loop, closed), Corrections tab and count in `ReviewTabs`, Review nav count, coach confirm card link (ui-design SCR-APP-021, SCR-APP-022)
      Done when: dashboard typecheck and unit tests pass (`lib/corrections.test.ts`: origin labels, diff rows for each change kind, effective change, "{k} of {n}" copy, the drive loop stops on error and pause); `lib/replay.test.ts` still passes.
      Note: no local stack in cloud sessions; renders are checked by T8's E2E in CI.
- [ ] T8 — E2E: `e2e/tests/corrections.e2e.ts`: a widget visitor asks a price → the owner teaches a new price in Coach without confirming → Review › Corrections lists it → the owner edits the fix and accepts → the comparison shows the old price under "What the customer got" and the new one under "What your assistant says now"; a stale item (the spec moves the fact's `last_confirmed_at` back and runs `kb_stale_scan()` over a superuser connection, as other specs seed state) re-confirmed in one tap; axe on both screens (design §6; AC-3, AC-6, AC-7, AC-11)
      Done when: the spec passes in CI's E2E job.
      Note: E2E runs only in CI (STATE.md); written and typechecked here, pending CI.
- [ ] T9 — Verify: every AC in design §6 demonstrated; `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, this feature's package unit and integration tests green
      Done when: the evidence below is filled in, one bullet per AC.

## Verification evidence

(filled in by T9)
