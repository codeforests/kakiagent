# Build state

The one file a fresh build session reads first. Keep it under 80 lines. The verify stage updates it in the feature PR, so `main` is always current once a PR merges.

## Where the build is

- **Next feature:** FEAT-075 Inbox redesign (owner request 2026-11-14; design done on `feat/FEAT-075-inbox-redesign`, build next), then M5: FEAT-060 → 061 → 059 → 062 → 070 → 063 → 010 → 067 → 065 → 066 → 071 → 072 → 073 (plan §5; Ken says when). FEAT-029 accepted 2026-11-12 (PR #67; every widget message carries its current page, D2; consent mode asks inside the chat panel, D1; the model gets paths and the returning flag only and `trackingGuard` blocks reveals; FEAT-061 must delete `visitor_events`/`visitor_tracking_choices` per contact; FEAT-030 reads the tracker state). FEAT-026 accepted 2026-11-11 (PR #65; memory folds every 20 unfolded messages on its own outbox group, the memory reaches prompts as fenced data; staff-facing memory view is a possible follow-up, D7). FEAT-038 accepted 2026-11-11 (PR #64; the same conversation moves channel, D2; the widget doesn't resume a conversation across reloads, so a moved chat shows its moved state only in the open page; confirm-page copy follow-up in pending actions). FEAT-039 accepted 2026-11-10 (PR #63; typed lead-form details never join contacts, D1; FEAT-038 calls `attachVerified` from its link paths). FEAT-037 accepted 2026-11-10 (PR #62; Telegram alerts come from each business's own bot, D1). FEAT-036 accepted 2026-11-08 (PR #61); FEAT-037/040 reuse its delivery path (`deliver.ts`, the `messages_channel_delivery` trigger) and `ai_reply_cap`. M3 closed 2026-11-07: `pipeline-verify` (`docs/pipeline-verify-report.md`; findings to route: plan §4 rows missing 26 requirement/feature pairs, 15 warnings) and Ken's demo signed off. FEAT-029 also adds page/UTM context to INB-04's intent block (Ken, 2026-11-07). FEAT-051 accepted 2026-11-07 (PR #57).
- **M4:** closed 2026-11-14 (Ken ran the demo of J5, J9 and Telegram owner alerts, all steps completed; script in project files `guides/m4-demo-script.md`). Features done 2026-11-12. pipeline-verify at 80d6758: 33 errors (26 from M3's unmerged PR #60, 7 M4 plan rows), all fixed in PR #68 (0 errors, 3 M6 warnings; `docs/pipeline-verify-report.md`, rerun with `python3 scripts/pipeline-verify.py`). `check-rtm.mjs` now also fails when a Plan ref feature's §4 row doesn't list the requirement, so **detailed design must amend the feature's §4 FRs column when it takes on a requirement**. Demo script: project files `guides/m4-demo-script.md`; Ken signs off before FEAT-060.
- **M3:** closed 2026-11-07. Its pipeline-verify fixes landed with PR #68 (PR #60 superseded). FEAT-053 (webhooks) must call `exportable()` at send time (LED-06).
- **Demos:** the interim demo after FEAT-027 (coaching) is due; it can now include replay (FEAT-028). M2 closes now with `pipeline-verify` and a live demo of J1, J8 and J11, signed off by Ken, before M3 starts.
- **Merged:** 001 (skeleton), 002, 003, 004, 005, 009, 011, 012, 013, 014, 015, 016, 017, 022, 023, 024, 025, 027 (merged 2026-10-24 without a verify stage; accepted retrospectively 2026-11-02), 028 (accepted 2026-10-24), 018 (accepted and merged 2026-10-24), 019 (accepted and merged 2026-10-25), 032 (accepted and merged 2026-10-25), 033 (accepted and merged 2026-10-26), 058 (accepted and merged 2026-10-27), 034 (accepted 2026-10-27, merged 2026-10-28 after GitHub CI went green), 057 (accepted 2026-10-28; GOV-08 partial until FEAT-049), 006 (accepted 2026-10-30; AUTH-03 partial: operators FEAT-070, each sensitive action's re-auth with its feature), 054 (accepted 2026-10-30; discount and quote enforcement at dispatch with FEAT-055), 035 (accepted 2026-10-30; ONB-08 instrumented only, pilot median pending), 007 (accepted 2026-10-31; AUTH-02 revocation clause only; Google join not E2E-tested), 008 (accepted 2026-10-31; AUTH-02 still partial: operators FEAT-070), 042 (accepted 2026-10-31), 043 (accepted 2026-10-31; INB-01 complete; assignee = current owner until FEAT-044), 052 (accepted 2026-11-01; LED-04 and DSH-09 email only until FEAT-037/048; NFR-18 live at MD; producers call `notify` from FEAT-044/050/055), 044 (accepted 2026-11-01 after rework R1; INB-05 alerts email only until FEAT-037/048; after-hours lead capture FEAT-049), 045 (accepted 2026-11-02; KB-18 staff-edit producer only, `staff_reply` later; suggestions run in the API, ADR-026 note pending), 046 (accepted 2026-11-03), 049 (accepted 2026-11-04; INB-11 and GOV-08 complete; LED-08 CSV export with FEAT-050; AGT-06 `capture_lead` only), 055 (accepted 2026-11-06; AGT-06 `draft_approval` only, `handoff_channel` FEAT-038; signed link FEAT-056), 056 (accepted 2026-11-06; APR-03 complete), 050 (accepted 2026-11-06; LED-03 and LED-08 complete; LED-05 withdrawn-consent exclusion FEAT-051; LED-04 hot lead email only), 051 (accepted 2026-11-07; LED-05 complete; LED-07 webhook exclusion FEAT-053; GOV-05 deletion routed as an escalation until FEAT-061), 036 (accepted 2026-11-08; CHN-04, CHN-10 complete; CHN-12, NFR-17, NFR-18 email part, live mail checks at MD; the dev tenant's email channel is set up but offline after the E2E spec), 037 (accepted 2026-11-10; CHN-05 live BotFather bot at MD; LED-04 and DSH-09 Telegram part, web push FEAT-048; inline-keyboard consent cards a follow-up), 039 (accepted 2026-11-10; CHN-08 verified phone waits for a phone channel; LED-09 merged-contact duplicates), 038 (accepted 2026-11-11; CHN-07 complete; AGT-06 `handoff_channel`; WhatsApp/Messenger handoff with FEAT-040), 026 (accepted 2026-11-11; AGT-12 partial until the real-model eval scores `judge: memory`), 029 (accepted 2026-11-12; INB-04 page context part; M4 features done). Each has `docs/features/FEAT-NNN-*/`.

## One feature = three fresh sessions

| Stage | Reads | Writes | Ends with |
|---|---|---|---|
| 1. design | this file, the plan row (`grep -n 'FEAT-NNN' docs/03-planning/implementation-plan.md`), cited FR/UC/SCR sections, `docs/build/code-map.md` | `technical-design.md`, `tasks.md`, `ui-design.md`, manifest entries, RTM Design and Plan refs, `handoff.md` | `node scripts/check-rtm.mjs FEAT-NNN` passes; design pushed to the feature branch |
| 2. build (backend, then UI) | this file, the feature's `handoff.md`, `tasks.md`, the design sections for the tasks at hand | code, one commit per task, ticks in `tasks.md`, `handoff.md` | backend: branch pushed, handoff to the UI session; UI: draft PR open |
| 3. verify | this file, `handoff.md`, the design, `tasks.md`, the diff (`git diff origin/main...HEAD`) | `acceptance-report.md`, RTM Test refs (and any missing Design/Plan refs), this file | `node scripts/check-rtm.mjs FEAT-NNN --stage verify` passes; PR ready for review; after merge, the next order posted |

Each stage follows `.claude/skills/feature-stage/SKILL.md`. A stage never reads old conversations: what it needs is in these files. Stages chain on their own: when one ends with nothing pending for Ken, it has the next stage's thread started; only a decision, the merge, or the next feature waits for him.

**Builds split by layer.** When a feature has both backend and UI tasks, the design marks the split in `tasks.md` and the build runs as two fresh sessions: backend (schema, contracts, domain, API, evals) then UI (dashboard or widget, E2E, verify task). Kickoffs say `Build FEAT-NNN (backend)` and `Build FEAT-NNN (UI)`, otherwise as below. A small feature (about six tasks or fewer, little UI) builds in one session. Any build that still runs long stops at a task boundary; the next session resumes from the unticked tasks.

## Kickoff prompts (paste into a new thread)

```
Design FEAT-056. Branch feat/FEAT-056-approval-links (create it from main).
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design.
```
```
Build FEAT-056 (backend) on branch feat/FEAT-056-approval-links.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build.
```
```
Verify FEAT-056 on branch feat/FEAT-056-approval-links.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify.
```

The design session names the branch in its `handoff.md` and final reply; later kickoffs reuse that exact name.

## Ken's rules

- One feature at a time, in the order above. Don't start the next one until Ken says so.
- One PR per feature, from `feat/FEAT-NNN-<slug>`. Squash-merge only with Ken's approval, after the local checks and GitHub CI are green. The PR body starts with the project's attribution block; assign and request review from `codeforests`.
- Locally, run only this feature's tests while building; the verify stage runs the full local checks above. CI runs per the cadence above.
- After a merge, post the remaining build order with the next feature first.
- **RTM is never skipped** (Ken, 2026-11-02): design appends Design and Plan refs, verify appends Test refs; `scripts/check-rtm.mjs` (run by `pnpm lint`) fails on any gap, and the verify stage's `--stage verify` run must pass before the PR is marked ready.
- Owner decisions and later checks go to the project file `/mnt/project-files/pending-actions.md` (feature, when due, what to check), not into chat.

## CI (Ken, 2026-10-28: GitHub CI for every feature)

The repo is public, so GitHub Actions minutes are free. CI (`.github/workflows/ci.yml`) is started by hand (`workflow_dispatch`), not on push; commits keep `[skip ci]`.

- **Every feature:** the verify stage runs the full local checks through `scripts/test-env.sh scripts/check-summary.sh` (with no arguments it runs `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`; add `'pnpm --filter <pkg> test:coverage'` for each package the feature touches), then starts CI on the PR branch (`actions_run_trigger` `run_workflow`, `ci.yml`, ref = the branch), waits for the PR events (no polling), fixes anything red on the branch and re-runs until all jobs are green. The PR body lists both.
- **E2E** runs in CI (Chromium, Firefox, WebKit). The acceptance report records the run number and commit.
- Ken's local WSL run (`/mnt/project-files/guides/run-kakiagent-locally.md`) is only a fallback when GitHub CI is unavailable.
- **Last CI run:** GitHub CI run 132 on FEAT-029 at `96c1a46`, 2026-11-12: all green (attempt 2; the `search-volume.int` 2-char Chinese timing check passed on re-run). Specs that connect a channel must let every delivery finish before disconnecting in `afterEach`: a send rejected afterwards leaves the channel degraded, and its banner breaks later phone-width axe checks. Fixed test dates expire (FEAT-055 `approvals.int` failed from 2026-11-11 10:00): pass `now`. `ConfirmDialog` is `role=alertdialog` in E2E selectors. Start CI once per final head and re-run only failed jobs (Ken, 2026-11-07).

## Token tracking (Ken, 2026-10-24; every feature)

Every stage session appends its token numbers to `/mnt/project-files/reviews/feat-NNN-token-use.md`, with a short comparison to earlier features (the feature-stage skill, "Ending every stage").

**context-mode trial (Ken, 2026-11-01): FEAT-045 only.** Its stage threads run with the context-mode plugin (v1.0.169), which the cloud environment's setup script installs. In those threads, prefer `ctx_batch_execute`/`ctx_execute` for commands with long output and `ctx_search` over re-reading it; Read a file before you Edit it as usual. Each token log adds the `ctx_stats` output and compares with FEAT-052. After FEAT-045, Ken decides whether to keep it; until then other features run without it. **Result:** none of FEAT-045's stage threads had the `ctx_*` tools (the setup-script lines weren't active), so the trial has no data yet; Ken decides whether to retry it on FEAT-046.

## Environment

- No Docker in cloud sessions: run integration tests through `scripts/test-env.sh`, for example `scripts/test-env.sh pnpm --filter @kaki/kb test:integration`. It starts the local Postgres with pgvector and sets `KAKI_TEST_DATABASE_URL`. Shell variables don't persist between calls, so always go through the script.
- Without Docker there's no local stack, so E2E specs and screen renders are checked in the verify stage's GitHub CI run; record that in `tasks.md` notes.
- Run checks through `scripts/check-summary.sh '<cmd>' …` (inside `scripts/test-env.sh` for integration): one PASS/FAIL line per check with test totals, and only the failure lines; the full logs stay on disk for a `grep -n`.
- Typecheck one package while building (`pnpm --filter <pkg> typecheck`); the full `pnpm typecheck` and `pnpm lint` run once, in the last task.
- A fresh cloud session has no `node_modules`: run `pnpm install` once, batched with the first typecheck or test call, before any `pnpm` check.
