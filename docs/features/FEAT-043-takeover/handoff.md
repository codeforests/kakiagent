# Handoff: FEAT-043 — Take over and hand back, single owner
Branch: feat/FEAT-043-takeover · PR: none · Updated: 2026-10-31 by build (backend)
Stage done: build (T1–T5 of 11)
Next: build (UI, T6–T11) — kickoff: "Build FEAT-043 (UI) on branch feat/FEAT-043-takeover. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- **Dashboard and widget don't typecheck yet**: the contracts gained required fields. Fix first: `Message.authorName`, `ThreadMessage.authorUserId`, `ConversationSummary.owner`, `ThreadEvent.subject`, `Me.canReassign`. Known spots: dashboard `src/lib/inbox.ts:131` (`appendMessage` builds a `ThreadMessage` from a `Message`: add `authorUserId: null`), `src/lib/inbox.test.ts` fixtures; widget `src/preview.ts`, `src/chat.test.ts`, `src/api.test.ts` fixtures.
- Routes (all `apps/api/src/inbox.ts`; bodies in contracts' takeover section): `POST /api/v1/conversations/:id/takeover` `{ version, from? }` → `TakeoverResult`; `/handback` `{ version }` → `TakeoverResult`; `POST /api/v1/conversations/:id/messages` `{ body, clientMessageId }` → 201/200 `StaffMessageResponse` (422 `validation` on an empty body); `/handover-request` → 202 `{}`; `GET /api/v1/inbox/members` → `InboxMembers`; list takes `assignee=me|none|<uuid>`.
- Error codes: 409 `owned` (`OwnedError`, with `owner`), `already_owner`, `closed`, `state_changed` (with `conversation`), `not_owner` (with `conversation`), `not_owned`; 403 for `from` without `inbox.reassign`. Close by a non-owner of an owned conversation is 409 `owned`.
- Realtime: take-over, hand-back and staff messages publish `message` on `channels.conversation` and `channels.inbox`, then `conversation`. `/ws` now also sends `MemberEvent`s (`handover_requested`, `taken_from_you`) to that member only; parse them with `MemberEvent` alongside `RealtimeEvent`. The inbox `message` event carries a `Message` (no `authorUserId`): "You" comes from comparing `authorName`/thread refetch, or refetch the thread on staff messages.
- Notices: `author 'system'`, `body ''`, text in `notice`, `noticeKind` `staff_joined`/`staff_left`, `authorName` the snapshot (null → widget says "A team member"/"团队成员"; server text already has it). The list row preview of a notice is its notice text.
- Owner names: staff-facing `owner.name` = display name, else email local part (`memberNames`); visitor-facing `authorName` = display name only (D3).
- The test database seeds owners only (`packages/db/src/testing.ts` strips `members`); the dev seed adds `agent@kaki-bakery.test` "Mei Ling" (agent) for the E2E.

## Left to CI or later
- E2E `takeover.e2e.ts` and screen renders run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken
- None.
