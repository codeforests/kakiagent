# Handoff: FEAT-057 — Kill switch: pause and resume the AI on all channels
Branch: feat/FEAT-057-kill-switch · PR: https://github.com/codeforests/kakiagent/pull/37 · Updated: 2026-10-28 by verify
Stage done: verify (accepted)
Next: merge on Ken's go-ahead, then FEAT-006 design — kickoff: "Design FEAT-006. Branch feat/FEAT-006-<slug> (create it from main).
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Acceptance report: `acceptance-report.md`. RTM Test ref appended for GOV-08 (partial).
- FEAT-042/043 own the staff-reply half of UC-31 step 3: when staff sending lands, add a case that a staff reply reaches the visitor while the AI is paused.
- FEAT-049 owns lead capture on the paused notice (D6).

## Left to CI or later
- E2E `kill-switch.e2e.ts` and axe: GitHub CI on this branch (result in the report's CI section).

## Pending for Ken
- Merge approval.
