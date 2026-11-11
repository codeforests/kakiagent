# Handoff: FEAT-026 — Conversation memory and summarisation
Branch: feat/FEAT-026-conversation-memory · PR: https://github.com/codeforests/kakiagent/pull/65 · Updated: 2026-11-11 by verify
Stage done: verify (accepted)
Next: Ken's review and squash-merge; then Design FEAT-029 — kickoff: "Design FEAT-029. Branch feat/FEAT-029-<slug> (create it from main).
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Report: acceptance-report.md (AC-1–10 pass; 3 tests added for AC-2 gate-closed, AC-3 concurrent fold, D5 cap).
- History now comes from `loadConversationHistory` (memory + up to 30 messages after it); new features that read history should use it, not `recentMessages`.

## Left to CI or later
- `judge: memory` scores only on the real-model eval run (AGT-12 partial).

## Pending for Ken
- Follow-up (low): the fold reads only the newest 200 unfolded messages (`FOLD_READ_LIMIT`), so a backlog past 200 loses the oldest. Optional: staff-facing memory view (D7). Both in pending actions.
