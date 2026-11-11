# Handoff: FEAT-038 — Continue on another channel with the history
Branch: feat/FEAT-038-channel-handoff · PR: none · Updated: 2026-11-11 by build (backend, part 1)
Stage done: build (T1–T6 of 12)
Next: build (backend, part 2: T7–T8) — kickoff: "Build FEAT-038 (backend) on branch feat/FEAT-038-channel-handoff.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- T7: `handoffChannelHandler` can call `handoffOptions(tx, tenantId)` from `@kaki/channels/handoff` (live check + bot username) through `ConversationPort.handoffOptions()`; the card is `{ kind: 'handoff', telegram, email }` (contracts `MessageCard`, `messages_card_ck` already allows it).
- T8: `handoff_links_purge()` returns the count; `app_outbox` (the scheduler's zone) may execute it; `HANDOFF_PURGE_MS` is already in the scheduler config and `.env.example` (unused until T8).
- Deviations from the design (all in code-map.md):
  - No `GRANT UPDATE (channel)` to the visitor zone (it broke FEAT-025's "visitor can't change channel" guard): the move goes through definer `conversation_move_channel()` (widget → telegram/email only, compare-and-set).
  - No new outbox topic/SQS queue: the email job is `{ kind: 'handoff_email', tenantId, linkId }` on `conversation-turns` (`HandoffEmailJob` in `TurnQueueJob`), like the other worker jobs.
  - There is no widget "messages read" and the SSE stream drops `conversation` events for visitors, so `movedTo` is carried by the stored `handoff_moved` notice's card `{ kind: 'moved', channel, url, sentTo }` (live via SSE, and on resume via replay) and by 409 `{ error: 'moved', channel }` on `…/messages` and `…/handoff`.
  - `confirmEmailHandoff` cases are in `apps/api/test/handoff.int.test.ts` (it needs the inbox port, which channels tests can't import); `sendHandoffEmail` cases are in `packages/channels/test/handoff.int.test.ts`.
  - `ThreadEvent` gained kind `moved` with `channel` (inbox `threadEvents` maps `conversation.moved`): T10 only renders it.
- For the UI session (T9): the widget must not render `handoff_recap` notices (they reach the SSE stream and replay too) and should render `handoff_moved` as the moved state from its card. Errors: `HandoffError` `{ error, message, channel? }`; 400 only for a malformed body, 422 `invalid_email`.

## Left to CI or later
- E2E (`handoff.e2e.ts`, T11) and axe run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken
- None.
