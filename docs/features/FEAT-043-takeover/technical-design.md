# Technical design: FEAT-043 — Take over and hand back, single owner

> Implements: INB-02 (staff pause the AI in a conversation, reply directly and hand back; the AI sends nothing while a person has it; the visitor sees "staff joined"), INB-09 (one owner at a time; two simultaneous take-overs give exactly one winner, the other told who has it; others see the owner and can request it), INB-01 (p: the assignee filter FEAT-042 left, by current owner; FEAT-044 adds escalation assignees) · Realizes: UC-23 steps 3 and 5 (take over, staff reply, hand back) and exception 3a · Screens: SCR-APP-015 (p: takeover bar, composer, owned-by-someone-else bar, takeover dividers), SCR-APP-014 (p: assignee filter, owner on rows), SCR-WGT-002 (p: staff joined and left notices, staff messages with the name) · Module: `inbox` (ownership), `agent` (gate), architecture §5.2
> Status: designed · 2026-10-31

## 1. Intent

A team member reading a conversation can take it over. From that moment the assistant is silent in it (the send gate is closed before every turn and between released segments, ADR-013 d3), the visitor sees "Mei Ling joined the chat", and the team member replies from a composer in the thread; the visitor sees those replies, labelled with the name, in the widget. When done they hand it back: the visitor sees that the assistant is back, and the AI answers the next message. Exactly one person owns a taken-over conversation: the database decides a simultaneous race (ADR-013 d2), the loser is told who won, and anyone else sees who has it and can ask for it. The inbox list shows each conversation's owner and can be filtered by it.

## 2. Codebase context

- **Lifecycle** (`packages/inbox/src/lifecycle.ts`, FEAT-042): `TRANSITIONS` already has `ai | escalated | waiting_approval → human` and `human → ai | closed`; `transition(tx, { …, to, actor, expectedVersion? })` locks the row, compare-and-sets `version`, writes one audit entry (`conversation.state_changed` for these edges, payload `{ from, to, reason }`). Closes happen through `closeByStaff`, `autoCloseIdle` (agent-worker, visitor zone), `endVisitorConversation` (api widget route, visitor zone) and `endAiConversation`. FEAT-042 §8 asks FEAT-043 to delete the owner row inside `transition` on close.
- **Gate** (`packages/agent/src/gate.ts` `aiAllowed`): closed for `human` and `closed` (reason `not_ai`); its comment marks where the owner row plugs in. The streaming loop re-checks it per segment (code-map, Agent pipeline).
- **Messages**: `author` is already `visitor | agent | staff | system`; `NOTICE_KINDS = ['after_hours', 'chat_ended']` with a check on `(notice is null) = (notice_kind is null)`. The widget renders `.msg.staff` on `--kaki-info-bg` already (`panel.css.ts`) but no name; `rowsOf` (`apps/widget/src/chat.ts`) gives disclosure, notice and bubble rows; `awaitingTurn` drives the typing indicator; `chromeLocale` follows the latest agent or system message's `language`.
- **Delivery**: the widget reads messages over SSE (`apps/realtime/src/app.ts`, `/widget/v1/conversations/:id/stream`: subscribe to `channels.conversation(t, id)`, replay `messagesSince`). A stored staff message published there reaches the visitor; a dropped stream replays it. The dashboard gets `message` and `conversation` events on `channels.inbox(t)` through `/ws`; `/ws` also subscribes `channels.member(t, user)` but only to close the socket on `session_ended`.
- **API** (`apps/api/src/inbox.ts` `registerInboxRoutes`): list, thread, older page, close. Actor names come from identity `memberNames` (display name, else email local part) through the identity zone (FEAT-042 D7). FEAT-008 §8: the visitor-facing name must be snapshotted at takeover through the identity zone, not read cross-zone later.
- **Grants**: `app_dashboard` SELECT on `conversations`, `messages`; UPDATE `(status, version, closed_at, close_reason)` on `conversations`; `app_agent_visitor` UPDATE `(last_message_at, status, version, closed_at, close_reason, flagged_at, flag_reasons, abuse_turns)`. FEAT-042's db suite asserts `app_dashboard` can't update `last_message_at` (changed here, D5).
- **Identity**: capabilities `inbox.read`, `inbox.reply` for every role (`capabilities.ts`).
- **Design**: design.md §4.6 `composer` (takeover bar, "Mei Ling is handling this" [Request]), `message-bubble` (staff on the right, info-soft, author label); anchor-screens SCR-APP-015 states ai-handling, human-mine, human-other; SCR-WGT-002 human; ux-foundations F3 and the J4 seam "Visitor sees: Mei Ling joined".

## 3. API contracts (`packages/contracts/src/index.ts`)

**Changed** (top of the file):
- `Message` gains `authorName: z.string().nullable()` (the visitor-facing staff name snapshot on staff messages and staff notices; null otherwise or when the member has no display name, D3). `noticeKind` widens to `['after_hours', 'chat_ended', 'staff_joined', 'staff_left']`.
- `ConversationSummary` gains `owner: z.object({ userId: z.uuid(), name: z.string() }).nullable()` (the staff-facing name from `memberNames`).
- `ConversationListQuery` gains `assignee: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional()` (INB-01, filters on the current owner, D7).
- `ThreadMessage` gains `authorUserId: z.uuid().nullable()` (dashboard only: "You" on your own messages).
- `ThreadEvent.reason` widens with `'taken_over' | 'handed_back' | 'taken_from' | 'handover_requested'`; `ThreadEvent.to` becomes nullable (a request isn't a state change); `actor` unchanged, plus `subject: { name: string | null } | null` (whom a request or a take-from was about).

**New section** `// ---- Dashboard API: takeover (INB-02, INB-09; FEAT-043 §3)`:
- `TakeOverBody = z.object({ version: z.number().int().min(0), from: z.uuid().optional() }).strict()` (`from` = take it from that owner, owners and admins only, D1).
- `StaffMessageBody = z.object({ body: z.string().trim().min(1).max(4000), clientMessageId: z.string().min(8).max(64) }).strict()`.
- `HandBackBody = z.object({ version: z.number().int().min(0) }).strict()`.
- `TakeoverResult = { conversation: ConversationSummary, notice: Message }` (the visitor-facing notice it stored, so the dashboard can show "Visitor sees: …").
- `OwnedError = ErrorBody.extend({ error: z.literal('owned'), owner: { userId, name } })`.
- `InboxMember = { userId: z.uuid(), name: z.string() }`; `InboxMembers = { members: InboxMember[] }` (the assignee filter's options).
- `MemberEvent = z.discriminatedUnion('type', [ { type: 'handover_requested', conversationId, by: { userId, name } }, { type: 'taken_from_you', conversationId, by: { userId, name } } ])`: published on `channels.member(t, owner)`, forwarded only to that member's sockets (§5.4).

**Routes** (`apps/api/src/inbox.ts`; capability, then the tenant only from the session):

| Method, path | Capability | Success | Errors |
|---|---|---|---|
| `POST /api/v1/conversations/:id/takeover` | `inbox.reply` (+ `inbox.reassign` when `from` is given) | 200 `TakeoverResult`; publishes `conversation` on `channels.inbox`, the notice on `channels.conversation` and `channels.inbox`; with `from`, `taken_from_you` to the old owner | 404; 409 `owned` (someone else has it, or `from` no longer owns it); 409 `already_owner`; 409 `closed`; 409 `state_changed` with `{ conversation }`; 403 `forbidden` (`from` without `inbox.reassign`) |
| `POST /api/v1/conversations/:id/handback` | `inbox.reply` | 200 `TakeoverResult` (the staff-left notice); publishes as above | 404; 409 `not_owner`; 409 `state_changed` |
| `POST /api/v1/conversations/:id/messages` | `inbox.reply` | 201 `{ message: ThreadMessage }` (a retry with the same `clientMessageId` returns the stored one, 200); publishes `message` on both channels | 404; 409 `not_owner` (with `{ conversation }`); 422 validation |
| `POST /api/v1/conversations/:id/handover-request` | `inbox.reply` | 202 `{}`; audits, publishes `handover_requested` to the owner and a `conversation` event | 404; 409 `not_owned` (nobody has it; take it over instead); 409 `already_owner` |
| `GET /api/v1/inbox/members` | `inbox.read` | 200 `InboxMembers` (active members of the tenant, sorted by name) | — |
| `GET /api/v1/conversations?…&assignee=` | `inbox.read` | as FEAT-042, filtered (D7) | 400 validation |

The close route (FEAT-042) gains 409 `owned` when someone else owns the conversation (D6).

## 4. Schema changes (migration `0043_takeover.sql`; Drizzle DDL, then hand-written RLS, grants and checks in the same file)

- **New table `conversation_owners`** (ADR-013 d2): `tenant_id uuid not null`, `conversation_id uuid not null`, `user_id uuid not null`, `visitor_name text` (the display-name snapshot shown to the visitor; null → "A team member", D3), `since timestamptz not null default now()`; PK `(tenant_id, conversation_id)`; FK `(tenant_id, conversation_id) → conversations`; index `(tenant_id, user_id)` (assignee filter). Forced RLS with the standard tenant policy, name in `TENANT_SCOPED_TABLES`, a case in `packages/db/test/rls.int.test.ts`.
- Grants: `app_dashboard` SELECT, INSERT, DELETE, UPDATE `(user_id, visitor_name, since)` on `conversation_owners`; `app_agent_visitor` SELECT, DELETE (closes from the visitor zone delete the row, §5.1; the gate reads it).
- **`messages`**: `author_user_id uuid` and `author_name text`, check `messages_staff_author_ck`: `author_user_id is null or author in ('staff', 'system')`. `NOTICE_KINDS` gains `staff_joined`, `staff_left`; the notice check is rewritten with the four kinds.
- Grants for staff messages: `app_dashboard` INSERT on `messages` and UPDATE `(last_message_at)` on `conversations` (D5). The existing `tenant_isolation` policy on `messages` (0001) is `FOR ALL` to every role, so a **restrictive** policy narrows the dashboard: `create policy messages_dashboard_authors on messages as restrictive for insert to app_dashboard with check (author in ('staff', 'system'))`. The db suite asserts `app_dashboard` can insert a staff row and is refused a visitor or agent row.

## 5. Component design

### 5.1 Ownership (`packages/inbox/src/ownership.ts`, exported from the index)

- `takeOver(tx, { tenantId, conversationId, userId, visitorName, version, from? })`: the race is decided by the owner row (ADR-013 d2): `insert into conversation_owners … on conflict do nothing returning *`. No row → read the current owner and throw `OwnedError(owner)` (or `AlreadyOwnerError` when it is `userId`). Then `transition(… to 'human', actor user, expectedVersion: version)` (a closed conversation throws `IllegalTransitionError` → API 409 `closed`; the insert rolls back with it). With `from`: `update conversation_owners set user_id, visitor_name, since = now() where … and user_id = from returning` (zero rows → `OwnedError` with whoever has it), no state change (already `human`), and one audit entry `conversation.owner_changed` `{ from: 'human', to: 'human', reason: 'taken_from' }` with `subject_refs` the previous owner's user ID (no names, ADR-014). Then the notice (below). Returns `{ conversation, notice, previousOwner? }`.
- Concurrency: two `takeOver`s at once both reach the insert; the second blocks on the PK until the first commits and then inserts nothing, so it gets `OwnedError` naming the winner (INB-09). The integration test runs them on two clients with `Promise.all`.
- `handBack(tx, { tenantId, conversationId, userId, version })`: `delete … where user_id = $userId returning`; zero rows → `NotOwnerError`; then `transition(… to 'ai', expectedVersion)`; then the `staff_left` notice.
- `requestHandover(tx, { tenantId, conversationId, userId })`: owner row required (`NotOwnedError`), not the caller (`AlreadyOwnerError`); audit `conversation.handover_requested` (actor the requester, subject the owner's ID); returns the owner's user ID. No row of its own: the audit entry is the record and the thread divider.
- `sendStaffMessage(tx, { tenantId, conversationId, userId, body, clientMessageId })`: owner row must be `userId` (`for share` lock on it; else `NotOwnerError`); `piiMask(body)` (ADR-015: masked at the edge, staff text too); an existing row with the same `clientMessageId` is returned as is; otherwise insert `author 'staff'`, `author_user_id`, `author_name = visitor_name`, then `last_message_at = now()`. No audit entry (messages aren't audit events, as for visitor messages).
- **Notices** (`staffNotice(tx, { …, kind, name, userId })`): one `system` message, `body ''`, `notice` rendered in the conversation's language (the `language` of its latest agent or system message, else `en`), `notice_kind` `staff_joined`/`staff_left`, `author_user_id`, `author_name`, `language` set so the widget's locale holds. Texts (D4): `staff_joined` en "{name} joined the chat." zh "{name}已加入对话。"; `staff_left` en "{name} left the chat. The assistant will keep helping you." zh "{name}已离开对话，AI 助手会继续为您服务。"; `{name}` = the snapshot, else "A team member" / "团队成员".
- **`transition` change** (`lifecycle.ts`): when the new state is `closed`, or `ai` from `human`, it deletes the conversation's owner row in the same transaction (FEAT-042 §8), so every close path (staff, auto-close, visitor end, abuse) and a hand-back leave no owner. `handBack` deletes first and checks the caller, so `transition`'s delete then finds nothing.
- `ownerOf(tx, tenantId, conversationId)` → `{ userId, visitorName, since } | null`; `ownersOf(tx, tenantId, ids)` for list pages.
- `LIFECYCLE_ACTIONS` gains `conversation.owner_changed` and `conversation.handover_requested` so `threadEvents` returns them; `threadEvents` maps `conversation.state_changed` with `to 'human'` to reason `taken_over`, `human → ai` to `handed_back`, the two new actions to `taken_from`/`handover_requested`, with `subject` from `subject_refs` (the API names it, D7 of FEAT-042).
- **Integration cases** (`packages/inbox/test/ownership.int.test.ts`): take over from `ai`, `escalated`, `waiting_approval` (→ `human`, one row, one `state_changed` audit with `{ from, to }`, a `staff_joined` notice in the conversation's language with the snapshot or "A team member"); two concurrent take-overs → exactly one owner, the other `OwnedError` naming the winner; taking over a closed conversation refused and leaves no row; stale version refused; `from` moves ownership and audits `owner_changed` with no name in the payload, a stale `from` refused; hand back by the owner (→ `ai`, row gone, `staff_left` notice), by someone else refused; staff message by the owner stored masked (an NRIC in the body stored masked), idempotent on `clientMessageId`, `last_message_at` moved, by a non-owner refused; each close path (`closeByStaff`, `autoCloseIdle`, `endVisitorConversation`, `endAiConversation`) deletes the owner row; `requestHandover` audits with IDs only; tenant B can't read, take over or write tenant A's conversation.

### 5.2 Gate (`packages/agent/src/gate.ts`)

`aiAllowed` checks the owner row after the status: `ownerOf(tx, …)` not null → `{ open: false, reason: 'not_ai' }` (ADR-013 d3 "no human owner"; the status check stays, so either one closes it). `statusOpen` is unchanged. Because the segment loop re-checks the gate before releasing each segment, a reply mid-stream when someone takes over stops at the next segment boundary and the turn stores nothing further (existing behaviour for the kill switch). Unit test: an owner row with an `ai` status (forced in a test transaction) still closes the gate. Agent integration: a visitor message to a taken-over conversation gets no reply and no model call; after hand-back the next message is answered.

### 5.3 Views (`packages/inbox/src/views.ts`)

- `listConversations` takes `assignee: { kind: 'user', userId } | { kind: 'none' }` (`me` resolves to the session's user in the API): `exists`/`not exists` on `conversation_owners`, keyset paging unchanged; each summary carries `ownerUserId` from a left join. Counts are unchanged (views don't depend on the assignee).
- `toSummary` gains `owner` (the API fills `name` from `memberNames`, one identity call per page).
- `getThread` returns `authorUserId` and `authorName` on messages.

### 5.4 API, realtime, identity

- `apps/api/src/inbox.ts`: the four POST routes and `GET /api/v1/inbox/members`. Take-over resolves the visitor-facing snapshot first: identity `displayNameOf(idTx, userId)` (new, `names.ts`: the display name only, never the email, D3) inside the identity zone's `withTenant`, then one dashboard-zone transaction runs `takeOver`. Error mapping: `OwnedError` → 409 `owned` with `{ owner: { userId, name } }` (name from `memberNames`), `AlreadyOwnerError` → 409 `already_owner`, `IllegalTransitionError` from closed → 409 `closed`, `StateChangedError` → 409 `state_changed` with the summary, `NotOwnerError` → 409 `not_owner` with the summary, `NotOwnedError` → 409 `not_owned`. After commit: publish the summary on `channels.inbox`, the notice or staff message on `channels.conversation(t, id)` and `channels.inbox(t)`, and member events on `channels.member(t, owner)`. Close maps a non-owner's close of an owned conversation to 409 `owned` (D6). The list route passes `assignee`.
- `capabilities.ts`: new `inbox.reassign` for `owner` and `admin` (D1). `Me` gains `canReassign: boolean` (as `canApprove`), so the dashboard shows the take-from action only to them.
- Identity: `displayNameOf(tx, userId)` and `inboxMembers(tx)` (active members of the tenant with names, `memberNames`' rule) in `names.ts`.
- `apps/realtime/src/app.ts` `/ws`: the `channels.member` handler forwards `MemberEvent`s to that socket (parsed with the contract) and still closes on `session_ended`.
- Integration suite `apps/api/test/takeover.int.test.ts`: each route's success and error codes; two parallel take-overs → one 200, one 409 `owned` naming the winner (INB-09); the widget stream receives the notice and the staff message (read through `messagesSince`, since SSE itself is covered by realtime's tests); a visitor message during takeover gets no AI reply (turn job run inline as in the FEAT-042 suite); `from` refused for the `agent` role (403) and allowed for `admin`; `assignee=me|none|<id>` filters; members route lists names; a session owing two-step refused; cross-tenant 404 on every new route.

### 5.5 Dashboard (detail in ui-design.md)

- `lib/api.ts`: `takeOver(id, version, from?)`, `handBack(id, version)`, `sendStaffMessage(id, body, clientMessageId)`, `requestHandover(id)`, `inboxMembers()`.
- `lib/inbox.ts`: `dockMode(summary, me)` → `'ai' | 'mine' | 'other' | 'closed'`; assignee ↔ URL (`?assignee=me|none|<id>`), `matchesView` honours the assignee (the owner on the summary); `takeoverErrorText(code, owner)`; `ownerText`. `appendMessage` already dedupes by `seq`.
- `lib/realtime.ts`: member events → a toast with an action (`handover_requested`: "Ken asks you to hand over …" [Open conversation]; `taken_from_you`: "Ken took over …") and a refetch of that thread.
- `pages/conversation-parts.tsx`: `Dock` becomes `TakeoverBar` / `Composer` / `OwnedBar` / closed text by `dockMode`; staff bubbles show the name ("You" for mine); new dividers.
- `pages/inbox.tsx`: assignee filter next to the channel filter; owner caption on human rows.

### 5.6 Widget (`apps/widget/src`)

- `chat.ts`: `rowsOf` skips the bubble when `body` is empty (notice-only rows), labels staff bubbles with `authorName ?? t.teamMember`; new `staffHandling(chat)` = the latest `staff_joined`/`staff_left` notice is `staff_joined`; `awaitingTurn` returns null while `staffHandling` (no assistant typing indicator, D8). `strings.ts`: `teamMember` ("A team member" / "团队成员"). The notice text itself is server-rendered (as after-hours).
- `panel.tsx`: the staff bubble's name line above the text (caption, `--kaki-muted`); notices use the existing `system-notice` row. The loader is untouched; the panel stays within budget (`pnpm size`).

### 5.7 E2E (`e2e/tests/takeover.e2e.ts`)

Two staff sessions on the dev tenant in two browser contexts: the owner and a new seeded member `agent@kaki-bakery.test` (role `agent`, display name "Mei Ling"), added to `seed` in `packages/db/src/setup.ts` (the dev seed has only the owner today). a widget visitor message reaches the inbox; staff A takes over; the widget shows "… joined the chat"; a new visitor message gets no assistant reply within 5 s; staff A's reply appears in the widget with the name; staff B sees "… is handling this" and requests; A sees the toast; A hands back; the widget shows the left notice and the next visitor message is answered by the assistant. The assignee filter "Mine" lists it while A owns it. Phone width (375, tall viewport): take over, send, hand back; axe clean. The simultaneous race is covered by the integration tests, not E2E.

## 6. Acceptance criteria

- **AC-1** (INB-02 "staff can pause the AI in a conversation and reply directly", UC-23 3) From an AI-handling, escalated or waiting-for-approval conversation, a staff member takes over: the conversation becomes Human, they own it, and the composer opens; their replies reach the visitor's widget in ≤ 2 s, labelled with their display name.
- **AC-2** (INB-02 "while a human has taken over, the AI does not send any messages", ADR-013 d3) While a person owns the conversation, visitor messages get no AI reply and no model call; a reply being released when the take-over commits stops before its next segment.
- **AC-3** (INB-02 "the visitor sees a 'staff joined' notice") On take-over the widget shows "{name} joined the chat." (or "A team member joined the chat.") in the conversation's language, and staff see the same text as "Visitor sees: …"; the visitor never sees an email address.
- **AC-4** (INB-02 "hand back to the AI when done", UC-23 5) The owner hands back: the conversation returns to AI handling with no owner, the widget shows the left notice, and the next visitor message is answered by the assistant.
- **AC-5** (INB-09 "when two staff press take over at the same moment, exactly one succeeds and the other is told who has it", UC-23 3a) Two simultaneous take-overs give exactly one owner; the other gets 409 `owned` with the winner's name, shown as "Mei Ling took this over just now."
- **AC-6** (INB-09 "only one staff member can own … others see who owns it and can request it") Only the owner can reply, hand back or close; others see "{name} is handling this conversation" and can ask for it, which notifies the owner in the app and shows as a divider in the thread; owners and admins can take it from them after confirming, which tells the previous owner (D1).
- **AC-7** (INB-01 "by assignee") The inbox can be filtered to Anyone, Mine, Unassigned or a named teammate by current owner, with keyset paging as in FEAT-042, and rows of owned conversations show the owner.
- **AC-8** (INB-08, ADR-014) Take over, hand back, take-from and requests each write exactly one audit entry with IDs and codes only, and show as dated dividers in the thread; every close path removes the owner.
- **AC-9** (ADR-005, ADR-009, ADR-015) `conversation_owners` has forced RLS (tenant B sees nothing of tenant A's), every new route is 404 across tenants, the dashboard zone can insert only staff and system messages, and staff text is PII-masked before storage.
- **AC-10** (SCR-APP-015, SCR-APP-014, SCR-WGT-002, NFR-09, NFR-19) The takeover bar, composer (sending, failed, retry), owned-by-someone-else bar, request sent, take-from dialog, conflict alerts and the widget's joined, staff-message and left states render as in ui-design.md; at 375 px everything works without horizontal scroll; axe reports no serious violations.

## 7. Decisions

- **D1 — Owners and admins can take a conversation from its owner (pending Ken's card; recommended).** Without it a teammate who leaves mid-chat blocks the conversation until it auto-closes. A new capability `inbox.reassign` (owner, admin), a confirm dialog, an `owner_changed` audit entry and a `taken_from_you` event to the old owner. Agents can only request. If Ken declines, drop `from`, `inbox.reassign` and the dialog; the rest stands.
- **D2 — The owner row decides the race; the status follows in the same transaction.** ADR-013 d2's `insert … on conflict do nothing` gives the winner and the loser's answer in one statement; `transition` then moves the status with the usual compare-and-set and audit. The gate checks both the row and the status.
- **D3 — The visitor sees a snapshot of the display name only.** Taken at take-over through the identity zone (FEAT-008 §8), stored on the owner row and copied to each staff message and notice. Never the email local part (unlike staff-facing `memberNames`); no display name → "A team member". A later name change doesn't rewrite what the visitor was shown. Staff names are staff data, not visitor PII (ADR-015 covers contacts), and the audit log still holds IDs only.
- **D4 — Notices are system messages rendered server-side in the conversation's language.** The same pattern as after-hours (FEAT-023): stored, replayed over SSE after a reconnect, shown in the inbox thread, and carrying `language` so the widget's locale holds. Hand-back gets its own notice so the visitor knows the assistant answers again (AGT-11's spirit).
- **D5 — Staff messages are written by the dashboard zone, which may now update `last_message_at`.** Staff replies must count as activity, or auto-close would end a live staff chat after 30 minutes. FEAT-042's grant assertion that `app_dashboard` can't update `last_message_at` changes to the reverse here (a design change, not a weakened test; `flag_reasons` stays refused). Inserts are limited to staff and system rows by policy.
- **D6 — Only the owner can close a taken-over conversation.** Others get 409 `owned`; closing someone else's chat is the take-from path (D1). Unowned conversations close as in FEAT-042.
- **D7 — The assignee filter means the current owner.** FEAT-044 adds escalation assignees and widens the filter to "owner, else escalation assignee". Options: Anyone, Mine, Unassigned, then each active member (`GET /api/v1/inbox/members`).
- **D8 — No typing indicator for staff.** The widget hides the assistant's indicator while staff handle the chat; a staff typing signal needs a new event path and isn't required by INB-02.
- **D9 — No staff reply or take-over in a closed conversation.** A closed conversation reopens only on a visitor message (FEAT-042 D5); outreach to a visitor who left is lead follow-up (FEAT-049/050).

## 8. Escalations and open items

- **D1 is pending Ken** (decision card in the design thread); the design and tasks assume "yes".
- Other channels: staff messages are delivered to the widget by the stored message and SSE. When FEAT-036+ add channels with `ChannelAdapter.send`, staff messages and notices go through the outbox to the adapter like AI replies; nothing here branches on channel kind.
- FEAT-044 (escalation): take-over clears an escalation by moving `escalated → human`; FEAT-044's reminders must stop when the conversation has an owner. FEAT-045 adds "Suggest a reply" to the takeover bar and composer. FEAT-055: hand-back from a conversation whose approval is still pending returns it to `ai` (INB-08's edge); FEAT-055 decides whether it should return to `waiting_approval`.
- Web push for the hand-over request when the owner isn't in the app is FEAT-048; email alerts FEAT-052.

## 9. Self-check

- INB-02's clauses → AC-1 to AC-4; INB-09's → AC-5, AC-6; INB-01's assignee filter → AC-7; UC-23 3 → AC-1, AC-3; 3a → AC-5; 5 → AC-4.
- New tenant table with forced RLS, policy, `TENANT_SCOPED_TABLES` entry and RLS case; tenant ID from the session only; the dashboard zone writes only staff and system messages.
- The send gate stays the single answer to "may the AI speak" (ADR-013 d3) and gains the owner row. Concurrency is decided by Postgres (ADR-013 d2), tested with parallel clients.
- Side effects: publishing is notification only (ADR-017); the stored message is the delivery for the widget. No model call is added; the model never writes staff text.
- Audit entries carry IDs and codes only (ADR-014); staff text is masked at the edge (ADR-015).
- UI uses design.md's `composer` with takeover bar, `message-bubble`, `dialog`, `toast`, `alert`, `select`; widget `system-notice` and `--kaki-info-bg`; tokens only.

Traceability: INB-02 → AC-1–AC-4, AC-10; INB-09 → AC-5, AC-6; INB-01 (p) → AC-7; INB-08 → AC-8; UC-23 3 → AC-1, AC-3, 3a → AC-5, 5 → AC-4; ADR-013 → AC-2, AC-5, D2; ADR-014 → AC-8; ADR-005/009/015 → AC-9; SCR-APP-014, SCR-APP-015, SCR-WGT-002 → AC-10. IDs checked: INB-01, INB-02, INB-08, INB-09, AGT-11, UC-23, SCR-APP-014, SCR-APP-015, SCR-WGT-002, NFR-09, NFR-19, ADR-005, ADR-009, ADR-013, ADR-014, ADR-015, ADR-017, FEAT-008, FEAT-023, FEAT-036, FEAT-042, FEAT-044, FEAT-045, FEAT-048, FEAT-049, FEAT-050, FEAT-052, FEAT-055 resolve.
