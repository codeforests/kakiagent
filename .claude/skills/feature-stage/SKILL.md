---
name: feature-stage
description: Run one stage (design, build or verify) of one KakiAgent feature in a fresh session, from compact files only, then hand off and stop. Use for "Design FEAT-N", "Build FEAT-N" (backend or UI), "Verify FEAT-N".
---

# One stage of one feature

A fresh session runs exactly one stage, writes everything the next stage needs to files on the feature branch, and stops. Never read old threads or conversations; if something is missing from the files, ask Ken rather than searching history.

## Inputs, always

1. `docs/build/STATE.md` (order, rules, environment).
2. The feature branch named in the kickoff. Design creates it from `main`; build and verify `git fetch origin <branch> && git checkout <branch>`. The kickoff naming it is Ken's permission to push there.
3. `docs/features/FEAT-NNN-<slug>/handoff.md` (build and verify).

## Token rules

Every call re-reads the whole context, and the session's starting prompt alone is about 85k, so the number of calls and the size of the context both cost.

- Read by section: `grep -n` then `sed -n 'A,Bp'`. Never read a file over ~300 lines whole. `docs/build/code-map.md` says where things live, and its "Agent pipeline" section stands in for reading `turn.ts`, `dispatch.ts` and `coach.ts`.
- Batch: several reads in one shell call; and per task, edit → typecheck → test → commit in one shell call where it can be.
- Copy the format from the pattern in `code-map.md` and the newest feature's documents read by heading only (`grep -n '^## '`) plus at most one short section each, not by loading the sdlc-kit design skills or reading whole documents.
- Never read a previous feature's `tasks.md` evidence or its whole `ui-design.md` or `acceptance-report.md` as a format: the headings and one entry show the shape (FEAT-019: ~18k spent this way in design, ~6k in verify).
- Inside big files, jump to the anchors in `code-map.md` ("Big files by anchor") and read ~40–80 lines from there, not the whole function or file.
- Write integration tests from the helpers named in `code-map.md` (Tests); read a neighbouring test file's setup and one case, not the whole file.
- Diff against the remote: `git fetch origin main` then `git diff origin/main...HEAD`. Local `main` is stale in a fresh clone (FEAT-019 verify got a 166-file diff that way).
- `docs/02-design/design.md` is long: index it (`grep -n '^#\|^\*\*`' docs/02-design/design.md`) and read only the components the screen uses.
- Typecheck and test one package at a time while working; full `pnpm lint` and `pnpm typecheck` once, in the final task.
- Integration tests always through `scripts/test-env.sh` (no Docker in cloud sessions).
- Keep replies to Ken short; details go in the files.

## Stage: design

1. Don't load the `agentic-sdlc-kit` design skills: the document pattern in `code-map.md` and the newest feature's documents (by section) give the format. Load `detailed-design` or `ui-design` only for a kind of document no earlier feature has.
2. Inputs: the plan row, the cited FR/UC/SCR/NFR blocks, the ADRs it names, and the code the feature extends (via `code-map.md`). If the feature builds on the previous one, read that feature's design by section rather than surveying the code again.
3. Write `technical-design.md`, `tasks.md` (status `designed`), `ui-design.md` and the manifest entries. In `tasks.md`, order backend tasks before UI tasks and mark the split with a `## Build session 2 (UI)` heading before the first UI task, unless the feature is small enough for one build session (STATE.md).
4. Open questions that change the design go to Ken with a decision card before finishing; record answers as D-n.
5. If the feature changes the agent pipeline, the dashboard's patterns or the layers, update `code-map.md` in the same commit.
6. Write `handoff.md`, commit, push. Reply with the build kickoff (the backend one when the build is split).

## Stage: build

1. The rules here and in `AGENTS.md` are enough; load `agentic-sdlc-kit:feature-implementation` only if they leave something unclear.
2. Inputs: `handoff.md`, `tasks.md`, and the design sections for the task at hand (`technical-design.md`; `ui-design.md` only in the UI session). Start at the first unticked task.
3. Per task: implement, run its "Done when", tick it, one commit. At most 3 fix attempts, then stop honestly with a note.
4. A backend session stops at the `## Build session 2 (UI)` heading: update `handoff.md` (what the UI session needs: routes, contract names, fakes), push, and reply with the UI kickoff. Any session that has done about six tasks or feels long stops at a task boundary the same way and replies with the kickoff that resumes it.
5. After the last task: status `developer-done`, push, open a **draft** PR (title `FEAT-NNN: <name>`, body starts with the project's attribution block; assign `codeforests`). Don't start CI; the verify stage decides (STATE.md, CI cadence). Reply with the verify kickoff.

## Stage: verify

1. Load `agentic-sdlc-kit:acceptance-verification`. This session is the independent verifier: it didn't write the code.
2. Inputs: `handoff.md`, the design's §6, `tasks.md` evidence, `git diff origin/main...HEAD`. For the report format, read only the previous report's headings and its per-AC table.
3. Re-run this feature's tests fresh, then the full local checks (STATE.md, CI cadence). Start CI only when the cadence calls for it, and read its E2E results. Review the test diff and the invariants in `AGENTS.md`.
4. Write `acceptance-report.md`; on acceptance, append the RTM Test ref and set `tasks.md` status `accepted`.
5. Update `docs/build/STATE.md` in the same PR: move the feature to Merged, set the next feature and the remaining order, and the features-since-CI count.
6. Put the local check results in the PR body, mark it ready, subscribe to it, and drive any CI run to green. Reply once with the PR link. Ken approves; squash-merge only with his go-ahead.
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

1. Push the branch and update the thread checklist.
2. **Token use** (Ken, 2026-10-24: FEAT-028, 018, 019, 032 and 033, then stop): append a section for this session to `/mnt/project-files/reviews/feat-NNN-token-use.md` (create it if missing; re-read it just before writing, other sessions write there too). Same shape as `feat-027-build-token-use.md`: new context (token budget at start minus at end), model and tool calls, cached re-reads (roughly calls × average context), output, where the new context went, a comparison table with the earlier stages, and what would save more. Keep it under 40 lines.
3. **Chain the next stage** (Ken, 2026-10-24): design → build (backend → UI) → verify run one after another, each in its own fresh thread, without waiting for Ken. If nothing is pending for Ken, ask the coordinator with `message_coordinator` to start the next stage's thread with exactly the kickoff prompt from `handoff.md`, then reply to Ken in two lines: the result, and that the next stage has started. If a decision is pending (an open decision card, a question in "Pending for Ken" that blocks the next stage, a blocked task, or a rework/design-defect verdict that needs his call), don't chain: reply with the ask and the kickoff, and chain once he answers.
4. The chain stops at the verify stage's ready PR: merging and starting the next feature still need Ken's go-ahead (STATE.md, Ken's rules).
5. Resolve the thread (the verify thread stays open until the PR merges).
