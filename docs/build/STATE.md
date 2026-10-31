# Build state

The one file a fresh build session reads first. Keep it under 80 lines. The verify stage updates it in the feature PR, so `main` is always current once a PR merges.

## Where the build is

- **Next feature:** FEAT-043 (M3), design, only after Ken says go. FEAT-042 accepted 2026-10-31 (PR #44).
- **M3 order (remaining):** 043 → 052 → 044 → 045 → 046 → 049 → 055 → 056 → 050 → 051 (plan §5).
- **Demos:** the interim demo after FEAT-027 (coaching) is due; it can now include replay (FEAT-028). M2 closes now with `pipeline-verify` and a live demo of J1, J8 and J11, signed off by Ken, before M3 starts.
- **Merged:** 001 (skeleton), 002, 003, 004, 005, 009, 011, 012, 013, 014, 015, 016, 017, 022, 023, 024, 025, 027 (merged 2026-10-24 on Ken's local CI without a verify stage: its acceptance report and RTM Test ref are still to write), 028 (accepted 2026-10-24), 018 (accepted and merged 2026-10-24), 019 (accepted and merged 2026-10-25), 032 (accepted and merged 2026-10-25), 033 (accepted and merged 2026-10-26), 058 (accepted and merged 2026-10-27), 034 (accepted 2026-10-27, merged 2026-10-28 after GitHub CI went green), 057 (accepted 2026-10-28; GOV-08 partial until FEAT-049), 006 (accepted 2026-10-30; AUTH-03 partial: operators FEAT-070, each sensitive action's re-auth with its feature), 054 (accepted 2026-10-30; discount and quote enforcement at dispatch with FEAT-055), 035 (accepted 2026-10-30; ONB-08 instrumented only, pilot median pending), 007 (accepted 2026-10-31; AUTH-02 revocation clause only; Google join not E2E-tested), 008 (accepted 2026-10-31; AUTH-02 still partial: operators FEAT-070), 042 (accepted 2026-10-31; INB-01 assignee filter with FEAT-043). Each has `docs/features/FEAT-NNN-*/`.

## One feature = three fresh sessions

| Stage | Reads | Writes | Ends with |
|---|---|---|---|
| 1. design | this file, the plan row (`grep -n 'FEAT-NNN' docs/03-planning/implementation-plan.md`), cited FR/UC/SCR sections, `docs/build/code-map.md` | `technical-design.md`, `tasks.md`, `ui-design.md`, manifest entries, `handoff.md` | design pushed to the feature branch |
| 2. build (backend, then UI) | this file, the feature's `handoff.md`, `tasks.md`, the design sections for the tasks at hand | code, one commit per task, ticks in `tasks.md`, `handoff.md` | backend: branch pushed, handoff to the UI session; UI: draft PR open |
| 3. verify | this file, `handoff.md`, the design, `tasks.md`, the diff (`git diff origin/main...HEAD`) | `acceptance-report.md`, RTM Test ref, this file | PR ready for review; after merge, the next order posted |

Each stage follows `.claude/skills/feature-stage/SKILL.md`. A stage never reads old conversations: what it needs is in these files. Stages chain on their own: when one ends with nothing pending for Ken, it has the next stage's thread started; only a decision, the merge, or the next feature waits for him.

**Builds split by layer.** When a feature has both backend and UI tasks, the design marks the split in `tasks.md` and the build runs as two fresh sessions: backend (schema, contracts, domain, API, evals) then UI (dashboard or widget, E2E, verify task). Kickoffs say `Build FEAT-NNN (backend)` and `Build FEAT-NNN (UI)`, otherwise as below. A small feature (about six tasks or fewer, little UI) builds in one session. Any build that still runs long stops at a task boundary; the next session resumes from the unticked tasks.

## Kickoff prompts (paste into a new thread)

```
Design FEAT-043. Branch feat/FEAT-043-<slug> (create it from main).
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design.
```
```
Build FEAT-043 (backend) on branch feat/FEAT-043-<slug>.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build.
```
```
Verify FEAT-043 on branch feat/FEAT-043-<slug>.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify.
```

The design session names the branch in its `handoff.md` and final reply; later kickoffs reuse that exact name.

## Ken's rules

- One feature at a time, in the order above. Don't start the next one until Ken says so.
- One PR per feature, from `feat/FEAT-NNN-<slug>`. Squash-merge only with Ken's approval, after the local checks and GitHub CI are green. The PR body starts with the project's attribution block; assign and request review from `codeforests`.
- Locally, run only this feature's tests while building; the verify stage runs the full local checks above. CI runs per the cadence above.
- After a merge, post the remaining build order with the next feature first.
- Owner decisions and later checks go to the project file `/mnt/project-files/pending-actions.md` (feature, when due, what to check), not into chat.

## CI (Ken, 2026-10-28: GitHub CI for every feature)

The repo is public, so GitHub Actions minutes are free. CI (`.github/workflows/ci.yml`) is started by hand (`workflow_dispatch`), not on push; commits keep `[skip ci]`.

- **Every feature:** the verify stage runs the full local checks through `scripts/test-env.sh` (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `test:coverage` for each package the feature touches), then starts CI on the PR branch (`actions_run_trigger` `run_workflow`, `ci.yml`, ref = the branch), waits for the PR events (no polling), fixes anything red on the branch and re-runs until all jobs are green. The PR body lists both.
- **E2E** runs in CI (Chromium, Firefox, WebKit). The acceptance report records the run number and commit.
- Ken's local WSL run (`/mnt/project-files/guides/run-kakiagent-locally.md`) is only a fallback when GitHub CI is unavailable.
- **Last CI run:** GitHub CI run 89 on FEAT-042 at `9c20589`, 2026-10-31, green.

## Token tracking (Ken, 2026-10-24; every feature)

Every stage session appends its token numbers to `/mnt/project-files/reviews/feat-NNN-token-use.md`, with a short comparison to earlier features (the feature-stage skill, "Ending every stage").

## Environment

- No Docker in cloud sessions: run integration tests through `scripts/test-env.sh`, for example `scripts/test-env.sh pnpm --filter @kaki/kb test:integration`. It starts the local Postgres with pgvector and sets `KAKI_TEST_DATABASE_URL`. Shell variables don't persist between calls, so always go through the script.
- Without Docker there's no local stack, so E2E specs and screen renders are checked in the verify stage's GitHub CI run; record that in `tasks.md` notes.
- Typecheck one package while building (`pnpm --filter <pkg> typecheck`); the full `pnpm typecheck` and `pnpm lint` run once, in the last task.
- A fresh cloud session has no `node_modules`: run `pnpm install` once, batched with the first typecheck or test call, before any `pnpm` check.
