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
| 2. build | this file, the feature's `handoff.md`, `technical-design.md`, `tasks.md`, `ui-design.md` | code, one commit per task, ticks in `tasks.md`, `handoff.md` | branch pushed, draft PR open so CI runs |
| 3. verify | this file, `handoff.md`, the design, `tasks.md`, the diff (`git diff main...`) | `acceptance-report.md`, RTM Test ref, this file | PR ready for review; after merge, the next order posted |

Each stage follows `.claude/skills/feature-stage/SKILL.md`. A stage never reads old conversations: what it needs is in these files. A build that runs long may stop at a task boundary; the next build session resumes from the unticked tasks.

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
- One PR per feature, from `feat/FEAT-NNN-<slug>`. Squash-merge only after CI is green and Ken approves. The PR body starts with the project's attribution block; assign and request review from `codeforests`.
- Locally, run only this feature's tests (the packages it touches). CI runs the full suite, including E2E on three browsers.
- After a merge, post the remaining build order with the next feature first.
- Owner decisions and later checks go to the project file `/mnt/project-files/pending-actions.md` (feature, when due, what to check), not into chat.

## Environment

- No Docker in cloud sessions: run integration tests through `scripts/test-env.sh`, for example `scripts/test-env.sh pnpm --filter @kaki/kb test:integration`. It starts the local Postgres with pgvector and sets `KAKI_TEST_DATABASE_URL`. Shell variables don't persist between calls, so always go through the script.
- Without Docker there's no local stack, so E2E specs and screen renders are checked in CI's E2E job; record that in `tasks.md` notes.
- Typecheck one package while building (`pnpm --filter <pkg> typecheck`); the full `pnpm typecheck` and `pnpm lint` run once, in the last task.
