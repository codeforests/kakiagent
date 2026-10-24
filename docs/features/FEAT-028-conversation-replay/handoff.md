# Handoff: FEAT-028 — Replay a past conversation against the current KB
Branch: feat/FEAT-028-conversation-replay · PR: https://github.com/codeforests/kakiagent/pull/27 · Updated: 2026-10-24 by verify
Stage done: verify (accepted; see acceptance-report.md)
Next: Ken reviews and squash-merges PR #27; then design FEAT-018 — kickoff: "Design FEAT-018. Branch feat/FEAT-018-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- FEAT-018 reuses `replayQuestion` (`packages/agent/src/replay.ts`) for its 20-question replay after an accepted correction (D8).
- `factsChanged` compares fact IDs only; an in-place fact edit shows no "Uses different facts" chip. FEAT-018 is a natural place to compare fact versions too (report, minor 1).

## Left to CI or later
- E2E `e2e/tests/replay.e2e.ts`, SCR-APP-031 renders and axe: pending the next CI run (features since CI: 1).
- Conversation-screen entry point: FEAT-042.

## Pending for Ken
- Review and merge PR #27 (local checks green, listed in the PR body).
