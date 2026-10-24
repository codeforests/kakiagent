# Handoff: FEAT-018 — Correction queue, stale-fact scan and old-versus-new replay
Branch: feat/FEAT-018-correction-queue · PR: https://github.com/codeforests/kakiagent/pull/28 · Updated: 2026-10-24 by verify
Stage done: verify (accepted), status accepted
Next: merge (Ken), after a green CI run; then FEAT-019 design only when Ken says go — kickoff: "Design FEAT-019. Branch feat/FEAT-019-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Report: `acceptance-report.md`. One test correction (`33a1561`, inbox tests for `pastQuestionsUsing`/`messagesUpTo`, coverage back over 70%).
- FEAT-019 (coverage gaps) appends `source_type` `coverage_gap` items through `proposeCorrection` and renders in SCR-APP-021/022 with no change there; UC-16 3b ("add a new FAQ") is its own.

## Left to CI or later
- CI is required (lockfile changed). Run 40078002590 got no runners on any job, twice (Actions minutes or billing). E2E pending: `corrections.e2e.ts`, `review.e2e.ts`, FEAT-028's `replay.e2e.ts`.

## Pending for Ken
- Unblock Actions or run CI locally, then merge approval.
- FEAT-027 flake in `apps/api/test/coach.int.test.ts:270` (UUID can match `/58/`): proposed fix in the report; in pending-actions.
