# Handoff: FEAT-028 — Replay a past conversation against the current KB
Branch: feat/FEAT-028-conversation-replay · PR: https://github.com/codeforests/kakiagent/pull/27 (draft) · Updated: 2026-10-24 by build (UI)
Stage done: build (T1–T8 of 8), status developer-done
Next: verify — kickoff: "Verify FEAT-028 on branch feat/FEAT-028-conversation-replay. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `apps/dashboard/src/lib/replay.ts` (helpers and `driveReplay`, unit-tested in `lib/replay.test.ts`), `pages/replay.tsx` (`ReplayPickPage` at `/coach/replay`, `ReplayPage` at `/coach/replay/:id`), routes in `router.tsx`, "Replay a conversation" link in the Coach page head, CSS at the end of `app.css` (`answer-compare`, `replay-*`, `chip--accent`).
- The quick coach panel is now `CoachPanelButton` (label, prefill, narrow-screen href) in `quick-coach-panel.tsx`; `AskCoachButton` wraps it unchanged. `askHref()` added to `lib/coach.ts`.
- The comparison page auto-drives `…/next` only when opened right after starting (router state `start`); reopened with pending turns it shows "Continue replay".
- Deviations from ui-design: the Coach page-head link stays visible at every width (no overflow-menu component exists yet); the candidate row says "Replayed before · View" (the contract has no replay time); a 429 disables Continue for 60 s.
- Design gap, not blocking: `factsChanged` compares fact IDs, so editing a fact's price in place gives the new price but no "Uses different facts" chip. The E2E therefore replaces the fact (delete, then create). Recorded in pending-actions for Ken.
- Local results are in `tasks.md` § Verification evidence. `uploads.int` (S3 presigner) is red here only for want of a container runtime.

## Left to CI or later
- E2E `e2e/tests/replay.e2e.ts` and screen renders/axe: CI only, pending. The feature touches no widget, infra, `.github/` or lockfile; features since the last CI run is 0, so the cadence doesn't call for CI on this PR.
- Conversation-screen entry point: FEAT-042.

## Pending for Ken
- None blocking (the `factsChanged` gap is noted in pending-actions.md).
