# Technical design: FEAT-042 — Real-time inbox, conversation view, context sidebar, lifecycle and auto-close

> Implements: INB-01 (p: the unified real-time inbox with the open, escalated, waiting-for-approval, flagged, closed and channel filters, paginated, new messages in ≤ 2 s; the assignee filter arrives with FEAT-043's owners), INB-04 (conversation sidebar: contact, channel, intent signals, lead status, KB sources used), INB-08 (the five lifecycle states, auto-close after inactivity, staff close, reopen within 7 days, state changes shown and audited), AGT-13 (p: flagged conversations appear under "Flagged") · Realizes: UC-23 steps 4–5 (p: read the sidebar, close the conversation; takeover, suggestions and notes are FEAT-043/045/047) · Screens: SCR-APP-014 Inbox, SCR-APP-015 Conversation (p: read-only thread, close, sidebar; the takeover bar, composer and suggestion are FEAT-043/045) · Module: `inbox` (conversations, messages; architecture §5.2)
> Status: designed · 2026-10-31

## 1. Intent

Staff can see every conversation as it happens, filter the list to what needs them, open one to read the whole thread with the facts each AI answer used, and see who the visitor is, what they wanted and where they are as a lead. Conversations follow one lifecycle (ADR-013 decision 1): every state change goes through one compare-and-set function that applies INB-08's rules and writes exactly one audit entry. Quiet conversations close on their own (widget 30 minutes, other channels 72 hours), staff can close one by hand, and a visitor who writes again within 7 days reopens the same conversation. This is the inbox FEAT-043 (takeover), FEAT-044 (escalation), FEAT-045 (suggestions), FEAT-046 (search), FEAT-047 (notes) and FEAT-055 (approvals) build on.

## 2. Codebase context

- **Inbox** (`packages/inbox/src/index.ts`, one ~760-line file): `conversations.status` is `ai | human | closed` (0000), no version; `listConversations(tx, tenantId, limit)` returns the latest 50 with the last message body; `flagConversation` (FEAT-025) sets `flagged_at`/`flag_reasons`; `endAiConversation` (repeated abuse, `ai → closed`, audit `conversation.ai_ended`) and `endVisitorConversation` (CHN-13, `ai|human → closed`, audit `conversation.visitor_ended`) write `status` directly; `appendVisitorMessage` throws `ConversationClosedError` on a closed conversation (FEAT-033 D5, API 409 `chat_ended`) and updates `last_message_at`; so does `appendAgentReply`. `toSummary`/`toMessage` build the contracts.
- **Gate** (`packages/agent/src/gate.ts` `aiAllowed`): closed unless `status = 'ai'` (reason `not_ai`).
- **API** (`apps/api/src/app.ts`): `GET /api/v1/conversations` (no filters) is inline in `app.ts`; the widget routes publish `message` and `conversation` events to `channels.inbox(t)` (and `channels.conversation` for messages). The agent-worker publishes the reply the same way (`apps/agent-worker/src/main.ts`, `TurnJob`).
- **Realtime** (`apps/realtime/src/app.ts` `/ws`): forwards every `RealtimeEvent` on `channels.inbox(tenant)` to the tenant's sockets; nothing to change. Dashboard `lib/realtime.ts` `useInboxSocket` patches `['conversations']` on `conversation` events and refetches on every `ready`.
- **Dashboard:** `pages/inbox.tsx` is the skeleton list (testids `live-state`, `conversation-list`, `conversation-row`, `conversation-preview`, used by `skeleton.e2e.ts`; sign-in lands on `/inbox` exactly, `support.ts`).
- **Scheduler** (`apps/scheduler-worker`): outbox zone only, no Valkey; cross-tenant jobs call a SECURITY DEFINER function owned by a NOLOGIN role (`kb_stale_scan`, 0029). The audit chain is appended in TypeScript through `audit_head_lock()` (granted to `app_dashboard`, `app_agent_visitor`, not `app_outbox`).
- **Grants:** `app_dashboard` has SELECT on `conversations`, `messages`, `audit_entries` (+ INSERT on audit); `app_agent_visitor` has UPDATE `(last_message_at, status, flagged_at, flag_reasons, abuse_turns)`.
- **Identity:** capabilities `inbox.read` and `inbox.reply` (every role, `capabilities.ts`).
- **Design:** anchor-screens SCR-APP-015 (and its prototype), design.md §3 (inbox panes), §2.1 `--color-conversation-*`, §4.4 `chip`, `list`, `pagination`, `tabs`, `avatar`, §4.6 `message-bubble`, `composer` (dock pattern), `context-sidebar`, §4.8 data-view states.

## 3. API contracts (`packages/contracts/src/index.ts`)

**Changed** (top of the file):
- `ConversationStatus = z.enum(['ai', 'escalated', 'human', 'waiting_approval', 'closed'])` (D1). `ConversationSummary.status` uses it; the summary gains `closeReason: CloseReason.nullable()` and `closedAt: iso | null`. `CloseReason = z.enum(['staff', 'inactive', 'visitor', 'abuse'])`.
- `ConversationList` becomes `{ conversations: ConversationSummary[], nextCursor: string | null, counts: InboxCounts }`; `InboxCounts = { open, escalated, approval, flagged }` (integers; closed isn't counted).

**New section** `// ---- Dashboard API: inbox (INB-01, INB-04, INB-08; FEAT-042 §3)`:
- `InboxView = z.enum(['open', 'escalated', 'approval', 'flagged', 'closed'])`. `open` = every state but closed; `escalated`/`approval` = that state; `flagged` = `flagged_at is not null`, any state; `closed` = closed.
- `ConversationListQuery = { view: InboxView.default('open'), channel: z.enum(['widget']).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(25) }`. The cursor is opaque base64url of `{ at: lastMessageAt, id }` (keyset on `(last_message_at desc, id desc)`); a malformed one is 400 `bad_cursor`.
- `ThreadMessage = Message.extend({ factIds: z.array(z.uuid()) })` (dashboard only; the widget's `Message` stays without fact IDs).
- `ThreadEvent = { at: iso, to: ConversationStatus, from: ConversationStatus | null, reason: CloseReason | 'reopened' | null, actor: { type: 'user' | 'agent' | 'visitor' | 'system', name: string | null } }` (from the audit entries, §5.2).
- `FactChip = { id, type: FactType, label: string, status: FactStatus }` (status so a since-disabled fact shows as such).
- `ContextSidebar = { contact: { label: string, firstSeenAt: iso, previousConversations: number }, channel: 'widget', intents: Array<{ signal: IntentSignal, count: number }>, lead: null, facts: Array<FactChip & { uses: number }> }`. `IntentSignal = z.enum(['asked_questions', 'wants_to_order', 'left_details', 'asked_for_person', 'switch_channel', 'privacy_request', 'out_of_scope', 'abuse', 'crisis'])`, mapped from triage task kinds (D4). `lead` is always null until FEAT-049 (the contract field is `LeadSummary | null` with `LeadSummary` a placeholder `{ status: string }` FEAT-049 replaces).
- `ConversationThread = { conversation: ConversationSummary & { version: number, createdAt: iso }, messages: ThreadMessage[], hasEarlier: boolean, events: ThreadEvent[], sidebar: ContextSidebar }`.
- `ThreadPageQuery = { before: z.coerce.number().int().positive().optional() }` (a message `seq`); `ThreadPage = { messages: ThreadMessage[], hasEarlier: boolean }`.
- `CloseConversationBody = z.object({ version: z.number().int().min(0) }).strict()`; response `{ conversation: ConversationSummary }`.

**Routes** (`apps/api/src/inbox.ts`, `registerInboxRoutes(app, deps, sessionFrom, notify)`, replacing the inline route in `app.ts`):

| Method, path | Capability | Success | Errors |
|---|---|---|---|
| `GET /api/v1/conversations?view&channel&cursor&limit` | `inbox.read` | 200 `ConversationList` | 400 `bad_cursor`/validation |
| `GET /api/v1/conversations/:id` | `inbox.read` | 200 `ConversationThread` (latest 100 messages) | 404 `not_found` (also another tenant's ID) |
| `GET /api/v1/conversations/:id/messages?before=` | `inbox.read` | 200 `ThreadPage` (100 before `seq`) | 404 |
| `POST /api/v1/conversations/:id/close` | `inbox.reply` | 200 `{ conversation }`; publishes `conversation` on `channels.inbox` | 404; 409 `already_closed`; 409 `state_changed` with `{ conversation }` (version moved) |

`limit`, `before` and IDs are validated (UUID check as in the widget routes); the tenant comes only from the session.

## 4. Schema changes (migration `0042_inbox_lifecycle.sql`; Drizzle DDL, then hand-written grants and the function in the same file)

- `conversations.status` enum widens to the five values (D1), with `conversations_status_ck`. New columns: `version integer not null default 0`; `closed_at timestamptz`; `close_reason text` (enum `CLOSE_REASONS = ['staff', 'inactive', 'visitor', 'abuse']` in `schema.ts`); `auto_close_queued_at timestamptz`. Check `conversations_closed_ck`: `(status = 'closed') = (closed_at is not null and close_reason is not null)`. Backfill before the check: closed rows get `closed_at = last_message_at`, `close_reason = case when 'abuse' = any(flag_reasons) then 'abuse' else 'visitor' end`.
- Index `conversations_open_idle_idx on (last_message_at) where status <> 'closed'` (the cross-tenant due scan) and `conversations_tenant_status_last_idx on (tenant_id, status, last_message_at desc, id desc)` (the views).
- `messages.task_kinds text[] not null default '{}'` with a check `<@` the `TaskKind` codes (copied as a literal list; FEAT-042 adds a unit test that the list equals `TaskKind.options`), set on agent replies (D4).
- Grants: `app_dashboard` UPDATE `(status, version, closed_at, close_reason)` on `conversations`; `app_agent_visitor` UPDATE adds `(version, closed_at, close_reason)`. No new table, so the RLS suite gains no table case; it gains the zone assertions in §5.1.
- `inbox_queue_auto_close()` RETURNS TABLE `(tenant_id uuid, queued integer)`, SECURITY DEFINER, owned by NOLOGIN `kaki_inbox_timer` (created in the migration as `kaki_stale_scan` is in 0029; SELECT `(tenant_id, id, channel, status, last_message_at, auto_close_queued_at)` and UPDATE `(auto_close_queued_at)` on `conversations`, INSERT on `outbox`, with `FOR SELECT/UPDATE/INSERT … USING (true)` policies for that role), EXECUTE granted to `app_outbox` only. It picks up to 500 conversations with `status <> 'closed'`, `last_message_at < now() - idle(channel)` (`widget` 30 minutes, any other channel 72 hours, one `CASE` in the function: the single source, D3) and `auto_close_queued_at is null or auto_close_queued_at < last_message_at`, sets `auto_close_queued_at = now()`, and inserts one outbox row each on topic `conversation-turns`, `group_key` = conversation ID, payload `{ kind: 'auto_close', tenantId, conversationId }`.

## 5. Component design

### 5.1 Lifecycle (`packages/inbox/src/lifecycle.ts`, exported from the index)

- `TRANSITIONS`: the INB-08 edge table. `ai → escalated | human | waiting_approval | closed`; `escalated → ai | human | closed`; `human → ai | closed`; `waiting_approval → ai | escalated | human | closed`; `closed → ai` (reopen only). FEAT-042 calls only the `→ closed` edges and `closed → ai`; the rest are for FEAT-043/044/055 and are unit-tested here.
- `transition(tx, { tenantId, conversationId, to, reason, actor, expectedVersion? })`: reads the row (`for update`), refuses an edge not in the table (`IllegalTransitionError`), refuses a version mismatch when `expectedVersion` is given (`StateChangedError` carrying the current row), then `update … set status, version = version + 1, closed_at/close_reason (set on → closed, cleared on reopen) where tenant_id and id and version = $read` (compare-and-set, ADR-013 d1). Zero rows → `StateChangedError`. Writes exactly one audit entry (D6): action `conversation.closed` (staff), `conversation.auto_closed` (inactive), `conversation.ai_ended` (abuse), `conversation.visitor_ended` (visitor), `conversation.reopened`, or `conversation.state_changed` for the later features' edges; payload `{ from, to, reason }` as codes; actor `user` + user ID, `system`, `agent` or `visitor`. Returns the updated row.
- `endAiConversation` and `endVisitorConversation` keep their signatures and idempotency but go through `transition` (abuse: only from `ai`, as today; visitor: from any non-closed state). Their two existing audit assertions gain `from`/`to` (stricter, D6).
- `closeByStaff(tx, { tenantId, conversationId, userId, version })` → `transition(… to 'closed', reason 'staff', expectedVersion)`; `AlreadyClosedError` when closed.
- `autoCloseIdle(tx, tenantId, conversationId)` (agent-worker): re-reads the row and closes it with reason `inactive` only if it is still open and still idle by the same rule as the SQL function (exported `IDLE_MS` per channel, unit-tested against the SQL by an integration case at the boundary); otherwise a no-op returning null. Idempotent, so a duplicate outbox row costs nothing.
- **Reopen** in `appendVisitorMessage`: a closed conversation with `close_reason in ('staff', 'inactive')` and `closed_at > now() - 7 days` is reopened (`closed → ai`, actor visitor) before the message is stored, in the same transaction; `visitor`/`abuse`-closed or older ones keep throwing `ConversationClosedError` (FEAT-033 D5; D5 here). The idempotent-retry branch is unchanged.
- **Integration cases** (`packages/inbox/test/lifecycle.int.test.ts`): each `→ closed` reason audits once with codes only; two concurrent `closeByStaff` with one version → one 200, one `StateChangedError` (two clients, `Promise.all`); illegal edges refused; reopen within 7 days (same ID, `ai`, `conversation.reopened`, message stored and turn queued) and after 7 days or after a visitor end (409 path); `autoCloseIdle` closes at 31 minutes and not at 29, and not after a new message; `inbox_queue_auto_close()` queues once per idle period (a second run queues nothing; a new message then idleness queues again), never touches closed rows, is refused to `app_dashboard`; `app_dashboard` can't update `last_message_at` or `flag_reasons` (grant assertion); tenant B can't see or close tenant A's conversation.

### 5.2 Queries (`packages/inbox/src/views.ts`)

- `listConversations(tx, tenantId, { view, channel, cursor, limit })` → `{ conversations, nextCursor }` with the last message body as today; `inboxCounts(tx, tenantId)` → `InboxCounts` in one `count(*) filter (where …)` query.
- `getThread(tx, tenantId, conversationId, { before?, limit = 100 })` → messages ascending (`seq`) with `factIds`, `hasEarlier`.
- `threadEvents(tx, tenantId, conversationId)` → the audit entries whose `subject_refs` contain `conversation:<id>` and whose `event_type` is one of the lifecycle actions above or `conversation.flagged`, oldest first (GIN index on `subject_refs`), mapped to `ThreadEvent`; the user name for `actor_ref` comes from the API layer (D7).
- `sidebarFacts(tx, tenantId, conversationId)` → `{ factId, uses }` from the agent messages' `fact_ids`; `intentCounts(…)` → counts per task kind from `task_kinds`; `visitorHistory(…)` → first seen and previous conversations of the same `visitor_id` (the contact link until FEAT-049's contacts, D5).
- `kb` gains `factChips(tx, tenantId, ids)` (`packages/kb/src/facts.ts`, exported) → `FactChip[]` using `factLabel` (`corrections.ts`); missing IDs are dropped.

### 5.3 Agent, workers

- `gate.ts` `aiAllowed`: open unless `status` is `human` or `closed` (ADR-013 d3: escalated and waiting-for-approval conversations are still answered until a person takes over); the reason codes stay `not_ai` for both (D2). Its unit tests add `escalated` and `waiting_approval` as open.
- `turn.ts` `store(`: passes `taskKinds: plan?.tasks.map(t => t.kind) ?? []` to `appendAgentReply`, which writes `messages.task_kinds` (distinct, plan order).
- `apps/agent-worker/src/main.ts`: `TurnJob` becomes a union of today's shape and `{ kind: 'auto_close', tenantId, conversationId }`. An auto-close job runs `withTenant(visitorDb, t, tx => autoCloseIdle(…))` and, when it closed something, publishes a `conversation` event (with the last message body) on `channels.inbox(t)`. Riding the turns queue's FIFO group means a close can't interleave with a turn of the same conversation (D3).
- `apps/scheduler-worker/src/auto-close.ts` `autoCloseOnce(outboxDb, logger, run = queueAutoClose)` (never throws; logs tenants and queued), `queueAutoClose` in `@kaki/inbox` calls the SQL function; timer `AUTO_CLOSE_INTERVAL_MS` (default 60000, first run at start-up) in `config.ts` and `.env.example`. Unit test like `stale-scan.test.ts`.

### 5.4 API (`apps/api/src/inbox.ts`)

`registerInboxRoutes(app, deps, sessionFrom, notify)`, wired where the inline route was. The thread route runs one dashboard-zone transaction for the conversation, messages, events, sidebar queries and `factChips`; actor names come from `memberNames(identityDb, tenantId, userIds)` in `@kaki/identity` (new, identity zone, display name or email local part; D7). Close maps `AlreadyClosedError` → 409 `already_closed`, `StateChangedError` → 409 `state_changed` with the current summary, then publishes the new summary. Contract round-trip unit test `inbox-contract.test.ts`; integration suite `apps/api/test/inbox.int.test.ts`: each view and channel filter, keyset pagination over 30 rows (no duplicates or gaps across pages), counts, a bad cursor 400, thread shape (fact IDs on agent messages, events with names, sidebar facts and intents), older page, close 200/409/409, a widget message to a staff-closed conversation reopens it (201, same ID), cross-tenant 404 on every route, a session owing two-step refused.

### 5.5 Dashboard (detail in ui-design.md)

- `lib/api.ts`: `conversations(query)`, `conversation(id)`, `conversationMessages(id, before)`, `closeConversation(id, version)`.
- `lib/inbox.ts`: `viewFromSearch`/`searchFromView` (URL `?view=&channel=`; the default view leaves the URL as `/inbox`), `matchesView(summary, view, channel)`, `applySummary(pages, summary, view, channel)` (insert or move to the top when it matches, drop when it no longer does), `appendMessage(thread, message)` (by `seq`, deduped), `stateLabel`, `closeReasonText`, `intentLabel`. Unit tests in `lib/inbox.test.ts`.
- `lib/realtime.ts`: `conversation` events go through `applySummary` for every cached list query (`['conversations', view, channel]`, infinite) and invalidate `['inbox-counts']`; `message` events append to the cached thread `['conversation', id]` and update the summary preview; on `ready` it refetches lists, counts and the open thread (Postgres is the record, ADR-017).
- Routes: `/inbox` and `/inbox/:conversationId` both render `InboxPage` (list + thread panes by width); `pages/inbox.tsx` (list), `pages/conversation.tsx` (thread), `pages/conversation-parts.tsx` (bubbles, events, dock, sidebar).

### 5.6 E2E (`e2e/tests/inbox.e2e.ts`)

A widget message reaches the inbox list and the open thread in ≤ 2 s without reload; the answer shows its fact chips; the sidebar shows Website visitor, channel, intents and the fact; Close moves it to the Closed view with the "Closed by you" divider; a new widget message reopens it into Open. The Flagged view lists a conversation flagged through the safety path (a crisis message on the fake provider). Phone width (375, tall viewport): list → thread → back, the sidebar sheet, no horizontal scroll, axe clean. Auto-close is not E2E-tested (30 minutes); the integration cases cover it.

## 6. Acceptance criteria

- **AC-1** (INB-01 "unified real-time inbox … new messages appear in ≤ 2 s without refreshing") A visitor message and the AI reply appear in the open list and in an open thread without reload within 2 s; after a dropped socket the inbox shows Reconnecting and refetches on reconnect, losing nothing.
- **AC-2** (INB-01 filters, "lists are paginated") Open, Escalated, Waiting for approval, Flagged and Closed views and the channel filter return exactly the matching conversations, newest activity first, 25 per page with Load more (no duplicates or gaps); tab counts match; filtered-empty offers Clear filters. Assignee is FEAT-043 (§8).
- **AC-3** (AGT-13 "flagged conversations appear in the inbox under 'flagged'") A conversation flagged for crisis or abuse is listed under Flagged in any state, with a Flagged chip on its row and a divider in its thread.
- **AC-4** (INB-04 "visible for every conversation") Every conversation's sidebar shows contact (Website visitor, first seen, previous conversations), channel, intent signals from triage, lead status (none yet) and the KB facts its AI answers used with use counts and links; AI messages show their fact chips inline.
- **AC-5** (INB-08 states, ADR-013 d1) Conversations hold one of the five states; every change goes through one compare-and-set transition that refuses edges outside INB-08's table and stale versions; two simultaneous closes → exactly one succeeds, the other gets 409 `state_changed`.
- **AC-6** (INB-08 auto-close) A widget conversation idle for 30 minutes (other channels 72 hours) closes with reason inactive within about a minute of becoming due, from any open state; one that got a message meanwhile stays open; no visitor message is posted.
- **AC-7** (INB-08 staff close, reopen) Staff close an open conversation from the thread; a visitor message within 7 days of a staff or inactivity close reopens the same conversation to AI handling and gets answered; after 7 days, or after the visitor or the abuse rule ended it, the message is refused (409 `chat_ended`) and the widget starts afresh (a new conversation for the same visitor).
- **AC-8** (INB-08 "state changes are shown in the inbox and recorded in the audit log") Each change shows as the row's state chip and as a dated divider in the thread naming who or what caused it; each writes exactly one audit entry with IDs and codes only (ADR-014).
- **AC-9** (ADR-005, ADR-009) Every route and query is tenant-scoped: another tenant's conversation is 404 on every route; the scheduler's function runs only as the outbox role and the dashboard zone can update only the lifecycle columns.
- **AC-10** (SCR-APP-014, SCR-APP-015, NFR-19, INB-06, NFR-09) The inbox and conversation screens show loading, empty, filtered-empty, error with Try again, reconnecting, and the thread states AI handling, escalated, human, waiting for approval, closed and flagged; three panes at ≥ 1280, two with a sidebar drawer at 1024–1279, one at a time below; at 375 px every action works without horizontal scroll; axe reports no serious violations.

## 7. Decisions

- **D1 — Keep the column `status` and the value `ai`; add `escalated` and `waiting_approval`.** ADR-013 names the column `state` and the value `ai_handling`; renaming would touch the widget, contracts, gate and nine test files for no behavioural gain. Labels in the UI follow INB-08's words. The ADR's decision (one column with a version, compare-and-set) is kept.
- **D2 — The send gate stays open in escalated and waiting-for-approval.** ADR-013 d3 lists exactly: kill switch, channel live, no human owner, not closed. Until FEAT-043's owner row exists, `human` stands in for "has an owner".
- **D3 — Auto-close is a Postgres-timed scan that queues a job on the turns queue.** The scheduler has no audit or Valkey access; the agent-worker has both and already serialises per conversation through the FIFO group. `auto_close_queued_at` stops a due conversation being queued every minute while staying eligible again after new activity. The idle rule lives in the SQL function, mirrored by `IDLE_MS` for the worker's re-check and tested at the boundary.
- **D4 — Intent signals come from triage's task kinds, stored on each agent reply.** The plan's kinds (answer, capture lead, commitment, escalate, …) are the intent the agent already computes; storing them on the message avoids reading the audit log for it. Current page, pages viewed and UTM (anchor-screens' intent block) need the widget to send page context and are left to a later feature (§8).
- **D5 — Reopen applies to staff and inactivity closes only.** A chat the visitor ended (CHN-13) or the abuse rule ended (AGT-13) stays ended, so ending can't be undone by the abuser and the visitor's own "End chat" means what it says; the widget already starts a new conversation after a 409. Until FEAT-049's contacts, "linked to the same contact" means the same `visitor_id`, which the sidebar's previous-conversations count shows.
- **D6 — One audit entry per transition, keeping the existing action names.** The two actions FEAT-025 and FEAT-033 already write stay (`conversation.ai_ended`, `conversation.visitor_ended`) so their tests and any audit consumers keep working; every lifecycle entry now carries `{ from, to, reason }`, so their assertions gain fields rather than lose them.
- **D7 — Thread dividers are read from the audit log, and actor names from identity at read time.** No new table: the audit entries already hold exactly the state changes, ordered and tenant-scoped, and the dashboard zone can read them. Audit entries hold user IDs only (ADR-014), so names are looked up through the identity zone per request.
- **D8 — Closing needs no confirmation and tells the visitor nothing.** It is undone by the visitor's next message (reopen); a toast confirms it to staff. A visitor-facing "chat closed" notice would invite replies that reopen it anyway.
- **D9 — The inbox's flagged view is a filter, not a state.** AGT-13 flags are orthogonal to the lifecycle (a flagged conversation can be open or closed), matching FEAT-025's `flagged_at`.

## 8. Escalations and open items

- **INB-01 assignee filter → FEAT-043.** No conversation has an owner or assignee until FEAT-043's `conversation_owners` (and FEAT-044's escalation assignee); FEAT-043 adds the `assignee` query parameter and the filter control. Recorded in `/mnt/project-files/pending-actions.md`.
- **For FEAT-043 (not FEAT-042, correcting FEAT-008 §8):** the visitor-facing staff name snapshot belongs to takeover, which is FEAT-043. On close, FEAT-043 must also delete the owner row inside `transition`.
- **Intent page context:** current page, pages viewed and UTM (anchor-screens context-sheet) need the widget to report page context with each message; not planned in any feature row yet. Raised for Ken in pending-actions (candidate: FEAT-046 or an analytics feature).
- Other channels' 72-hour rule is in place but untested until FEAT-036+ add channels (the channel enum is `widget` only).
- Not here: takeover bar, composer and suggestions (FEAT-043/045), notes and tags (FEAT-047), search (FEAT-046), escalation routing (FEAT-044), web push (FEAT-048).

## 9. Self-check

- Every INB-08 clause maps to an AC (AC-5–AC-8); INB-01's filters, pagination and latency → AC-1, AC-2 (assignee deferred, §8); INB-04 → AC-4; AGT-13's flagged clause → AC-3; UC-23 4–5 (p) → AC-4, AC-7.
- No new tenant table; the new columns sit on RLS-forced `conversations`/`messages`. The cross-tenant function is owned by a NOLOGIN role and granted to the outbox role only; tenant ID only from the session or the job payload the database wrote.
- Side effects: the auto-close job goes through the outbox (ADR-012); consumers are idempotent (re-check, compare-and-set). Pub/sub only notifies (ADR-017).
- The model is untouched; the agent pipeline changes only the gate's open set and what `store(` records. Module boundaries: inbox owns the lifecycle and queries; kb gives fact chips; identity gives names; api, workers and dashboard wire them.
- UI uses design.md's `chip`, `list`, `tabs`, `pagination`, `avatar`, `message-bubble`, `context-sidebar`, `dialog` (bottom sheet), `toast`, `skeleton`, `empty-state`, `error-state` and the `--color-conversation-*` aliases; tokens only.

Traceability: INB-01 (p) → AC-1, AC-2, AC-10; INB-04 → AC-4, AC-10; INB-08 → AC-5, AC-6, AC-7, AC-8; AGT-13 (p) → AC-3; UC-23 4 → AC-4, 5 → AC-7; ADR-013 → AC-5, D1, D2, D3; ADR-014 → AC-8, D7; ADR-005/009 → AC-9; ADR-012, ADR-017 → AC-1, AC-6; SCR-APP-014, SCR-APP-015 → AC-10. IDs checked: INB-01, INB-04, INB-06, INB-08, AGT-13, CHN-13, NFR-09, NFR-19, UC-23, SCR-APP-014, SCR-APP-015, ADR-005, ADR-009, ADR-012, ADR-013, ADR-014, ADR-017, FEAT-025, FEAT-033, FEAT-043–049, FEAT-055 resolve.
