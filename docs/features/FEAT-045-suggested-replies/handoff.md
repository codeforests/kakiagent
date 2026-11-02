# Handoff: FEAT-045 — AI-suggested replies for staff (verified)
Branch: feat/FEAT-045-suggested-replies · PR: none · Updated: 2026-11-02 by design
Stage done: design
Next: build (backend, T1–T4) — kickoff: "Build FEAT-045 (backend) on branch feat/FEAT-045-suggested-replies.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Suggestions run synchronously in the API (D1), copying replay's path: read `replay.ts` `prepareQuestion(` and `replayQuestion` (lines ~269–466) and `coach.ts` `answerStep` (~260–345); don't read `turn.ts`.
- `answerStep` must take `meta` from its caller (D2); coach and replay pass what they pass today.
- Dispatch with `replayRegistry` + `ReplayPorts(0)` from `replay-dispatch.ts`: a suggestion never has side effects.
- Only the `answered` outcome gives a draft; everything else is `none` (`no_checked_answer` | `unavailable`, design §5.1 step 4).
- `reply_edit` follows `answer_gap` everywhere in kb (`editedChange`, `acceptCorrection`, `applyChange`) and in `apps/api/src/corrections.ts` `contextOf`; `apps/api/src/coach.ts` and `apps/dashboard/src/lib/coach.ts` have exhaustive switches on `ProposedChange.kind` that need the new case.
- `sent_message_id`'s FK uses `on delete set null (sent_message_id)` (composite FK; PG 15+ column list) so `tenant_id` isn't nulled.
- Edit detection is `normalise` in inbox (D8); compare against `piiMask(suggestion.body)`.
- Build split: backend T1–T4, then UI T5–T8 under `## Build session 2 (UI)`.

## Left to CI or later
- E2E (`suggested-reply.e2e.ts`) and screen renders run in the verify stage's GitHub CI (no Docker here).
- The context-mode plugin wasn't installed in this design session (no `ctx_*` tools); the trial comparison starts from the build sessions if the setup script provides it.

## Pending for Ken
- Nothing blocking. Decisions taken in the design (D1 sync API like replay, D5 10 suggestions/conversation/hour, D8 what counts as an edit, D9 no suggestions while paused, D10 Suggest from the bar takes over first) are in technical-design §7; noted in pending-actions.md for a glance.
