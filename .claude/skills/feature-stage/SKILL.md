---
name: feature-stage
description: Run one stage (design, build or verify) of one KakiAgent feature in a fresh session, from compact files only, then hand off and stop. Use for "Design FEAT-N", "Build FEAT-N", "Verify FEAT-N".
---

# One stage of one feature

A fresh session runs exactly one stage, writes everything the next stage needs to files on the feature branch, and stops. Never read old threads or conversations; if something is missing from the files, ask Ken rather than searching history.

## Inputs, always

1. `docs/build/STATE.md` (order, rules, environment).
2. The feature branch named in the kickoff. Design creates it from `main`; build and verify `git fetch origin <branch> && git checkout <branch>`. The kickoff naming it is Ken's permission to push there.
3. `docs/features/FEAT-NNN-<slug>/handoff.md` (build and verify).

## Token rules

- Read by section: `grep -n` then `sed -n 'A,Bp'`. Never read a file over ~300 lines whole. `docs/build/code-map.md` says where things live.
- Copy the format from the pattern in `code-map.md`, not by reading a previous feature's documents in full.
- Typecheck and test one package at a time while working; full `pnpm lint` and `pnpm typecheck` once, in the final task.
- Integration tests always through `scripts/test-env.sh` (no Docker in cloud sessions).
- Keep replies to Ken short; details go in the files.

## Stage: design

1. Load the `agentic-sdlc-kit:detailed-design` skill, then `agentic-sdlc-kit:ui-design` (per-feature mode). The rules above narrow how much they read.
2. Inputs: the plan row, the cited FR/UC/SCR/NFR blocks, the ADRs it names, and the code the feature extends (via `code-map.md`).
3. Write `technical-design.md`, `tasks.md` (status `designed`), `ui-design.md` and the manifest entries.
4. Open questions that change the design go to Ken with a decision card before finishing; record answers as D-n.
5. Write `handoff.md`, commit, push. Reply with the build kickoff.

## Stage: build

1. Load `agentic-sdlc-kit:feature-implementation`.
2. Inputs: `handoff.md`, `technical-design.md`, `tasks.md`, `ui-design.md` (sections for the task at hand). Start at the first unticked task.
3. Per task: implement, run its "Done when", tick it, one commit. At most 3 fix attempts, then stop honestly with a note.
4. If the session has done about six tasks or feels long, stop at a task boundary: update `handoff.md`, push, and reply with the same build kickoff so a fresh session resumes.
5. After the last task: status `developer-done`, push, open a **draft** PR (title `FEAT-NNN: <name>`, body starts with the project's attribution block; assign and request review from `codeforests`) so CI runs the full suite. Reply with the verify kickoff.

## Stage: verify

1. Load `agentic-sdlc-kit:acceptance-verification`. This session is the independent verifier: it didn't write the code.
2. Inputs: `handoff.md`, the design's §6, `tasks.md` evidence, `git diff main...HEAD`, and the draft PR's CI results.
3. Re-run this feature's tests fresh; read CI for E2E and the rest of the suite. Review the test diff and the invariants in `AGENTS.md`.
4. Write `acceptance-report.md`; on acceptance, append the RTM Test ref and set `tasks.md` status `accepted`.
5. Update `docs/build/STATE.md` in the same PR: move the feature to Merged, set the next feature, and the remaining order.
6. Mark the PR ready, subscribe to it, and drive CI to green. Reply once with the PR link. Ken approves; squash-merge only with his go-ahead.
7. After the merge, post the remaining build order with the next feature first, and the design kickoff for it.
8. Rework goes back to a build session (kickoff in `handoff.md`); a design defect goes to a design session.

## handoff.md (each stage overwrites it; keep it under 40 lines)

```
# Handoff: FEAT-NNN — <name>
Branch: feat/FEAT-NNN-<slug> · PR: <link or none> · Updated: <date> by <stage>
Stage done: design | build (T1–Tn of N) | verify (<verdict>)
Next: <stage> — kickoff: "<exact prompt>"

## What the next stage needs
- <the few facts not obvious from the design: decisions taken, deviations, gotchas>

## Left to CI or later
- <E2E, renders, anything not run here, and why>

## Pending for Ken
- <questions or checks; also added to /mnt/project-files/pending-actions.md>
```

## Ending every stage

Push the branch, update the thread checklist, reply to Ken with the result and the next kickoff prompt, then resolve the thread (the verify thread stays open until the PR merges).
