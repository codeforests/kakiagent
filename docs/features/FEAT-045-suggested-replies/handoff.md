# Handoff: FEAT-045 — AI-suggested replies for staff (verified)
Branch: feat/FEAT-045-suggested-replies · PR: none · Updated: 2026-11-02 by build (backend)
Stage done: build (T1–T4 of 8)
Next: build (UI, T5–T8) — kickoff: "Build FEAT-045 (UI) on branch feat/FEAT-045-suggested-replies.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- **The dashboard doesn't typecheck yet**: `ProposedChange` gained `reply_edit`, so the exhaustive switches in `apps/dashboard/src/lib/coach.ts` (~129, ~175, ~196) and `lib/corrections.ts` (~66, ~135) need the case (T6). Everything else typechecks.
- Contracts (`packages/contracts/src/index.ts`, section "suggested replies" at the end): `Suggestion`, `SuggestionNone` (`no_checked_answer` | `unavailable`), `SuggestionResponse` (exactly one of `suggestion`/`none`), `SuggestionRequest` (`{}`); `StaffMessageBody.suggestionId?`; `CorrectionItem.replyEdit?: { question }`; `CorrectionContext.replyEdit: { question, suggested, sent, suggestedAt, sentAt, facts: FactChip[] } | null` (null = the chat was deleted). `FactChip` moved above the corrections section (same shape).
- Routes (`apps/api/src/inbox.ts`): `POST /api/v1/conversations/:id/suggestion` (body `{}`) → 201 `SuggestionResponse`; 409 `not_owner` (with `conversation` summary, as FEAT-043), 409 `ai_paused`, 409 `nothing_to_answer`, 429 `too_many_suggestions` with `Retry-After` (seconds), 404 other tenant. `POST …/messages` takes `suggestionId`; an unedited send returns the message with the draft's `factIds`, an edited one with `[]` and adds the correction.
- Error messages from the API: ai_paused "The assistant is paused, so it can't suggest replies."; nothing_to_answer "There's no customer message to answer yet."; 429 "Too many suggestions for this conversation. Try again later."
- Correction items: `source: 'staff_edit'`, `proposedBy: 'staff'`, `change: { kind: 'reply_edit', suggestionId }`, `facts` = the draft's facts. Accept needs `edit: { kind: 'add_faq', question, answer }` (bare accept → 422 like `answer_gap`); close is the usual dismiss.
- "Edited" (D8) is server-side (`normalise` in inbox): case, spacing, trailing punctuation and emoji don't count. The client's `isStale` compares `forSeq` with the latest visitor message's seq.
- Evals: `evals/cases/feat-045-suggest.json` runs in existing subsets (prices, boundary, harmful, chinese); README notes how outcomes map. `pnpm eval --fast` passes, thresholds unchanged.
- Deviation: history for the draft leaves out `system` rows (staff joined/left notices), as design §5.1 says; the visitor turn itself doesn't filter them.
- Migration 0046 also grants `app_dashboard` `UPDATE (fact_ids) ON messages` with a restrictive policy to staff rows (copying an unedited draft's facts onto the sent message, §5.2).

## Left to CI or later
- `apps/api/test/uploads.int.test.ts` (S3 presigner) needs LocalStack or `KAKI_TEST_S3_ENDPOINT`, which this session lacks; the rest of the api suite (360 tests) passes. Unrelated to this feature.
- E2E (`suggested-reply.e2e.ts`) and screen renders run in the verify stage's GitHub CI (no Docker here).
- No context-mode plugin in this session either (no `ctx_*` tools), so the trial comparison has no plugin data from the backend build.

## Pending for Ken
- Nothing.
