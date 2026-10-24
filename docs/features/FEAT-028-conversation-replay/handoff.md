# Handoff: FEAT-028 — Replay a past conversation against the current KB
Branch: feat/FEAT-028-conversation-replay · PR: none · Updated: 2026-10-24 by design
Stage done: design
Next: build — kickoff: "Build FEAT-028 on branch feat/FEAT-028-conversation-replay. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- D1 (runtime) went to Ken as a decision card, recommending the api, one question per request (ADR-027, proposed). If Ken chose the agent-worker job instead, stop and send the feature back to design: §5.3, T4 and T5 change. Check the thread or ask before T4.
- A replay is a coaching session (origin `replay`) whose content is `coaching_messages` of kind `replay`, keyed by `replay_of` (the original visitor message). No new table. Visitor text is never copied; GET reads it from `messages`.
- Replay dispatches with `stubAll(visitorRegistry)` and in-memory ports, so crisis/abuse/out-of-scope decisions match live with no writes. Triage uses the visitor `TRIAGE_SYSTEM`, not the coaching one; history is the original conversation (D3).
- `answerStep` in `coach.ts` gets refactored to take a dispatch result (T3); FEAT-027's coach tests must stay green.
- `replayQuestion` is the core FEAT-018 will reuse; keep it independent of `replayNext`'s "lowest pending" logic.

## Left to CI or later
- E2E (`replay.e2e.ts`) and screen renders: CI only, pending until the next CI run.
- Conversation-screen entry point: FEAT-042.

## Pending for Ken
- D1 decision card (api vs agent-worker). ADR-027 becomes Accepted with it.
