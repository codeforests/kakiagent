# Handoff: FEAT-019 — Coverage report
Branch: feat/FEAT-019-coverage-report · PR: https://github.com/codeforests/kakiagent/pull/29 (draft) · Updated: 2026-10-24 by build (UI)
Stage done: build (T1–T10 of 10), status developer-done
Next: verify — kickoff: "Verify FEAT-019 on branch feat/FEAT-019-coverage-report. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI files: `pages/coverage.tsx` (SCR-APP-029), `lib/coverage.ts` (+ test), `pages/faq-dialog.tsx` (the shared "Add an FAQ" dialog), Knowledge "Coverage" tab with a warning count pill (`knowledge-tabs.tsx`), route `/knowledge/coverage`, `CoverageSummary` card in `pages/review.tsx` (SCR-APP-008), gap items in `pages/corrections.tsx` and `pages/correction.tsx` through `itemSummary`, `gapMeta`, `closedLine`, `isGap` in `lib/corrections.ts`. Industry names moved to `lib/industry.ts` (lint: pages export only components).
- Small choices inside the design (tasks.md notes): topic counts leave skipped topics out ("{covered} of {applying}"); an accepted gap reads as its FAQ ("New FAQ: …", chip "FAQ added"); a gap closed by the job reads "Closed automatically: the chats it came from were deleted."; live with no gaps but missing topics shows "No unanswered customer questions right now."
- `useCorrectionsChanged` now also invalidates `['coverage']`, so a decision in either view refreshes the other.
- E2E `e2e/tests/coverage.e2e.ts`: pre-live half on the second tenant (set to F&B for the spec, restored in `finally`); the gap half marks the visitor message with a random vector if the fake turn didn't, then runs `kb_gap_cluster()` as the owner (see the T9 note for why).

## Left to CI or later
- E2E (`coverage.e2e.ts`) and screen renders run only in Ken's local CI. This is the first feature since the last CI run (FEAT-018); it doesn't touch the widget, `infra/`, `.github/` or the lockfile.
- `apps/api/test/uploads.int.test.ts` (S3 presigner) can't run in cloud sessions (no S3 endpoint); it fails the same on the base commit.

## Pending for Ken
- Nothing blocks verify. Later check (pending-actions.md, from design): tune the two distances (0.25, 0.35) on real Cohere embeddings at the M1.5 real-model gate.
