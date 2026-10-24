# Tasks: FEAT-019 — Coverage report (template topics before go-live, gaps after)

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-24

- [x] T1 — Schema: `0030_coverage.sql` and Drizzle: `messages.gap_reason`, `gap_embedding`, `gap_correction_id` (FK, checks, two partial indexes, visitor column grant); `business_profiles.coverage_skipped_topics` (check, dashboard column grant); role `kaki_gap_cluster`, its grants and policies, and `kb_gap_cluster()` executable by `app_outbox` only (design §4; D2, D3, D5)
      Done when: `pnpm db:setup` applies 0030 on a database at 0029; `drizzle-kit generate` reports no drift; the RLS suite passes with tenant-B cases for gap columns and a `coverage_gap` item; db integration tests (crafted vectors): two near gaps form one item and a far one a second; a gap near an accepted item opens a new one; a gap older than 60 days isn't joined; an item whose messages were deleted closes automatically; the visitor role can set only the two gap columns; no login role but `app_outbox` can execute the function.
- [x] T2 — Contracts: the §3 coverage section (`CoverageTopic`, `CoverageGap`, `CoverageReport`, topic body), `ProposedChange` kind `answer_gap`, `CorrectionContext.gap` (design §3)
      Done when: workspace typecheck passes; contracts unit tests parse a sample report and a gap item, and reject an unknown topic state and a gap reason outside the three.
- [x] T3 — Inbox and agent: `markQuestionGap`, `gapQuestions`, `gapCounts`; the turn marks gaps in `store()` with the retrieval vector (design §5.1, §5.2; D2; AC-4)
      Done when: inbox and agent integration tests on the fake provider pass: `unavailable`, `unsure` and `escalated` turns with an `answer` task mark the visitor message once (redelivery included); `answered`, `out_of_scope`, `refused`, `paused`, safety-ended and no-embedding turns don't; FEAT-022–028 turn tests still pass.
- [x] T4 — KB and tenancy: `coverage.ts` `coverageReport` (topics by key and by meaning, fallback, gaps order and counts, stage), `runGapCluster`; corrections `answer_gap` (accept needs an `add_faq` edit, detail `gap` context, list summary); tenancy `coverageSkippedTopics`, `setTopicSkipped` with audit (design §5.3, §5.4; D1, D4–D8; AC-2, AC-3, AC-5–AC-9)
      Done when: kb and tenancy unit and integration tests pass: covered by FAQ key, by a near approved fact, never by needs_review/disabled/conflicted facts; skip and un-skip; `question_only` when embedding throws; gap ordering, 20 cap, newest question, counts; stage before and after the first conversation; accepting a gap item with an FAQ makes it visible in `visitor_facts` and drops it from the report; 422s; close changes no fact; no visitor text in `corrections` or audit payloads; FEAT-018's correction tests still pass.
- [x] T5 — Scheduler: `GAP_CLUSTER_INTERVAL_MS` (10 min, first run at start-up) running `runGapCluster` with a log line, in `.env.example` (design §5.5; AC-5)
      Done when: scheduler-worker typecheck passes; a unit test with a fake zone checks the run logs counts and survives an error.
- [x] T6 — API: `registerCoverageRoutes` (report, topic skip), memoized topic embedding, `answer_gap` through the corrections routes (design §3, §5.5; AC-1–AC-3, AC-6, AC-7, AC-9)
      Done when: api integration tests pass for every designed success and error: agent 403, 401, tenant B sees only its own state, 404 unknown topic, a topic covered after `POST /kb/facts`, the accept 422s on a gap item, and the report with a failing embedder.

## Build session 2 (UI)

- [x] T7 — Dashboard Coverage: `lib/coverage.ts`, `pages/coverage.tsx` (SCR-APP-029: pre-live, live, all covered, no template, question-only notice, add-FAQ dialogs for topics and gaps, Doesn't apply / Undo, Not something to answer), Knowledge "Coverage" tab, setup review coverage summary (SCR-APP-008 partial) (ui-design SCR-APP-029, SCR-APP-008)
      Done when: dashboard typecheck and unit tests pass (`lib/coverage.test.ts`: section order per stage, counts copy, topic state chips, gap reason copy, "{n} times" plurals).
      Note: no local stack in cloud sessions; renders are checked by T9's E2E in CI. The topic counts leave skipped topics out ("{covered} of {applying}"), so the summary and the collapsed "All {n} … answered" line agree; the FAQ dialog is shared as `pages/faq-dialog.tsx` (Coverage and the gap item); `INDUSTRY_LABEL` is exported from `business-profile.tsx`.
- [x] T8 — Dashboard Corrections: `answer_gap` in `lib/corrections.ts` (summary, label), SCR-APP-021 row, SCR-APP-022 "Customers asked" context and "Add an FAQ" accept dialog (ui-design SCR-APP-021/022 extended)
      Done when: dashboard typecheck and unit tests pass (`lib/corrections.test.ts` new cases for `answer_gap`); FEAT-018's cases still pass.
      Note: `itemSummary(item)` replaces `fixSummary` on the row and the detail title (an accepted gap reads as its FAQ, "New FAQ: …"); the gap's closed-by-system banner reads "Closed automatically: the chats it came from were deleted."
- [ ] T9 — E2E: `e2e/tests/coverage.e2e.ts`: pre-live Coverage lists the F&B topics as missing → the owner adds an FAQ for one and marks another "Doesn't apply" → a widget visitor asks something the KB can't answer → the spec runs `kb_gap_cluster()` over a superuser connection (as `corrections.e2e.ts` runs the stale scan) → Coverage is live and lists the gap → the owner adds an FAQ from it → it leaves Coverage and Review › Corrections; axe on Coverage and on the gap item (design §6; AC-3, AC-4–AC-7, AC-10)
      Done when: the spec passes in Ken's local CI E2E run.
      Note: E2E runs only in Ken's local CI (STATE.md); written and typechecked here, pending CI.
- [ ] T10 — Verify: every AC in design §6 demonstrated; `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, this feature's package unit and integration tests green
      Done when: the evidence below is filled in, one bullet per AC.

## Verification evidence

(filled in by T10)
