# Handoff: FEAT-026 — Conversation memory and summarisation
Branch: feat/FEAT-026-conversation-memory · PR: none · Updated: 2026-11-11 by design
Stage done: design
Next: build (one session, no UI) — kickoff: "Build FEAT-026 on branch feat/FEAT-026-conversation-memory.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- History is now "latest memory row + every message after its `upto_seq`" (max 30), loaded by one function (`loadConversationHistory`) for turns, suggestions and replay. `buildVisitorPrompt` must stop slicing to `HISTORY_LIMIT`; coaching keeps `HISTORY_LIMIT`.
- The fold runs in agent-worker on `conversation-turns` with its **own** group `memory:<id>` (D4), enqueued in `store()`'s transaction; jobs are idempotent no-ops when nothing is due.
- `logical model 'summarise'` and usage purpose already exist in llm-gateway: no gateway change.
- Rule text in the cached system prompt changes once (`<memory>` added to the data rule, one new line): existing prompt tests that snapshot the rules need updating, not weakening.
- Agent reads messages only through inbox: add `messagesBetween` there beside `recentMessages`.
- `cleanMemory` reuses `piiMask` (`@kaki/platform`) and the `@kaki/contracts/lead-check` email/phone patterns; if lead-check doesn't export regexes, export them rather than copying.
- Eval subset `memory` is new (threshold 0.9); `remembers` works on the fake; `judge: memory` stays pending on the fake.

## Left to CI or later
- No E2E (no screen changes). Real-model `judge: memory` score with the real-model eval run.

## Pending for Ken
- None blocking. Possible follow-up (not planned): show the memory to staff in the thread sidebar (design D7).
