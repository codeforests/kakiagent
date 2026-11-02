# Handoff: FEAT-045 — AI-suggested replies for staff (verified)
Branch: feat/FEAT-045-suggested-replies · PR: https://github.com/codeforests/kakiagent/pull/50 (draft) · Updated: 2026-11-02 by build (UI)
Stage done: build (T1–T8 of 8), status `developer-done`
Next: verify — kickoff: "Verify FEAT-045 on branch feat/FEAT-045-suggested-replies.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Dashboard: suggestion state lives in `useDockActions` (`lib/takeover.ts`: `suggest`, `takeOverAndSuggest`, `suggestion`, `suggestPaused`, `suggestBlocked`, `dismissSuggestNotice`) so it survives the bar → composer switch; pure rules in `lib/suggestion.ts` (`noneText`, `isStale`, `latestVisitorSeq`, `sendBody`, `needsReplaceConfirm`, `suggestFailure`). The UI is `TakeoverBar` and `Composer` in `pages/takeover-dock.tsx`; `ThreadDock` takes `latestVisitorSeq` from `conversation.tsx`.
- `lib/api.ts` `send` now copies a `Retry-After` header into `ApiError.details.retryAfterS` (any response); the 429 alert's minutes come from it.
- Paused: the suggest buttons are disabled with the helper when `useAiStatus().data.status.paused` or after a 409 `ai_paused`.
- Corrections: `isStaffEdit` and the `reply_edit` texts in `lib/corrections.ts` (decision "FAQ added", accepted line as gaps); the item's "What changed" is `WhatChanged` in `pages/correction.tsx`; `AddFaqDialog` takes an optional `answer` prefill. With `context.replyEdit` null the item shows "The chat this came from was deleted." and only Close with no change.
- Stubbed-API Playwright checks for T5 and T6 are in `tasks.md` evidence (bar → draft, focus, Send posts `suggestionId`, none and 429 alerts, replace confirm, phone icon button 50×44, the item and row texts, prefilled FAQ, no sideways scroll at 375).

## Left to CI or later
- E2E `e2e/tests/suggested-reply.e2e.ts` (and all screen renders) has not run: no Docker here. Risks to watch in CI: the fake provider's draft for a run-unique product price (the spec expects `12.00` in the draft); the FAQ accept with a price in the answer.
- `apps/api/test/uploads.int.test.ts` needs LocalStack or `KAKI_TEST_S3_ENDPOINT` (unrelated to this feature).
- No context-mode plugin in this session (no `ctx_*` tools), so no trial data from the UI build either.

## Pending for Ken
- Nothing.
