# Technical design: FEAT-051 — Consent withdrawal in any channel

> Implements: LED-07, LED-05 (completes it: leads with withdrawn consent are left out of the CSV export), LED-06 (p: the "excluded from webhooks" seam only; webhooks are FEAT-053), GOV-05 (p: a deletion request is routed to the team as an escalation until FEAT-061's data-subject requests), AGT-14 (p: the withdrawal cases in EN, Singlish and Chinese) · Realizes: UC-28 steps 1–3, 1a (staff record it) and 2a (p: routed, FEAT-061 opens the request) · Screens: SCR-WGT-003 (p: withdrawn), SCR-APP-033 (p: consent withdrawn, record withdrawal), SCR-APP-032 (p: the list's withdrawn chip, export note), SCR-APP-014 (p: the sidebar's withdrawn line), SCR-APP-056 (p: the new alert toggle) (see [ui-design.md](ui-design.md)) · Module: `leads`, `agent`, architecture §5.2, ADR-005, ADR-009, ADR-011, ADR-012, ADR-014, ADR-015, ADR-022, ADR-025
> Status: designed · 2026-11-07

## 1. Intent

A visitor who writes "pls don't keep my number", "stop contacting me" or 别再联系我 gets a confirm card from the assistant: stop all use of their details, or (when they opted in to offers) just stop offers (D1). Confirming records the withdrawal against their contact, marks the lead "consent withdrawn", takes it out of every leads export at once, and alerts the team. Staff can record a withdrawal the contact asked for in person or by phone (UC-28 1a) on the Lead page. A request to delete their data is passed to the team as an escalation until FEAT-061 opens a data-subject request. Nothing is ever un-withdrawn by staff: only the contact consenting again, in a later chat, makes the lead usable again.

## 2. Codebase context

- **Consents** (`packages/db` 0048, leads `consent.ts`, FEAT-049): append-only rows `purpose` `enquiry` | `marketing`, `decision` `agreed` | `declined`, `wording_id` (not null), `channel` `widget`, `contact_id` set on capture, `conversation_id`. `consents_declined_ck` forbids a contact on a declined enquiry row. Visitor zone: SELECT, INSERT, UPDATE (`contact_id`); dashboard zone: SELECT only. `consentState(tx, tenant, conversation)` gives the conversation's latest enquiry decision, the latest granted consent, `offered`, `captured`.
- **Leads** (FEAT-050): `leadSelect` (`list.ts`) joins the lead's enquiry consent and a lateral latest marketing row of the contact; `toLeadRow`, `leadDetail` (every consent with its wording). `export.ts` `exportable(row)` is the seam this feature fills; `exportLeads` filters with it; `auditExport` writes `lead.exported`. `captureLead` (`capture.ts`) checks the consent is an agreed enquiry row, resolves the contact (email, then phone), sets `consents.contact_id` and `conversations.contact_id`, upserts the one open lead, rescoring and the hot-lead alert.
- **Agent** (code-map "Agent pipeline"): `withdraw_consent` and `data_request` are already `TaskKind`s, in `PHASE` as state tasks, described in `TRIAGE_SYSTEM` and matched by `fake-triage.ts`, but have no handler (`unhandled`). `captureLeadHandler` shows the card pattern: a handler returns `card` and `reply.key`, writes nothing; the widget's button does the write. `cardForReply`/`LeadState` (`lead.ts`) is the offer rule. `ConversationPort` is implemented by `runVisitorTurn` and in memory by the eval runner.
- **Alerts** (`@kaki/platform/notifications`): `ALERT_EVENTS` (`escalation`, `approval_pending`, `hot_lead`) drive the My notifications toggles (dashboard `lib/notifications.ts` labels), `templates.ts` subjects and bodies, `links.ts` `linkFor`. Recipients from `escalation_candidates()`.
- **Widget** (FEAT-049): `cards.tsx` `LeadCard`, `chat.ts` `activeCard`, `api.ts` `consent`/`submitLead` returning `LeadResult`; the consent card's footer already says "You can withdraw consent at any time by telling us here."
- **Conversations** carry `visitor_id` (the widget token's visitor), so a returning visitor's earlier conversations are findable without any identifier from the message.

## 3. API contracts (`packages/contracts/src/index.ts`)

Extend existing shapes, then a new section at the end `// ---- Consent withdrawal (LED-07; FEAT-051 §3)`.

- `WithdrawScope = z.enum(['all', 'marketing'])`.
- `MessageCard` gains `{ kind: 'withdraw', offers: z.boolean() }`: `offers` = the contact's latest marketing answer is `agreed`, so the card shows "Just stop offers".
- `Message.noticeKind` gains `consent_withdrawn`.
- `LeadMarketing` becomes `{ agreed, at, withdrawn: boolean }` (`withdrawn` = the latest marketing row is a withdrawal; `agreed` is then false).
- `LeadRow` gains `consentWithdrawnAt: iso | null` (the contact's latest enquiry row is a withdrawal; §5.1).
- `LeadConsentRecord`: `decision` gains `withdrawn`, `channel` gains `dashboard`, `wording` becomes nullable (withdrawals show no wording), new `recordedBy: string | null` (the staff member's name for a dashboard withdrawal).
- `LeadSummary.consent` gains `withdrawnAt: iso | null` (inbox sidebar).
- `AlertEvent` gains `consent_withdrawn` (so `NotificationPrefs` carries the toggle).

Widget:

```
POST /widget/v1/conversations/:id/withdraw        (visitor token; ownConversation)
  body  WithdrawBody      = strictObject({ messageId: uuid, scope: WithdrawScope })
  201   WithdrawResponse  = { status: 'withdrawn' | 'already_withdrawn' | 'nothing_held', notice: Message | null }
  404   the message isn't this conversation's agent message carrying a withdraw card
  422   { error: 'scope_not_offered' }  scope 'marketing' on a card with offers false
```

Dashboard:

```
POST /api/v1/leads/:id/withdraw                   (session; leads.manage: Owner, Admin)
  body  LeadWithdrawBody  = strictObject({ scope: WithdrawScope })
  200   LeadDetail        (already withdrawn → 200 with the unchanged detail, idempotent)
  403   not leads.manage · 404 other tenant or unknown · 422 { error: 'scope_not_offered' } (marketing, nothing agreed)
```

`POST /api/v1/leads/export` is unchanged in shape; withdrawn leads are left out and the audit payload gains `excluded` (count).

## 4. Schema changes (migration `0052_consent_withdrawal.sql`)

- `consents`: `CONSENT_DECISIONS` + `withdrawn`; channel check `widget` | `dashboard`; `wording_id` nullable with `consents_wording_ck` `(decision = 'withdrawn') = (wording_id is null)`; new `recorded_by uuid` with `consents_recorded_by_ck` `(channel = 'dashboard') = (recorded_by is not null)`; `consents_withdrawn_ck` `decision <> 'withdrawn' or contact_id is not null`; `consents_declined_ck` becomes `decision in ('agreed', 'withdrawn') or contact_id is null or purpose = 'marketing'`. Index `consents_contact_latest_idx (tenant_id, contact_id, purpose, created_at desc)` for the lateral lookups.
- Grants: `INSERT ON consents TO app_dashboard`, with a **restrictive** insert policy for `app_dashboard`: `decision = 'withdrawn' and channel = 'dashboard'` (the 0043 `messages` pattern), so the dashboard can never write an agreement. The visitor zone keeps its grants; a restrictive insert policy for `app_agent_visitor` refuses `channel = 'dashboard'`.
- `messages_card_ck`: card kinds + `withdraw`. `NOTICE_KINDS` + `consent_withdrawn` (messages notice check).
- `ALERT_EVENTS` + `consent_withdrawn` (so `NOTIFICATION_KINDS` and `notifications_kind_ck`, and any prefs check over alert events, widen).
- `ESCALATION_SOURCES` + `data_request` (`escalations_source_ck`).
- No new table: the RLS suite gains cases (dashboard can insert only a dashboard withdrawal; visitor can't insert a dashboard row; tenant B can't insert for tenant A's contact).

## 5. Component design

### 5.1 Consent state of a contact (`leads/consent.ts`)

- The contact's state per purpose is its **latest row with that contact** (`agreed`, `declined` or `withdrawn`). A full withdrawal is an `enquiry` row `withdrawn`, plus a `marketing` row `withdrawn` when the latest marketing row was `agreed`; a marketing-only withdrawal is a `marketing` row `withdrawn`.
- `leadSelect` adds a lateral latest enquiry row of the contact → `consent_withdrawn_at` (its time when it is a withdrawal, else null) and the marketing lateral returns `withdrawn`. A new agreed consent captured later (it gets `contact_id` on capture) becomes the latest row, so the lead is usable again with no staff action.
- `consentState` changes: `enquiry` may be `withdrawn` (a withdrawal row in this conversation); `consentId` is the latest enquiry row in this conversation only if it is `agreed` **and** newer than the contact's latest full withdrawal; new `withdrawn: boolean` (the conversation's contact is currently withdrawn). So `capture_lead` after a withdrawal shows the consent card again, never the form.
- `captureLead` refuses a consent older than the contact's latest full withdrawal with `ConsentWithdrawn` → the existing 409 `consent_required`, which the widget already answers with a fresh consent card (FEAT-049 ui-design).

### 5.2 Withdraw (`leads/withdraw.ts`, new)

- `withdrawalTarget(tx, tenantId, conversationId)` → `{ contactId, offers, withdrawn } | null`: the conversation's `contact_id`, else the newest contact of the same `visitor_id`'s other conversations in this tenant; null when neither (nothing held from this visitor). Runs in either zone.
- `withdrawConsent(tx, { tenantId, contactId, scope, channel, conversationId, recordedBy })` → `{ status: 'withdrawn' | 'already_withdrawn', consentIds }`: locks the contact row (`select … for update`, so two presses or a press and a staff click write once), reads the state of §5.1, and inserts only what changes (`all` when already fully withdrawn, or `marketing` when the latest marketing isn't `agreed` → `already_withdrawn`, nothing written). Then, in the same transaction:
  - audit `consent.withdrawn` `{ contactId, scope, channel, consentIds }` (IDs and codes only, ADR-014), actor `visitor` or the staff user;
  - `notify` kind `consent_withdrawn` to the active members (`escalation_candidates()`), not urgent, subject `lead` = the contact's newest lead, `dedupeKey` `consent_withdrawn:<first consent id>`; a staff-recorded withdrawal leaves out the member who recorded it;
  - on `all`: `cancelNotifications` for the contact's leads' pending `hot_lead` alerts.
- Exclusion is immediate: `exportable(row)` is `row.consent_withdrawn_at === null`, and an export reads after the withdrawal commits. LED-07's "within 1 minute" is met by construction (no queue in the path). `exportLeads` returns the excluded count for the audit.
- Webhooks (LED-06) are FEAT-053's: its sender must evaluate `exportable` on the lead **when it sends**, not when it enqueues, so a withdrawal between the two drops the delivery. Recorded in code-map and §8.

### 5.3 Agent (`packages/agent`)

- `withdrawConsentHandler` (`dispatch.ts`, beside `captureLeadHandler`): `scopes: ['visitor']`, args `{}` (`.catch({})`), no consent check, no boundary. `run` calls the new `ConversationPort.withdrawalOffer()` → `{ held, offers, withdrawn }` and returns: held and not withdrawn → `card { kind: 'withdraw', offers }`, reply `withdraw_confirm`; withdrawn → reply `withdraw_already`; not held → reply `withdraw_none`. It writes nothing: the visitor's button is the confirmation (UC-28 step 2; the model interprets, code acts, ADR-025).
- `dataRequestHandler` (interim, until FEAT-061 replaces its `run`): `ConversationPort.escalate('data_request')` and reply `data_request`. A message with both (e.g. "stop using and delete my details") gets the withdraw card and the escalation.
- `runVisitorTurn` implements `withdrawalOffer` with leads `withdrawalTarget` on the visitor zone; `escalate` accepts the new source. The eval runner's in-memory port takes the case's `contact` state (§5.6). Replay and coaching never run it (`stubAll` drops both; coaching's explainer says `visitorsWouldGet: 'withdraw'` like `approval`).
- `LeadState` gains `withdrawn`; `cardForReply` never offers the consent card when `withdrawn` (any earlier withdrawal in the conversation already blocks it through `enquiry`).
- Texts (`texts.ts`, en and zh, persona-neutral): `withdraw_confirm` "Sure. Do you want {business} to stop using your contact details? Choose below.", `withdraw_already` "You've already asked {business} to stop using your details, and they have.", `withdraw_none` "{business} doesn't have contact details from you in this chat. If you gave them another way, tell the team and they'll stop using them.", `data_request` "I've passed your request about your personal data to the {business} team. They'll get back to you." Fixed texts, no reply-model call when the plan has no `answer` task (`replyPlan` rule 1).
- `fake-triage.ts`: the `withdraw_consent` rule covers "stop using my (details|number|data|info)", "don't keep my (number|details)", "pls don't (call|contact|whatsapp|message) me", "unsubscribe", "no more (promo|promotions|offers)", 不要再联系, 别再联系, 不要用我的(资料|电话|号码), 取消订阅, 不要再发; `capture_lead` no longer fires on a message the withdraw rule matched ("don't contact me" contains "contact me").

### 5.4 API (`apps/api`)

- `leads-widget.ts`: `POST /widget/v1/conversations/:id/withdraw` in one visitor-zone transaction: `ownConversation`, the message check, `withdrawalTarget`, `withdrawConsent` (channel `widget`, `conversation_id` the current one), then the stored system notice `consent_withdrawn` (the existing `notice` helper) with the scope's text: all "Done. {business} will stop using your contact details and won't contact you." / marketing "Done. {business} won't send you offers. They can still reply about your enquiry." `already_withdrawn` stores no second notice and returns `notice: null`; `nothing_held` writes nothing. The inbox is published as for `lead_captured`.
- `leads.ts`: `POST /api/v1/leads/:id/withdraw` → `leads.manage`, dashboard transaction, lead → contact, `withdrawConsent` (channel `dashboard`, `recordedBy` the session user, `conversation_id` null), returns `leadDetail`. No re-auth: it only narrows what the team may do, and can't be undone by staff (D3).
- `leadDetail` maps `recorded_by` to the member's name (identity `memberNames`).

### 5.5 Dashboard and widget

- Dashboard (ui-design): SCR-APP-033 danger alert, consent entries for withdrawals, "Record withdrawal" dialog (`api.withdrawLead`); SCR-APP-032 chip and export note; SCR-APP-014 sidebar line; SCR-APP-056 toggle (label in `lib/notifications.ts`, platform `templates.ts` subject "A contact withdrew consent" and body without PII, `links.ts` `/leads/:id`).
- Widget: `WithdrawCard` in `cards.tsx` (one component per carded message, like `LeadCard`), `activeCard` treats it as interactive while it is the latest card, `api.withdraw` returns a `WithdrawResult` value, strings en/zh in `strings.ts`.

### 5.6 Seed and evals

- Seed: none (seeded leads stay usable; E2E creates its own withdrawal).
- Evals `evals/cases/feat-051-withdrawal.json` (subset `multi-task`, `fast`): recognised in EN ("Please stop contacting me", "stop using my details"), Singlish ("pls don't keep my number lah", "dun call me again ok"), Chinese ("别再联系我了", "不要用我的电话") → `withdraw_consent`, card `withdraw` with a held contact; `offers` true when the case's contact agreed to offers; no contact → outcome text `withdraw_none`, no card; "delete my details" → `data_request` escalated; negatives that must not withdraw ("stop the delivery on Friday", "don't call before 10am, my number is 9123 4567" → `capture_lead`). The runner gains an optional case field `contact: { held, offers, withdrawn }` for the port if it has none. AGT-14 thresholds unchanged (the cases count toward the subset).

## 6. Acceptance criteria

- **AC-1** (LED-07 "recognises the request"; AGT-14 "withdrawal cases in EN, Singlish and Chinese"; UC-28 1–2) The eval set's withdrawal cases pass on the fake provider: each EN, Singlish and Chinese phrasing plans `withdraw_consent` and gets the withdraw card; the negatives don't.
- **AC-2** (LED-07 "confirms it"; UC-28 2; ADR-025) A `withdraw_consent` turn writes no consent row: it stores the agent reply with a `withdraw` card (`offers` true only when the contact's latest marketing answer is agreed); a visitor with no contact in this or an earlier conversation gets `withdraw_none` and no card; an already withdrawn contact gets `withdraw_already`.
- **AC-3** (LED-07 "records the withdrawal; the lead is marked consent withdrawn"; UC-28 3) Confirming `all` inserts the enquiry withdrawal (and a marketing withdrawal when offers were agreed) for the contact, stores the `consent_withdrawn` notice, audits `consent.withdrawn` with IDs only; `GET /leads/:id` then has `consentWithdrawnAt` and the records; a second press returns `already_withdrawn` and writes nothing; concurrent presses write once.
- **AC-4** (D1) Confirming `marketing` inserts only a marketing withdrawal: `marketing.withdrawn` true, `consentWithdrawnAt` null, the lead still exports with Marketing consent `No`; `marketing` on a card with `offers` false → 422.
- **AC-5** (LED-07 "the tenant is alerted") A withdrawal writes one `consent_withdrawn` notification per active member in its transaction (staff-recorded: not to the recorder), deduped; a full withdrawal cancels the contact's pending `hot_lead` alerts; the email has no name, phone or email.
- **AC-6** (LED-05 "leads with withdrawn consent are excluded from exports"; LED-07 "within 1 minute … excluded from exports") An export right after a full withdrawal commits leaves the lead out and audits `excluded: 1`; the list still shows the lead with the withdrawn chip.
- **AC-7** (UC-28 1a) An Owner or Admin records a withdrawal on the Lead page: channel `dashboard`, `recordedBy` their name, same exclusion and alert; an Agent gets 403; tenant B gets 404 for tenant A's lead; the dashboard zone can't insert an `agreed` consent (RLS).
- **AC-8** (re-consent) After a full withdrawal, `capture_lead` in a conversation shows the consent card, not the form; a lead submit with a consent older than the withdrawal → 409 `consent_required`; a new consent and capture make the lead exportable again.
- **AC-9** (LED-07 "a deletion request is routed to GOV-05"; UC-28 2a, partial) A deletion request plans `data_request`, escalates the conversation with source `data_request` and replies with the fixed text; with a withdrawal in the same message both happen.
- **AC-10** (SCR-WGT-003 withdrawn; SCR-APP-033) The widget card's states (asked, sending, withdrawn, offers stopped, kept, failed) and the Lead page's withdrawn alert and dialog match ui-design and pass axe (E2E in CI).

## 7. Decisions

- **D1 — The confirm card offers "Stop all use" and, when the contact agreed to offers, "Just stop offers"** (recommended to Ken 2026-11-07, decision card open). "Stop sending promos" usually still wants the enquiry answered, and the card lets the visitor say which, so triage needn't guess. Only a full withdrawal marks the lead "consent withdrawn" and drops it from exports; marketing-only sets Marketing consent to No.
- **D2 — Who the withdrawal applies to comes from the conversation, never from the message.** The conversation's contact, else the same browser's earlier contact (`visitor_id`). The visitor isn't asked for an email or phone: matching typed identifiers would let anyone withdraw someone else's consent and reveal whether a contact exists. A visitor we can't link is told so, and staff record it on the Lead page when asked another way (UC-28 1a).
- **D3 — Staff can record a withdrawal, never undo one.** Only the contact consenting again in a later chat makes the lead usable again. No re-auth: the action only narrows what the team may do.
- **D4 — Withdrawn leads stay in the list,** with a chip, so the team sees the history and doesn't re-enter them; they never leave the platform (export, later webhooks).
- **D5 — Deletion requests escalate until FEAT-061.** The plan lists `data_request` as escalated until data-subject requests exist; FEAT-061 replaces the handler's `run`, not the path.
- **D6 — One alert kind, `consent_withdrawn`, for both scopes,** a toggle on My notifications like `hot_lead`, held in quiet hours (not urgent).

## 8. Escalations and open items

- D1 is awaiting Ken's answer; if he picks "one withdrawal covers all", drop the `marketing` scope, `offers` and AC-4 (the rest stands).
- LED-06 webhooks: FEAT-053 must check `exportable` at send time (§5.2). LED-07's "excluded from webhooks" Test ref stays partial until then.
- GOV-05 / UC-28 2a: only the routing (escalation) lands here; FEAT-061 opens the data-subject request (SCR-APP-049).
- Other channels (Telegram FEAT-037, email, Meta): the handler, port and route are channel-neutral, but the confirm card is a widget card. Each channel adapter renders the `withdraw` card its own way (buttons or a "Reply YES" text) when it lands (ADR-011); noted for FEAT-037.
- SCR-APP-016 (Contact) lists consent records too; it is a later feature and reuses `LeadConsentRecord`.

## 9. Self-check

- LED-07 → AC-1–AC-3, AC-5, AC-6, AC-9; LED-05 withdrawn exclusion → AC-6; LED-06 → §8 (seam); GOV-05 routing → AC-9; AGT-14 → AC-1; UC-28 1–3 → AC-1–AC-3, 1a → AC-7, 2a → AC-9; D1 → AC-4; re-consent → AC-8.
- No new table; consents stay append-only; the dashboard's insert is limited by a restrictive policy; tenant from session or widget token only; RLS and cross-tenant cases added (ADR-005).
- The model only proposes: the handler returns a card; the visitor's button or staff action writes (ADR-025). Scope comes from the entry point (ADR-009).
- Audit entries carry IDs and codes only; alert emails carry no PII (ADR-014, ADR-015). Alerts are written in the withdrawal's transaction (ADR-012).
- UI uses design.md `alert`, `card`, `chip`, `confirm-dialog`, `radio`, `toast`, widget `consent-card` styling and `system-notice`; tokens only.
