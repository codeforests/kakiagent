# Handoff: FEAT-019 — Coverage report
Branch: feat/FEAT-019-coverage-report · PR: https://github.com/codeforests/kakiagent/pull/29 · Updated: 2026-10-24 by verify
Stage done: verify (accepted; E2E and renders pending Ken's local CI)
Next: merge on Ken's go-ahead; then the next feature — kickoff: "Design FEAT-032. Branch feat/FEAT-032-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Acceptance report: `acceptance-report.md`. One test correction (`1f211c0`, AC-4 refused turn). RTM Test ref appended for KB-09 and KB-18 (partial).
- Minor findings, not blocking: `GAP_OUTCOMES` sits under `runVisitorTurn`'s doc comment in `turn.ts`; topic vectors are metered to the first tenant that triggers them.

## Left to CI or later
- `e2e/tests/coverage.e2e.ts`, screen renders and axe (AC-10): Ken's next local CI. Not due for FEAT-019 (1 feature since the last run); FEAT-032 touches the widget, so it is due there.
- `apps/api/test/uploads.int.test.ts` needs a container runtime (LocalStack); not run here.

## Pending for Ken
- Approve and squash-merge PR #29.
- Later: the erasure feature must delete gap messages or clear `gap_embedding` (pending-actions). Tune the 0.25/0.35 distances at M1.5 (already listed).
