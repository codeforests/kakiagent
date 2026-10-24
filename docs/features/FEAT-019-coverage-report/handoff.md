# Handoff: FEAT-019 — Coverage report
Branch: feat/FEAT-019-coverage-report · PR: none · Updated: 2026-10-24 by design
Stage done: design
Next: build (backend, T1–T6) — kickoff: "Build FEAT-019 (backend) on branch feat/FEAT-019-coverage-report. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- No new table: gaps are three columns on the visitor `messages` row; a group of gaps is a `coverage_gap` correction with `proposed_change = {"kind":"answer_gap"}` (no visitor text in it, D3). Coverage and Corrections are two views of the same rows (D1).
- The turn only marks (`markQuestionGap` in `store()`, reusing the retrieval vector); grouping and filing queue items is `kb_gap_cluster()` (SQL, NOLOGIN role, 0029's stale-scan pattern) run by the scheduler every 10 min. Tests call the function directly with crafted 1024-d vectors.
- Distances 0.25 (join a gap item) and 0.35 (a fact covers a topic) are starting values (D5); keep them as named constants in kb and the SQL function.
- Answering a gap = FEAT-018's accept with an `add_faq` edit (required); topics are answered with the existing `POST /api/v1/kb/facts` and then match by `questionKey`.
- Go-live = the tenant's first conversation until FEAT-034 (D4). Topic vectors are memoized per API process (D7); a failing embedder gives `checked: 'question_only'`, never an error.
- Backend stops at `## Build session 2 (UI)` in tasks.md; the UI kickoff is the same prompt with "(UI)".

## Left to CI or later
- E2E (`coverage.e2e.ts`, T9) and screen renders run only in Ken's local CI (no GitHub Actions from FEAT-019 on).

## Pending for Ken
- Nothing blocks the build. Later check (pending-actions.md): tune the two distances on real Cohere embeddings at the M1.5 real-model gate.
