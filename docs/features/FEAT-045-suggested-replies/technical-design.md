# Technical design: FEAT-045 — AI-suggested replies for staff (verified)

> Implements: INB-03 (AI-suggested replies for staff, draft only; staff can edit and then send; suggestions pass the same AGT-02 checks), KB-18 (p: staff edits to AI-suggested replies enter the correction queue) · Realizes: UC-23 step 4 (p: uses or edits AI-suggested replies; notes are FEAT-047) and alternate flow 4a (p: the suggested-reply edit; a staff answer filling a gap is a later producer) · Screens: SCR-APP-015 (p: Suggest a reply, the suggestion in the composer), SCR-APP-021 (p: the staff-edit row), SCR-APP-022 (p: the staff-edit item) (see [ui-design.md](ui-design.md)) · Module: `agent` (`suggestReply`), `inbox` (suggestion use on send), `kb` (the `reply_edit` proposal), architecture §5.2, ADR-007, ADR-008, ADR-009, ADR-010, ADR-025, ADR-026
> Status: designed · 2026-11-02

## 1. Intent

A staff member handling a conversation asks the assistant for a draft. The assistant answers the visitor's latest message exactly as a visitor turn would (triage, approved facts, slot render, verifier, leak and boundary guards), but the result goes into the staff member's composer instead of to the visitor. Nothing reaches the visitor until the staff member presses Send. A draft that can't pass the checks is never shown: the staff member is told there is no checked suggestion and writes their own. When the staff member changes the draft before sending, the system adds a "Staff edit" item to the correction queue so the owner can turn the better answer into an FAQ (KB-18, UC-23 4a). Pressing "Suggest a reply" while the AI holds the conversation takes it over first (design.md §4.6, anchor SCR-APP-015).

## 2. Codebase context

- **Replay already answers a past visitor question outside a live turn** (`agent/replay.ts` `replayQuestion`, FEAT-028): dashboard zone, the live triage prompt with the rules tail, `applyBoundary`, `searchCoachingFacts(..., { includeUnreviewed: false })` (approved, in-date, GST-known: the `visitor_facts` filter), `dispatchPlan(replayRegistry, ...)` with no-op ports (`replay-dispatch.ts`), then `answerStep` (`coach.ts`: `routeReply`, `answerTurn` with `gateOpen: () => true` and a no-op `publish`). It runs synchronously in the API (`apps/api/src/coach.ts`), not the agent-worker (ADR-026 kept replay in the worker; FEAT-028 ran it in the API, and suggestions follow that precedent, D1).
- **Per-tenant turn state** loads in one transaction per flow (code-map "Agent pipeline"); `prepareQuestion(` in `replay.ts` is the model: `visitorTenantState`, `openStatus`, `recentMessages(..., upToSeq, HISTORY_LIMIT)`, `rulesInForce`.
- **`answerStep`** takes `meta: { tenantId, coachingSessionId }` hard-coded; the gateway's `meta` also takes `conversationId` and `turnId` (usage ledger, cost governor per conversation).
- **Takeover** (`inbox/ownership.ts`, FEAT-043): `takeOver`, `handBack`, `sendStaffMessage(tx, { tenantId, conversationId, userId, body, clientMessageId })` (owner check, `piiMask(body)`, idempotent on `clientMessageId`); routes in `apps/api/src/inbox.ts` (`replier(req)`, 409 `not_owner` with the summary).
- **Kill switch** (FEAT-057): `visitorTenantState(tx).aiPaused`; `aiPauseState` in governance.
- **Corrections** (`kb/corrections.ts`, FEAT-018/019): `ProposedChange` kinds; `answer_gap` carries no text and is accepted only with an `add_faq` edit (`editedChange`, `acceptCorrection`); source `staff_edit` and proposer `staff` already exist in the schema checks; `contextOf` in `apps/api/src/corrections.ts` loads the item's context (coaching, conversation excerpt, gap). The list row summary and decision texts are `lib/corrections.ts` (`fixSummary`, `itemSummary`, `acceptedLine`, `closedLine`, `noReplayCaption`).
- **Dashboard dock** (`pages/takeover-dock.tsx`): `TakeoverBar` (mode `ai`), `Composer` (mode `mine`: textarea `rows={2}`, `reply.mutate({ body, clientMessageId })`), `OwnedBar`; actions from `DockActions`.
- **Fact chips**: contract `FactChip`, kb `factChips(tx, tenantId, ids)`.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: suggested replies (INB-03; FEAT-045 §3)`)

**New:**
- `SuggestionNone = z.enum(['no_checked_answer', 'unavailable'])`: why there is no draft (`no_checked_answer`: the reply failed the checks twice, or the plan had nothing to answer, or the outcome was unsure/out of scope; `unavailable`: no facts matched, or the model or retrieval failed).
- `Suggestion = z.object({ id: z.uuid(), text: z.string(), facts: z.array(FactChip), forMessageId: z.uuid(), forSeq: z.int(), language: z.enum(['en', 'zh']), createdAt: z.iso.datetime({ offset: true }) })`.
- `SuggestionResponse = z.object({ suggestion: Suggestion.nullable(), none: SuggestionNone.nullable() })` (exactly one is non-null; refine).
- `SuggestionRequest = z.object({}).strict()`.

**Changed:**
- `StaffMessageBody` gains `suggestionId: z.uuid().optional()` (still strict).
- `ProposedChange` gains `z.object({ kind: z.literal('reply_edit'), suggestionId: z.uuid() })`: no text (the texts stay on the suggestion and the message, which are conversation-keyed, D6); accepted only with an `add_faq` edit, like `answer_gap`.
- `CorrectionItem` gains `replyEdit: z.object({ question: z.string() }).nullish()` (the visitor's question, masked, for the list row).
- `CorrectionContext` gains `replyEdit: z.object({ question: z.string(), suggested: z.string(), sent: z.string(), suggestedAt: z.iso.datetime({ offset: true }), sentAt: z.iso.datetime({ offset: true }), facts: z.array(FactChip) }).nullable()` (null when the suggestion or message is gone).

**Routes** (`apps/api/src/inbox.ts`; all `replier(req)`, session tenant only):

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/v1/conversations/:id/suggestion` | `SuggestionRequest` | 201 `SuggestionResponse` | 404 not found (other tenant too); 409 `not_owner` (with `conversation`, as FEAT-043); 409 `ai_paused` "The assistant is paused, so it can't suggest replies."; 409 `nothing_to_answer` "There's no customer message to answer yet."; 429 `too_many_suggestions` with `Retry-After` (D5) |
| `POST /api/v1/conversations/:id/messages` (changed) | `StaffMessageBody` with optional `suggestionId` | as FEAT-043 | as FEAT-043; an unknown, used or other-conversation `suggestionId` is ignored (the message is still sent, no correction; D7) |

## 4. Schema changes (migration `0046_suggestions.sql`; Drizzle DDL, then hand-written RLS, grants and checks in the same file)

- **`suggestions`**: `tenant_id uuid not null → tenants`, `id uuid default gen_random_uuid()`, `conversation_id uuid not null` (FK `(tenant_id, conversation_id) → conversations`, `on delete cascade`), `for_message_id uuid not null` (the visitor message answered; FK to `messages` `(tenant_id, id)`, cascade), `requested_by uuid not null` (user ID, no FK across zones, as `conversation_owners.user_id`), `outcome text not null` check in (`ready`, `no_checked_answer`, `unavailable`), `body text` (null unless `ready`; check `(outcome = 'ready') = (body is not null)`), `fact_ids uuid[] not null default '{}'`, `language text not null` check in (`en`, `zh`), `status text not null default 'open'` check in (`open`, `sent`, `sent_edited`, `superseded`), `sent_message_id uuid` (FK `(tenant_id, sent_message_id) → messages`, `on delete set null (sent_message_id)`, the PG 15+ column list, so `tenant_id` stays), `used_at timestamptz` (check `(status in ('sent', 'sent_edited')) = (used_at is not null)`), `created_at timestamptz not null default now()`. PK `(tenant_id, id)`; index `(tenant_id, conversation_id, created_at desc)` (rate limit, latest).
- Forced RLS, policy `tenant_id = current_setting('app.tenant_id')::uuid`; grants select, insert, update (`status`, `sent_message_id`, `used_at`) to `app_dashboard` only (the visitor zone never sees drafts, ADR-009). Name in `TENANT_SCOPED_TABLES`; RLS case in `packages/db/test/rls.int.test.ts`.
- `corrections`: no column change; `proposed_change` jsonb carries `reply_edit`. A partial unique index `corrections_reply_edit_uq` on `(tenant_id, (proposed_change->>'suggestionId'))` where `proposed_change->>'kind' = 'reply_edit'` (one item per suggestion, idempotent sends).
- Masking: the suggestion body holds only model text rendered from facts; it goes through `piiMask` before insert anyway (ADR-015, defence in depth).

## 5. Component design

### 5.1 Agent: `suggestReply` (`packages/agent/src/suggest.ts`, exported from the index)

`suggestReply(deps: SuggestDeps, input: { tenantId, conversationId, userId }): Promise<SuggestionRow>`; `SuggestDeps = { zdb (dashboard zone), llm, clock?, channelLive? }`.
1. **Prepare** (one dashboard-zone transaction, the `prepareQuestion(` pattern): lock-free read of the conversation (404 → `ConversationNotFoundError`); owner must be `userId` (inbox `ownerOf`) else `NotOwnerError`; `visitorTenantState` → `aiPaused` → `SuggestPausedError`; the latest visitor message (`latestVisitorMessage`, new in inbox) else `NothingToAnswerError`; rate limit (D5) → `TooManySuggestionsError(retryAfterS)`; `rulesInForce`, hours as replay (D4: now); history = `recentMessages(upToSeq: latest message seq, HISTORY_LIMIT)` (visitor → `user`, AI and staff → `assistant`; notices and system rows left out, as the visitor turn).
2. **Plan and retrieve** in parallel: `triage(llm, { history, meta, tail: triageTail(rules) })`, `search` over the visitor question text with `searchCoachingFacts(..., { includeUnreviewed: false })` (approved only, D3); `applyBoundary`.
3. **Dispatch** with `replayRegistry` and `ReplayPorts(0)` (no side effects: a suggestion never escalates, captures a lead or flags, ADR-025). A safety `endTurn` → outcome `no_checked_answer` (staff handle crises themselves; the AI's fixed text isn't a staff draft).
4. **Answer** with `answerStep` (refactored to take `meta` from the caller: `{ tenantId, conversationId, turnId: suggestionId }`, D2), so routing (ADR-007), compose, render, verify, leak and boundary guards are the visitor turn's own (INB-03 "same AGT-02 checks"). Outcome `answered` → `ready` with the text; `escalated`/`unsure`/`out_of_scope`/`refused` → `no_checked_answer`; `unavailable`/`gate_closed`/no plan or facts → `unavailable`. Nothing is published.
5. **Store** (dashboard zone): mark earlier `open` suggestions of the conversation `superseded`; insert the row; audit `inbox.suggestion.created` `{ outcome, factIds, tasks, route }` (codes and IDs only, ADR-014), actor the user, subject the conversation, related the suggestion.

### 5.2 Inbox: use on send (`packages/inbox/src/suggestions.ts`)

- `latestVisitorMessage(tx, tenantId, conversationId)`.
- `recordSuggestionUse(tx, { tenantId, conversationId, userId, suggestionId, message })`, called by the messages route in the send transaction after `sendStaffMessage` returned `created: true`: loads the suggestion `for update`; ignores it unless same conversation, `outcome = 'ready'` and `status = 'open'` (D7); `edited = normalise(message.body) !== normalise(piiMask(s.body))` where `normalise` lowercases, collapses whitespace and drops trailing punctuation and emoji (D8); sets `status` `sent`/`sent_edited`, `sent_message_id`, `used_at`; unedited → copies `fact_ids` onto the staff message (`messages.fact_ids`, so the sidebar's "Facts used" counts it, ADR-008: checked text); audit `inbox.suggestion.sent` `{ edited }`. Returns `{ edited }`.
- Edited → the route calls kb `proposeReplyEdit` in the same transaction (§5.3). Module boundaries: the API orchestrates inbox and kb; neither imports the other.

### 5.3 KB: the `reply_edit` proposal (`packages/kb/src/corrections.ts`)

- `ProposedChange` + `{ kind: 'reply_edit'; suggestionId: string }`.
- `proposeReplyEdit(tx, { tenantId, userId, conversationId, suggestionId, factIds })`: inserts an open correction `source_type 'staff_edit'`, `proposed_by 'staff'`, `conversation_ref`, `fact_refs = factIds` (the facts the draft used, so the item lists them), `created_by userId`; `on conflict do nothing` on `corrections_reply_edit_uq`; audit `correction.proposed` `{ kind: reply_edit, sourceType: staff_edit, factIds }`.
- `editedChange`: `add_faq` on `reply_edit` → `faqChange(question, answer)` (the `answer_gap` rule); `acceptCorrection` refuses `reply_edit` without an edit (`InvalidCorrectionError`), `applyChange` throws for it as for `answer_gap`.
- API `apps/api/src/corrections.ts`: `contextOf` adds `replyEdit` (suggestion body, the sent message body, the question message body, times, `factChips`); the list's `replyEdit.question`; `coach.ts`'s exhaustive switch (`case 'answer_gap'`) gains `reply_edit` (no coaching rendering).

### 5.4 API (`apps/api/src/inbox.ts`)

- `POST /suggestion` → `suggestReply` with the dashboard zone and the gateway, maps errors per §3; response `facts` via `factChips` on the row's `fact_ids`. Synchronous (D1): the dashboard shows "Writing a suggestion…" (median ~3–5 s on Haiku/Sonnet; fake provider in tests).
- `POST /messages`: parses `suggestionId`; inside the existing `withTenant` transaction, after `sendStaffMessage` (`created`), runs `recordSuggestionUse` and, when edited, `proposeReplyEdit`. A retry (`created: false`) does neither again.

### 5.5 Dashboard (detail in ui-design.md)

- `lib/api.ts` `suggestReply(id)`; `reply` mutation passes `suggestionId`.
- `lib/suggestion.ts` (pure): `noneText(none)`, `isStale(suggestion, latestVisitorSeq)`, `sendBody(text, suggestionId)`; unit tests.
- `takeover-dock.tsx`: `TakeoverBar` gains `Suggest a reply` (secondary): take over, then request a suggestion; `Composer` gains `Suggest a reply` (ghost, when empty or holding a suggestion: "Suggest again"), the suggestion label and caption, 5-line height while holding a suggestion (A2), stale notice, the none alert; keeps `suggestionId` until the text is cleared or sent.
- `correction.tsx`/`corrections.tsx` and `lib/corrections.ts`: the `reply_edit` row and item (`fixSummary`, `itemSummary`, `acceptedLine`, `noReplayCaption`, decision label "FAQ added").

### 5.6 Evals (`evals/cases/feat-045-suggest.json`)

Suggestion cases run through `suggestReply`'s answer path on the fake provider: a price question → `ready` with the slot-rendered price; an adversarial literal price twice → `no_checked_answer` (never shown); a blocked topic → `no_checked_answer`; a crisis message → `no_checked_answer`; a Chinese question → Chinese draft. Thresholds unchanged.

### 5.7 E2E (`e2e/tests/suggested-reply.e2e.ts`)

Dev tenant, an AI-handled conversation with a price question: Suggest a reply from the takeover bar → taken over, the composer holds the draft with the label; edit and Send → the widget shows the staff message; Review · Corrections lists "Staff edit" and the item shows suggested vs sent; Add FAQ prefilled. Axe at 375 × 5000 and 1280.

## 6. Acceptance criteria

- **AC-1** (INB-03 "AI-suggested replies for staff", UC-23 4) The owner of a conversation who presses Suggest a reply gets a draft in their composer that answers the visitor's latest message in the visitor's language, with the facts it used; nothing is sent to the visitor, published on the conversation channel or stored as a message.
- **AC-2** (INB-03 "pass the same AGT-02 checks") The draft is produced by the visitor turn's compose path (slot render, verifier, leak and boundary guards, regeneration once); a model output with a literal price or a blocked topic yields no draft (`no_checked_answer`), never the unchecked text; only approved, in-date facts are retrieved (a `needs_review` fact never appears).
- **AC-3** (INB-03 "draft only… staff can edit and then send") The draft is editable; Send sends the composer's text through FEAT-043's send path; an unedited draft's message carries the draft's fact IDs; an edited one carries none.
- **AC-4** (KB-18 "staff edits to AI-suggested replies", UC-23 4a) Sending an edited draft adds one open `Staff edit` correction (`reply_edit`, the draft's facts, the conversation) in the same transaction; an unedited draft, a whitespace/case-only change, a retried send or a second send of the same suggestion adds none; the item shows the question, the draft and the sent reply side by side and is accepted only as an FAQ (prefilled), or closed with no change.
- **AC-5** (UC-23 3–4, design.md §4.6) Suggest a reply while the AI holds the conversation takes it over (FEAT-043 rules: the visitor sees "staff joined") and then drafts; a staff member who doesn't own the conversation gets 409 `not_owner`; with the AI paused (GOV-08) the control is disabled and the route returns 409 `ai_paused`; a conversation without a visitor message returns 409 `nothing_to_answer`.
- **AC-6** (D5, cost) More than 10 suggestions for one conversation in an hour returns 429 with `Retry-After`; each suggestion's model calls are metered on the conversation (usage ledger `conversationId`).
- **AC-7** (ADR-005, ADR-009, ADR-014, ADR-015) `suggestions` has forced RLS (tenant B sees and writes nothing of A's) and no visitor-zone grant; both routes are 404 across tenants; audit payloads carry IDs and codes only; suggestion bodies are masked.
- **AC-8** (SCR-APP-015, SCR-APP-021, SCR-APP-022, NFR-09, NFR-19) The takeover bar's Suggest a reply, the composer's writing, holding, stale, none and error states, and the corrections row and item render as in ui-design.md; at 375 px nothing scrolls sideways; axe reports no serious violations.
- **AC-9** (AGT-14) `pnpm eval --fast` passes with the §5.6 cases and unchanged thresholds.

## 7. Decisions

- **D1 — Synchronous in the API, like replay.** A draft is wanted while the staff member waits on the screen; a request/response with a busy state is simpler and testable, and replay (FEAT-028) set the precedent against ADR-026's "agent-worker keeps suggested replies". No queue, no realtime event. Recorded for an ADR-026 note (§8). Rejected: a worker job plus a `member` WS event (two moving parts for one person's draft).
- **D2 — One answer path.** `answerStep` takes its `meta` from the caller so suggestions, coaching and replay share it; nothing is copied from `turn.ts`. The suggestion is metered on its conversation (`conversationId`), so the per-tenant cost governor sees it.
- **D3 — Approved facts only, from the dashboard zone.** `searchCoachingFacts` with `includeUnreviewed: false` applies the `visitor_facts` filter (approved, in-date, GST-known); the label says "checked against your facts" and only approved facts reach visitors (ADR-010). Rejected: the visitor zone (the API holds no visitor-zone pool for dashboard requests; replay set the same rule).
- **D4 — The draft answers the latest visitor message, with the whole recent thread as history**, under today's rules and hours (what the AI would say now). Staff and AI messages are both `assistant` turns.
- **D5 — At most 10 suggestions per conversation per rolling hour.** Each costs a triage and a reply call; 10 covers Suggest again on a long chat. Counted from `suggestions.created_at`.
- **D6 — The correction carries no text.** `reply_edit { suggestionId }` keeps visitor and staff wording in conversation-keyed rows (`suggestions`, `messages`) that PDPA deletion removes (ADR-015), as FEAT-019 D3 did for gaps. Accepting needs the owner's FAQ, prefilled from the question and the sent reply. A wrong fact is fixed from the item's fact chips (Knowledge), then the item closed.
- **D7 — A bad `suggestionId` never blocks a send.** Sending is the staff member's action; a stale, used or foreign ID only means no correction and no fact IDs.
- **D8 — "Edited" ignores case, whitespace, trailing punctuation and emoji.** A changed price, date or sentence counts; "Hi" → "hi" or a removed trailing "!" doesn't. Every real edit is proposed; the owner closes the ones that teach nothing (KB-18 "nothing changes the KB until accepted").
- **D9 — Paused AI, no suggestions.** The kill switch (GOV-08) stops the AI's output everywhere; a draft from a paused assistant would bypass it. The control is disabled with "The assistant is paused".
- **D10 — Suggest from the takeover bar takes over first.** design.md §4.6 and the anchor: drafts belong to the person who will send them, and FEAT-043's single-owner rule decides who that is. The two calls are sequential in the client; a take-over conflict stops before any model call.

## 8. Escalations and open items

- ADR-026 says the agent-worker runs suggested replies; D1 runs them in the API (as replay already does). Recorded here for the next architecture revision; no ADR change.
- Plan row screens: SCR-APP-021 (p) and SCR-APP-022 (p) are added for the staff-edit item (KB-18); recorded for the plan's next revision and the RTM Design ref.
- UC-23 4a's other producer, "the staff answer fills a KB gap" (`staff_reply`), isn't in INB-03; it stays open for a later feature (KB-18 partial).
- Saved replies and internal notes in the composer are FEAT-047; the composer's layout leaves room for them.
- ADR-008 point 7 (highlight a typed literal price that doesn't match the KB) is not in INB-03 and not built here; FEAT-047 or a later inbox feature should take it.
- PDPA deletion of a conversation cascades to `suggestions`; the item's context then shows "The chat this came from was deleted" (FEAT-019's closed-automatically path is for gaps only; the deletion feature closes `reply_edit` items too).

## 9. Self-check

- INB-03's clauses → AC-1 (suggestions for staff), AC-2 (same checks), AC-3 (draft only, edit, send); KB-18's staff-edit producer → AC-4; UC-23 4 → AC-1, AC-3, AC-5; 4a → AC-4.
- One new tenant table with forced RLS, a policy, a `TENANT_SCOPED_TABLES` entry and an RLS case; dashboard-zone grants only; tenant ID from the session.
- ADR-025: the suggestion's plan runs through the dispatcher with stubbed ports (no side effects); a tool call is never acted on. ADR-008: the draft's text is renderer-filled and verified; unedited sends carry fact IDs, edited ones don't. ADR-010: corrections are proposals; facts change only on acceptance. ADR-013: the send gate is irrelevant to drafts (nothing is sent by the AI); the kill switch still stops them (D9).
- Audit entries carry IDs and codes only (ADR-014); bodies masked (ADR-015).
- UI uses design.md's `composer` (takeover bar, suggestion label, A2 height), `button`, `alert`, `chip`, `correction-item`, fact chips; tokens only.

Traceability: INB-03 → AC-1–AC-3, AC-5, AC-8; KB-18 (p) → AC-4; UC-23 4, 4a → AC-1, AC-3–AC-5; ADR-005/009/014/015 → AC-7; AGT-14 → AC-9; screens → AC-8. IDs checked: INB-03, KB-18, AGT-02, AGT-14, GOV-08, UC-23, SCR-APP-015, SCR-APP-021, SCR-APP-022, NFR-09, NFR-19, ADR-005, ADR-007, ADR-008, ADR-009, ADR-010, ADR-013, ADR-014, ADR-015, ADR-025, ADR-026, FEAT-018, FEAT-019, FEAT-028, FEAT-043, FEAT-047, FEAT-057 resolve.
