# Handoff: FEAT-026 — Conversation memory and summarisation
Branch: feat/FEAT-026-conversation-memory · PR: (draft, see thread) · Updated: 2026-11-11 by build
Stage done: build (T1–T6 of 6), status developer-done
Next: verify — kickoff: "Verify FEAT-026 on branch feat/FEAT-026-conversation-memory.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Tests: `packages/agent/src/memory.test.ts` (unit: foldPlan, cleanMemory, parseMemory, memoryLines, fake summariser), `compose.test.ts` "conversation memory" block, `packages/agent/test/memory.int.test.ts` (AC-1–4, 7, 10), `packages/db/test/rls.int.test.ts` "conversation memory (FEAT-026)" (AC-9), evals `feat-026-memory.json` + `rt-mem-*` in `feat-025-red-team.json` (AC-6, 8).
- Deviations from the design (all recorded in code-map.md "Memory"):
  - Unique index `(tenant_id, conversation_id, upto_seq)` only; no second desc index (a backward scan serves "latest").
  - `foldPlan(rows)` takes no `uptoSeq`.
  - Triage gets the memory through `triageTail(rules, memory)` (no new `triage` input).
  - `asData` moved to `agent/src/data.ts` (re-exported from `prompt.ts`) to avoid a memory ↔ prompt cycle.
  - Lag log lives in agent-worker (`TurnResult.unfolded`), since `runVisitorTurn` has no logger.
  - `lead-check` now exports `EMAIL_IN_TEXT`, `SG_PHONE_IN_TEXT` (unanchored) for `cleanMemory`.
  - Extra eval expectation `memory-excludes` (text not in the stored memory) beside `remembers`.
  - `buildVisitorPrompt` no longer slices; `compose.test.ts`'s "last 10 messages" case now asserts the history is sent as loaded (design §5.4), and the safety test's rule-text string was updated to the new data rule.
  - Coaching slices its history to `HISTORY_LIMIT` in `coach.ts` (it used to rely on the prompt's slice).
- `version.json` not bumped (no earlier feature bumped it for new cases; agreement sample still covers ≥10% of judge expectations).

## Left to CI or later
- No E2E (no screen changes). `judge: memory` scores only with the real-model eval run.

## Pending for Ken
- None blocking. Possible follow-up (design D7): show the memory to staff in the thread sidebar.
