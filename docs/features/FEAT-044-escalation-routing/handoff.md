# Handoff: FEAT-044 — Escalation routing, "talk to a person", reminders
Branch: feat/FEAT-044-escalation-routing · PR: none · Updated: 2026-11-01 by build (backend)
Stage done: build (T1–T5 of 9)
Next: build (UI, T6–T9) — kickoff: "Build FEAT-044 (UI) on branch feat/FEAT-044-escalation-routing.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes: `POST /widget/v1/conversations/:id/escalate` → `EscalateResponse` (`escalated` | `already_escalated` | `with_person`; `notice` is the stored `Message`, null on a repeat or `with_person`). A closed chat is 409 `chat_ended` (the existing `ConversationClosedError` mapping, not `closed` as design §3 says); not this visitor's is 404. `GET`/`PUT /api/v1/settings/escalation` → `EscalationRouting`; PUT errors 403, 422 `invalid_routing` with `fields` (`personUserId: 'person_required'`, else `invalid`), 422 `person_not_member`.
- Contracts: `ConversationSummary.escalation: OpenEscalation | null` (required key; fixtures need `escalation: null`), `ThreadEvent.reason 'escalated'` with `subject.name` the assignee and `source`, `Message.noticeKind 'escalated'`, `EscalationSource`, `EscalationMode`, `EscalationRoutingBody`, `TurnQueueJob` gains `EscalationReminderJob`. `WidgetConfigResponse.controls.talkToPerson` is now `channel.live && !aiPaused`.
- Thread dividers: one `escalated` divider per escalation (from `escalation.assigned`); the plain `ai → escalated` state change is filtered out so it doesn't repeat.
- Words path: an escalate-only turn stores the notice as its reply (system message, body '', `noticeKind: 'escalated'`, in reply to the visitor's message, with the disclosure). With an answer task the notice is a separate system message (`TurnResult.escalationNotice`), published before the reply. So the widget can derive "pending" from `noticeKind === 'escalated'` on either path.
- Realtime summaries from the agent-worker carry the escalation but can't name the assignee (visitor zone): name is "A team member". In `applySummary`/realtime patching, keep the cached assignee name when the incoming assignee `userId` matches. API-published summaries (widget routes, inbox routes) are named.
- Escalated conversations keep being answered (D9); auto-close skips them (D5); every move out of `escalated` resolves the escalation and cancels pending/held alerts inside `transition`.
- Disclosure core and `unsure` texts changed (AC-8); FEAT-022/023/024 test and eval expectations were updated to the new texts, including `e2e/tests/assistant.e2e.ts` (two "…Our team reads every chat." strings). The eval case `multi-talk-to-person` (feat-004) lost its `expectRoute` (escalate-only turns call no reply model) and checks outcome `escalated`.
- New deps: `@kaki/inbox` → `@kaki/tenancy`, `@kaki/agent-worker` → `@kaki/tenancy` (dependency-cruiser clean).

## Left to CI or later
- `apps/api` `uploads.int.test.ts` and `@kaki/platform` `rate-limit.int.test.ts` need LocalStack/Valkey containers (no Docker here); everything else in api, agent, inbox, db, platform passed through `scripts/test-env.sh`.
- E2E (`escalation.e2e.ts`, T8) and the changed `assistant.e2e.ts` run in the verify stage's GitHub CI.
- The abuse rule (`endAiConversation`) still ends only `ai` chats, so repeated abuse in an escalated chat warns but doesn't end it; unchanged here, worth a note for verify.

## Pending for Ken
- None blocking.
