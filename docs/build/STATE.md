# Build state

The one file a fresh build session reads first. Keep it under 80 lines. The verify stage updates it in the feature PR, so `main` is always current once a PR merges.

## Where the build is

- **Next feature:** FEAT-050 (M3), design next. FEAT-056 accepted 2026-11-06 (PR #55).
- **M3 order (remaining):** 050 → 051 (plan §5). FEAT-050 owns LED-08's CSV export, lead scoring and the hot-lead alert, and the list that shows pre-live contact-form leads (FEAT-049 D8, D9).
- **Demos:** the interim demo after FEAT-027 (coaching) is due; it can now include replay (FEAT-028). M2 closes now with `pipeline-verify` and a live demo of J1, J8 and J11, signed off by Ken, before M3 starts.
- **Merged:** 001 (skeleton), 002, 003, 004, 005, 009, 011, 012, 013, 014, 015, 016, 017, 022, 023, 024, 025, 027 (merged 2026-10-24 without a verify stage; accepted retrospectively 2026-11-02), 028 (accepted 2026-10-24), 018 (accepted and merged 2026-10-24), 019 (accepted and merged 2026-10-25), 032 (accepted and merged 2026-10-25), 033 (accepted and merged 2026-10-26), 058 (accepted and merged 2026-10-27), 034 (accepted 2026-10-27, merged 2026-10-28 after GitHub CI went green), 057 (accepted 2026-10-28; GOV-08 partial until FEAT-049), 006 (accepted 2026-10-30; AUTH-03 partial: operators FEAT-070, each sensitive action's re-auth with its feature), 054 (accepted 2026-10-30; discount and quote enforcement at dispatch with FEAT-055), 035 (accepted 2026-10-30; ONB-08 instrumented only, pilot median pending), 007 (accepted 2026-10-31; AUTH-02 revocation clause only; Google join not E2E-tested), 008 (accepted 2026-10-31; AUTH-02 still partial: operators FEAT-070), 042 (accepted 2026-10-31), 043 (accepted 2026-10-31; INB-01 complete; assignee = current owner until FEAT-044), 052 (accepted 2026-11-01; LED-04 and DSH-09 email only until FEAT-037/048; NFR-18 live at MD; producers call `notify` from FEAT-044/050/055), 044 (accepted 2026-11-01 after rework R1; INB-05 alerts email only until FEAT-037/048; after-hours lead capture FEAT-049), 045 (accepted 2026-11-02; KB-18 staff-edit producer only, `staff_reply` later; suggestions run in the API, ADR-026 note pending), 046 (accepted 2026-11-03), 049 (accepted 2026-11-04; INB-11 and GOV-08 complete; LED-08 CSV export with FEAT-050; AGT-06 `capture_lead` only), 055 (accepted 2026-11-06; AGT-06 `draft_approval` only, `handoff_channel` FEAT-038; signed link FEAT-056), 056 (accepted 2026-11-06; APR-03 complete). Each has `docs/features/FEAT-NNN-*/`.

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
- **Last CI run:** GitHub CI run 111 on FEAT-056 at `5bc6d48`, 2026-11-06: all green on attempt 2 (attempt 1: Firefox E2E timed out installing browsers). The `widget-controls.e2e` Chromium focus flake was a real race in the widget menu, fixed in `5bc6d48`.

## Token tracking (Ken, 2026-10-24; every feature)

Every stage session appends its token numbers to `/mnt/project-files/reviews/feat-NNN-token-use.md`, with a short comparison to earlier features (the feature-stage skill, "Ending every stage").

**context-mode trial (Ken, 2026-11-01): FEAT-045 only.** Its stage threads run with the context-mode plugin (v1.0.169), which the cloud environment's setup script installs. In those threads, prefer `ctx_batch_execute`/`ctx_execute` for commands with long output and `ctx_search` over re-reading it; Read a file before you Edit it as usual. Each token log adds the `ctx_stats` output and compares with FEAT-052. After FEAT-045, Ken decides whether to keep it; until then other features run without it. **Result:** none of FEAT-045's stage threads had the `ctx_*` tools (the setup-script lines weren't active), so the trial has no data yet; Ken decides whether to retry it on FEAT-046.

## Environment

- No Docker in cloud sessions: run integration tests through `scripts/test-env.sh`, for example `scripts/test-env.sh pnpm --filter @kaki/kb test:integration`. It starts the local Postgres with pgvector and sets `KAKI_TEST_DATABASE_URL`. Shell variables don't persist between calls, so always go through the script.
- Without Docker there's no local stack, so E2E specs and screen renders are checked in the verify stage's GitHub CI run; record that in `tasks.md` notes.
- Run checks through `scripts/check-summary.sh '<cmd>' …` (inside `scripts/test-env.sh` for integration): one PASS/FAIL line per check with test totals, and only the failure lines; the full logs stay on disk for a `grep -n`.
- Typecheck one package while building (`pnpm --filter <pkg> typecheck`); the full `pnpm typecheck` and `pnpm lint` run once, in the last task.
- A fresh cloud session has no `node_modules`: run `pnpm install` once, batched with the first typecheck or test call, before any `pnpm` check.
