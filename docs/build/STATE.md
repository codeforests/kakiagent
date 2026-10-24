# Build state

The one file a fresh build session reads first. Keep it under 80 lines. The verify stage updates it in the feature PR, so `main` is always current once a PR merges.

## Where the build is

- **Next feature:** FEAT-027 (coaching mode). Stage: not started.
- **M2 order from here:** 027 → 028 → 018 → 019 → 032 → 033 → 058 → 034 → 057 → 006 → 054 → 035. After M2, follow plan §5 (`grep -n '^| \*\*M3' docs/03-planning/implementation-plan.md`).
- **Demos:** an interim demo after FEAT-027 (coaching). M2 closes after FEAT-035 with `pipeline-verify` and a live demo of J1, J8 and J11, signed off by Ken.
- **Merged:** 001 (skeleton), 002, 003, 004, 005, 009, 011, 012, 013, 014, 015, 016, 017, 022, 023, 024, 025. Each has `docs/features/FEAT-NNN-*/`.

## One feature = three fresh sessions

| Stage | Reads | Writes | Ends with |
|---|---|---|---|
| 1. design | this file, the plan row (`grep -n 'FEAT-NNN' docs/03-planning/implementation-plan.md`), cited FR/UC/SCR sections, `docs/build/code-map.md` | `technical-design.md`, `tasks.md`, `ui-design.md`, manifest entries, `handoff.md` | design pushed to the feature branch |
| 2. build (backend, then UI) | this file, the feature's `handoff.md`, `tasks.md`, the design sections for the tasks at hand | code, one commit per task, ticks in `tasks.md`, `handoff.md` | backend: branch pushed, handoff to the UI session; UI: draft PR open |
| 3. verify | this file, `handoff.md`, the design, `tasks.md`, the diff (`git diff main...`) | `acceptance-report.md`, RTM Test ref, this file | PR ready for review; after merge, the next order posted |

Each stage follows `.claude/skills/feature-stage/SKILL.md`. A stage never reads old conversations: what it needs is in these files.

**Builds split by layer.** When a feature has both backend and UI tasks, the design marks the split in `tasks.md` and the build runs as two fresh sessions: backend (schema, contracts, domain, API, evals) then UI (dashboard or widget, E2E, verify task). Kickoffs say `Build FEAT-NNN (backend)` and `Build FEAT-NNN (UI)`, otherwise as below. A small feature (about six tasks or fewer, little UI) builds in one session. Any build that still runs long stops at a task boundary; the next session resumes from the unticked tasks.

## Kickoff prompts (paste into a new thread)

```
Design FEAT-027. Branch feat/FEAT-027-<slug> (create it from main).
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design.
```
```
Build FEAT-027 on branch feat/FEAT-027-<slug>.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build.
```
```
Verify FEAT-027 on branch feat/FEAT-027-<slug>.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify.
```

The design session names the branch in its `handoff.md` and final reply; later kickoffs reuse that exact name.

## Ken's rules

- One feature at a time, in the order above. Don't start the next one until Ken says so.
- One PR per feature, from `feat/FEAT-NNN-<slug>`. Squash-merge only with Ken's approval, after the local checks (and CI when the cadence calls for it) are green. The PR body starts with the project's attribution block; assign and request review from `codeforests`.
- Locally, run only this feature's tests while building; the verify stage runs the full local checks above. CI runs per the cadence above.
- After a merge, post the remaining build order with the next feature first.
- Owner decisions and later checks go to the project file `/mnt/project-files/pending-actions.md` (feature, when due, what to check), not into chat.

## CI cadence (Ken, 2026-10-24)

CI no longer runs on every push or PR; it is started by hand (`workflow_dispatch`) to stay inside the monthly Actions minutes.

- **Every feature:** the verify stage runs the full local checks through `scripts/test-env.sh` (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `test:coverage` for each package the feature touches) and lists the results in the PR body. Ken merges on those.
- **Run CI** on the PR's branch before merging when: it's the third feature since the last CI run, a milestone closes, or the feature touches the widget (size budget), `infra/`, `.github/` or the lockfile. Start it with the GitHub tool `actions_run_trigger` (`run_workflow`, `ci.yml`, the branch as `ref`).
- **E2E** runs only in CI. Between runs, specs and screen renders are "pending CI" in the acceptance report; a red E2E in the next CI run is fixed before that PR merges.
- **Features since the last CI run:** 0 (counted from FEAT-027). The verify stage updates this line; reset it to 0 after a CI run.

## Environment

- No Docker in cloud sessions: run integration tests through `scripts/test-env.sh`, for example `scripts/test-env.sh pnpm --filter @kaki/kb test:integration`. It starts the local Postgres with pgvector and sets `KAKI_TEST_DATABASE_URL`. Shell variables don't persist between calls, so always go through the script.
- Without Docker there's no local stack, so E2E specs and screen renders are checked in CI's E2E job; record that in `tasks.md` notes.
- Typecheck one package while building (`pnpm --filter <pkg> typecheck`); the full `pnpm typecheck` and `pnpm lint` run once, in the last task.
