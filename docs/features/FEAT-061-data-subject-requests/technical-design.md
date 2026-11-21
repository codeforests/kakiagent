# Technical design: FEAT-061 — Data-subject requests: find, export, correct, delete across stores

> Implements: GOV-05, LED-07 (p: "a deletion request is routed to GOV-05": the chat's `data_request` task now opens a data-subject request), AUTH-03 (p: "PDPA deletion" re-auth; DSR export re-auth), GOV-01 (p: "deleting a contact (GOV-05) leaves the chain verifiable") · Realizes: UC-30 (all steps, 1a, 2a, 4a, 4b), UC-28 (2a) · Screens: SCR-APP-048 (new), SCR-APP-049 (new), SCR-APP-047 (p: "Data requests" row) · ADRs: ADR-004, ADR-005, ADR-009, ADR-012, ADR-014, ADR-015, ADR-025
> Status: designed · 2026-11-20 (M5 autonomous run: decisions D1–D14 taken without Ken, logged in `docs/build/m5-decision-log.md`)

## 1. Intent

An Owner or Admin logs a PDPA request (access, correction or deletion) with the date it was received; the system sets the due date 30 calendar days later and alerts the Owner and Admins 7 days before it is due. They record how they verified the requester's identity (or close the request as unverified, with the reason), search by email, phone or Telegram ID, and see the matching data in every store: contacts, conversations and messages, leads, consents, approvals, email attachments, memory, tracking rows, linked audit personal data and KB items. Then they export it (JSON, re-auth), correct it (contact and lead fields, audited), or delete it (type-to-confirm, re-auth): one transaction removes it from primary storage, the audit PII is erased so the chain still verifies, files in S3 are removed by an outbox job, and backups age out within 35 days, which the page states. A visitor who asks the assistant to delete their data now opens such a request (it still escalates, as FEAT-051 did).

## 2. Codebase context

- **Governance is the bottom module** (`@kaki/contracts`, `@kaki/db`, `@kaki/platform` only; every module imports it). `governance.dsr.*` (plan §4, ADR-025's `data_request` row) therefore reads every store through `@kaki/db`'s schema directly and deletes only through one SQL function; it never imports inbox, leads, channels or kb.
- **App roles can't delete most rows** (messages, conversations, leads, consents are insert/update only). The established pattern for cross-store writes is a SECURITY DEFINER function owned by a NOLOGIN role with column grants, reading the tenant from `app_current_tenant()` (`contact_merge()` in `0055`, `conversation_move_channel()` in `0056`).
- **Stores holding a contact's data** (schema.ts, FK actions as built): `contacts` (+ rows with `merged_into` = it), `contact_identities`, `contact_merges`, `telegram_chats`, `handoff_links`, `consents`, `leads` (cascade from contact); `conversations.contact_id` (no cascade), and per conversation `messages`, `conversation_owners`, `escalations`, `approvals`, `suggestions`, `consents`, `email_messages`, `email_threads`, `message_deliveries`, `email_attachments` (+ S3 `object_key`), `handoff_links`, `conversation_summaries` (FEAT-026 asks for it), `corrections` of kind `reply_edit` citing those messages; `visitor_events` and `visitor_tracking_choices` by the conversations' `visitor_id` (FEAT-029 asks for it); `audit_pii` by `contact_id` (`audit.erasePii`, FEAT-002); KB `facts`/`fact_versions`/`kb_chunks` and `kb_staged_facts` only where their text holds the identifier (chat exports are redacted before mining, `ingest/chats/mine.ts`, so hits are rare). IDs-only stores kept: `audit_entries`, `usage_events`, `notifications`, `outbox`.
- **Seams waiting for this feature:** `dataRequestHandler` (`agent/src/dispatch.ts`, escalates with source `data_request`; FEAT-051 D5 says FEAT-061 replaces its `run`); `audit.erasePii` (FEAT-002); `verifyForDashboard` (FEAT-060, 30 s cooldown); `requireReauth`/`useReauthGuard` (FEAT-006); `notify` (platform notifications; `muteEvent` returning null = never muted).
- **Text search under RLS** needs a SECURITY DEFINER function to use the trigram index (`inbox_search_hits()`, 0047 lesson in code-map Schema).
- **Backups:** RDS `backup_retention_period = 35` (`infra/terraform/modules/data/main.tf`).

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: data-subject requests (GOV-05; FEAT-061 §3)`)

All routes under `/api/v1/data-requests`, session auth, capability `dsr.manage` (Owner, Admin; Agent 403). Tenant from the session only. Every write takes the request's `version` and answers 409 `state_changed` when stale.

- `DSR_TYPES = ['access','correction','deletion']`, `DSR_STATUSES = ['open','verified','completed','unverified','closed']` (closed set = last three), `DSR_SOURCES = ['dashboard','conversation']`, `DSR_VERIFY_METHODS = ['verified_channel','email_reply','phone_call','in_person','other']`.
- `DsrRequester` `{ name?: string ≤ 120, email?: email lower-cased, phone?: '+65…' (normalised as contacts), telegramId?: digits ≤ 20 }`, at least one of email/phone/telegramId to search (refine message `identifier_required`).
- `DsrCreateBody` `{ type, receivedOn: 'YYYY-MM-DD' (SGT, not in the future), requester: DsrRequester, note?: ≤ 500 }` → 201 `DsrDetail`.
- `DsrPatchBody` `{ version, type?, receivedOn?, requester? }` — only while `open` (else 409 `state_changed`).
- `DsrSummary` `{ id, ref: 'DSR-' + first 8 of id upper-case, type, status, source, receivedOn, dueOn, dueState: 'ok'|'due_soon'|'overdue'|'closed', requesterLabel (masked: `maskEmail`/`+65 ••••1234`/name initials), createdAt }`.
- `GET /api/v1/data-requests?view=open|closed&cursor` → `{ items: DsrSummary[], next: string|null, counts: { open, dueSoon, overdue } }` (open sorted by `dueOn` asc; closed by `closedAt` desc; 50 per page).
- `DsrDetail` = `DsrSummary` + `{ version, requester (full while not erased; masked after a deletion, D3), note, conversationId|null, verification: { method, note, by: name|null, at } | null, closed: { reason|null, by, at, outcome: DsrOutcome|null } | null, objects: 'none'|'pending'|'done', backupsClearBy: date|null, events: { at, code, by }[] }` (events = this request's audit entries, newest first).
- `POST /:id/verify` `{ version, method, note: 1..500 }` (open → verified); `POST /:id/unverified` `{ version, reason: 1..500 }` (open → unverified); `POST /:id/close` `{ version, reason: 1..500 }` (open|verified → closed, e.g. duplicate or withdrawn); `POST /:id/complete` `{ version, note?: ≤ 500 }` (verified access/correction → completed). Each → `DsrDetail`.
- `GET /:id/find` (status `verified`, or `open` for a preview: D9) → `DsrFindResult` `{ searchedFor: { email?, phone?, telegramId? }, contacts: { id, name, email, phone, telegram, mergedFrom: number, identities: number, leads: number, consents: number, conversations: number, auditPii: number }[], conversations: { id, channel, startedAt, lastMessageAt, messages: number, attachments: number, contactId|null, match: 'contact'|'mention' }[], attachments: { id, conversationId, name, size, contentType, status }[], kb: { kind: 'fact'|'staged', id, title, excerpt (≤ 160 chars, identifier masked), sourceName|null }[], other: { approvals, escalations, suggestions, summaries, trackingEvents, handoffLinks, telegramChats } }`. `mention` conversations and KB items are listed but unticked by default (D10).
- `DsrSelection` `{ contactIds: uuid[] ≤ 20, conversationIds: uuid[] ≤ 500, factIds: uuid[] ≤ 100, stagedFactIds: uuid[] ≤ 100 }`. The server re-runs `find` and refuses any ID outside it with 422 `not_in_result` (D10).
- `POST /:id/export` `{ version, selection }` (verified; `requireReauth`) → `application/json` attachment `data-request-DSR-1A2B3C4D-2026-11-20.json` (`DsrExport`: `{ request: { ref, type, receivedOn }, exportedAt, contacts, identities, consents, leads, conversations: { …, messages: { at, author, body }[] }[], attachments: { name, size, contentType, receivedAt }[], approvals, kb }`; no `audit_pii`, D5). Audit `dsr.exported` `{ contacts, conversations, messages }`.
- `POST /:id/corrections` `{ version, contactId, contact?: { name?: string|null, email?: string|null, phone?: string|null }, lead?: { id, need?, budget?, preferredTime? } }` (verified correction requests; contact/lead must be in `find`) → `DsrDetail`. Audit `dsr.corrected` `{ fields: ['contact.email', …] }` (names only, never values).
- `POST /:id/erase` `{ version, selection, confirm: 'delete' }` (verified deletion requests; `requireReauth`; selection must hold ≥ 1 item) → `DsrEraseResult` `{ detail: DsrDetail, counts: Record<DsrStore, number>, auditSeq: number, chain: 'intact'|'broken'|'not_checked' }`.
- `DsrError` codes: `state_changed` 409, `wrong_type` 409, `not_in_result` 422, `nothing_selected` 422, `identifier_required` 400, `future_date` 400.
- `ConversationPort.openDataRequest(type)` (agent, not HTTP): see §5.5.

## 4. Schema changes (`0059_data_subject_requests.sql`, then `pnpm db:generate` for the Drizzle part)

- **`dsr_requests`** (tenant-scoped, forced RLS, policy `tenant_id = app_current_tenant()`, in `TENANT_SCOPED_TABLES`, RLS case): `tenant_id`, `id uuid` (PK with tenant), `type`, `status` default `open`, `source`, `received_on date`, `due_on date GENERATED ALWAYS AS (received_on + 30) STORED`, `requester_name`, `requester_email`, `requester_phone`, `requester_telegram_id text`, `requester_erased_at` (D3), `note`, `conversation_id uuid null` (no FK: the request outlives the conversation), `verify_method`, `verify_note`, `verified_by`, `verified_at`, `close_reason`, `closed_by`, `closed_at`, `outcome jsonb` (`{ counts, auditSeq }` or `{ exported: n }`), `objects_pending int not null default 0`, `objects_done_at`, `due_alerted_at`, `created_by uuid null` (null = from a conversation), `created_at`, `updated_at`, `version int default 1`. Checks: type/status/source/method lists; closed statuses ⇔ `closed_at` set; `verified` ⇒ `verify_method` set; `unverified|closed` ⇒ `close_reason` set; at least one of email/phone/telegram unless `requester_erased_at` set or `source = 'conversation'`; phone format as `contacts_phone_ck`. Indexes: `(tenant_id, status, due_on)`, `dsr_requests_conversation_uq` unique `(tenant_id, conversation_id) WHERE status IN ('open','verified')` (one live request per conversation, D6).
- **Grants:** `app_dashboard` SELECT, INSERT, UPDATE (all but `tenant_id`, `id`, `source`, `created_at`); `app_agent_visitor` INSERT and SELECT (`tenant_id`, `id`, `conversation_id`, `status`) with a restrictive insert policy `source = 'conversation' AND created_by IS NULL`.
- **Notifications:** `NOTIFICATION_KINDS` + `dsr_due_soon` (not an `ALERT_EVENTS` entry: `muteEvent` returns null, so it can't be muted, D8); `NOTIFICATION_SUBJECTS` + `data_request`; widen `notifications_kind_ck`/subject check; `linkFor` → `/settings/privacy/requests/:id`.
- **`dsr_erase(req uuid, contact_ids uuid[], conversation_ids uuid[], fact_ids uuid[], staged_ids uuid[], actor uuid) RETURNS jsonb`**, SECURITY DEFINER, owned by NOLOGIN **`kaki_dsr_erase`**, `SET search_path = public, pg_temp`, tenant from `app_current_tenant()`; `GRANT EXECUTE … TO app_dashboard`. Locks the request row (`FOR UPDATE`, must be `verified` deletion), expands `contact_ids` with contacts whose `merged_into` is in the set, adds every conversation of those contacts, collects `email_attachments.object_key`s, then deletes children before parents (explicit deletes for no-cascade FKs: messages, owners, escalations, approvals, `reply_edit` corrections, `visitor_events`/`visitor_tracking_choices` of the conversations' visitor IDs not used by any surviving conversation; then conversations, then contacts with their cascades; KB facts with chunks and versions as kb `deleteFact` does, staged facts), sets the request `completed` with `outcome.counts`, `objects_pending`, and returns `{ counts, objectKeys }`. Column-scoped grants to `kaki_dsr_erase` for exactly these tables (SELECT of the keys it reads, DELETE). Every table it touches is listed in §5.2's registry.
- **`dsr_search_hits(patterns text[]) RETURNS TABLE(kind text, id uuid)`**, SECURITY DEFINER, owned by NOLOGIN **`kaki_dsr_search`**: tenant-filtered trigram substring hits in `messages.body` (→ conversation IDs), `facts.content::text`, `kb_staged_facts` text; patterns escaped as in `inbox_search_hits`.
- **`dsr_queue_due_alerts() RETURNS TABLE(tenant_id uuid, id uuid)`**, cross-tenant, owned by NOLOGIN **`kaki_dsr_timer`**, `GRANT EXECUTE TO app_outbox`: sets `due_alerted_at = now()` on `open|verified` rows with `due_on - 7 <= current_date (SGT)` and `due_alerted_at IS NULL`, returns them.

## 5. Component design

### 5.1 Requests (`packages/governance/src/dsr/requests.ts`)

`createRequest`, `updateRequest`, `verifyRequest`, `markUnverified`, `closeRequest`, `completeRequest`, `listRequests`, `requestDetail` on `withTenant(dashboard)`. Each write is a compare-and-set on `version`, appends `dsr.<event>` (`opened`, `updated`, `verified`, `unverified`, `closed`, `completed`, `exported`, `corrected`, `erased`) with `subjectType 'data_request'`, payload codes only; requester values go to the audit entry's PII part with `contactId` when a contact is known (so `erasePii` covers them). Free-text notes and reasons go through `piiMask` before storage (NRIC/card/bank masked at the edge, ADR-015). `dueState` is pure (`dsr/due.ts`): closed → `closed`; `today > dueOn` → `overdue`; `today ≥ dueOn − 7` → `due_soon`; SGT dates via kb's `sgDateOf` copy in governance (no kb import).

### 5.2 Find and the store registry (`dsr/stores.ts`, `dsr/find.ts`)

- `DSR_STORES`: one entry per tenant-scoped table: `{ table, action: 'find+erase' | 'erase' | 'keep', why }` (`keep` only for ID-only tables: audit_entries, audit_heads, usage_events, notifications, outbox, and tenant configuration tables). A unit test fails when `TENANT_SCOPED_TABLES` has a table not in `DSR_STORES` (the RLS-suite pattern), so a later feature that adds a PII table must decide its DSR handling.
- `findSubject(tx, tenantId, requester)`: exact match on normalised identifiers in `contact_identities.value` and `contacts.email/phone/telegram_id` → contact IDs (+ merged-in contacts) → per-contact counts; their conversations (`match: 'contact'`); `dsr_search_hits` for each identifier (≥ 5 chars) → `mention` conversations and KB items not already included; attachment list for the conversations; `other` counts. Read-only, dashboard zone.

### 5.3 Export and correction (`dsr/export.ts`, `dsr/correct.ts`)

- `exportSubject(tx, tenantId, selection)` builds `DsrExport` in one REPEATABLE READ read; messages in `seq` order; ≤ 20,000 messages (else 413 `too_large`, as FEAT-060's cap pattern). Direct download (D5).
- `correctSubject`: updates `contacts` display fields (normalised; a field set to null clears it) and the chosen lead's free-text fields in the dashboard zone; an email/phone change removes the old value's **unverified** identity rows (sources `lead_form`) and adds the new value as `lead_form` unverified (verified identities came from the channel itself and stay). Needs dashboard UPDATE on `contacts (name, email, phone, updated_at)` and DELETE/INSERT on `contact_identities` limited to source `lead_form` by restrictive policy (migration). Audit `dsr.corrected`.

### 5.4 Erase (`dsr/erase.ts`)

`eraseSubject(zoneDb, tenantId, requestId, selection, actor)`, one transaction: re-run `findSubject` and check the selection (422), `SELECT dsr_erase(…)`, `audit.erasePii` for every contact ID (merged ones included), mask the request's requester fields and set `requester_erased_at` (D3), `audit.append('dsr.erased', { counts })`, and when `objectKeys` is non-empty `enqueue(tx, { topic: 'conversation-turns', groupKey: 'dsr:<id>', payload: { kind: 'dsr_objects', requestId, keys } })`. After commit the API calls `verifyForDashboard`; `VerifyCooldown`/`VerifyRunning` → `chain: 'not_checked'` (D11).

### 5.5 Agent (`packages/agent/src/dispatch.ts`, `turn.ts`)

`dataRequestHandler.run`: `await ctx.conversation.openDataRequest(type)` then the existing `escalate('data_request')` and reply `data_request` (D6). Args gain an optional `type` (`access|correction|deletion`, `.catch` to `deletion`). `runVisitorTurn` implements the port with governance `openFromConversation(tx, tenantId, { conversationId, contactId, type, receivedOn: SGT date of the message })` in the visitor zone: `INSERT … ON CONFLICT (tenant_id, conversation_id) WHERE status IN ('open','verified') DO NOTHING`, requester email/phone/telegram copied from the conversation's contact when one exists, audit `dsr.opened` actor `agent`. Coaching scope: unchanged (handler is visitor-only). Eval: `feat-051-withdrawal.json` and `feat-004-multi-task.json` cases with `data_request` expect `dataRequest` opened on the fake port; add one Chinese and one Singlish access-request case.

### 5.6 Workers

- **agent-worker** `conversation-turns` branch `dsr_objects`: deletes each key from the attachments bucket (`DeleteObjects`, idempotent: a missing key is success), then `UPDATE dsr_requests SET objects_pending = 0, objects_done_at = now()` (agent-worker zone grant on these two columns), audit `dsr.objects_removed { count }`. Retries via SQS redrive.
- **scheduler** `dsr-due.ts` (`DSR_DUE_SWEEP_MS`, default hourly): `dsr_queue_due_alerts()` → for each row `notify(kind 'dsr_due_soon', subject data_request, recipients Owner + Admins, template "Data request due {dueOn}: {ref}")`. Template in platform `templates.ts`.
- **Infra:** terraform agent-worker task role `s3:DeleteObject` on the attachments bucket (if absent); scheduler env `DSR_DUE_SWEEP_MS`; api env `BACKUP_RETENTION_DAYS=35` (shown as `backupsClearBy = completed + 35 days`, D12).

### 5.7 API (`apps/api/src/data-requests.ts`, `registerDataRequestRoutes(app, deps, sessionFrom)`)

Routes in §3; `dsr.manage` in identity's capability table (Owner, Admin). Erase and export call `requireReauth(s)` after the capability check. Names for `verification.by`/`closed.by`/`events.by` from identity `memberNames` in the API (governance can't import identity). Cross-tenant: tenant B's session gets 404 on tenant A's request ID.

### 5.8 Dashboard (UI session; ui-design.md)

`/settings/privacy/requests` (SCR-APP-048) and `/settings/privacy/requests/:id` (SCR-APP-049); `lib/data-requests.ts` (api calls, pure `dueText`, `selectionFrom`); erase and export wrapped in `useReauthGuard().guard`; Privacy and data (SCR-APP-047) gets a "Data requests" row with the open and due-soon counts.

### 5.9 Documentation

`docs/operations/data-subject-requests.md` (new, short): what each store does on deletion, the 35-day backup window, what is kept (IDs-only audit and usage rows) and why, the alert timing; GOV-05's "Documented" criterion.

## 6. Acceptance criteria

- **AC-1** (GOV-05 tracked, UC-30 1) An Owner or Admin creates a request with type and received date; due date = received + 30 calendar days; list shows type, status and due date; Agent gets 403 on every route; tenant B gets 404 on tenant A's request.
- **AC-2** (UC-30 2, 2a; GOV-05 identity record) Verifying requires a method and note and records who and when; "unverified" closes the request with a required reason; find/export/correct/erase refuse a request that isn't `verified` (409).
- **AC-3** (UC-30 3; GOV-05 find) Searching by email, phone or Telegram ID lists the contact (and contacts merged into it), its conversations, leads, consents, attachments, memory, tracking rows, audit PII count, and KB items and conversations that mention the identifier; nothing from tenant B.
- **AC-4** (UC-30 4a) Export, after re-auth, downloads JSON with the selected contacts' data and messages; without fresh re-auth 403 `reauth_required`; audited `dsr.exported`.
- **AC-5** (UC-30 4b) Correction changes contact and lead fields; the audit entry names the fields, never the values; verified identities stay.
- **AC-6** (UC-30 4, 5; GOV-05 deletion; GOV-01) Erase, after type-to-confirm and re-auth, removes in one transaction every row of the selection from every `find+erase` store (integration test asserts zero rows per store), erases `audit_pii`, enqueues the S3 deletion, records `dsr.erased` with counts, and `verifyChain` still passes; without re-auth 403; IDs outside the find result 422.
- **AC-7** (GOV-05 backups, "Documented") The completed request shows the audit reference, the chain result and "Removed from backups by {date}"; `docs/operations/data-subject-requests.md` exists.
- **AC-8** (GOV-05 alert; UC-30 1a) A request 7 days from due and not closed alerts the Owner and Admins once (not mutable); closed requests don't alert.
- **AC-9** (LED-07, UC-28 2a; ADR-025) A visitor's "delete my data" opens one `conversation`-sourced request linked to the conversation (and contact) and still escalates; a second ask in the same conversation opens no second request.
- **AC-10** (registry) The `DSR_STORES` test fails for a tenant table with no DSR classification.
- **AC-11** (SCR-APP-048/049; NFR-09) Screens per ui-design.md at 1440 and 375 px, axe clean (E2E in CI).

## 7. Decisions

- **D1 — One synchronous transaction through a NOLOGIN-owned `dsr_erase()`; S3 files by outbox job.** Deletion from primary storage is immediate and all-or-nothing. Rejected: per-module deletes (app roles lack DELETE on most tables; many new grants); an async job for the database part (more states, a half-deleted window).
- **D2 — Deleting a contact deletes all of its conversations whole**, plus mention conversations and KB items the Admin ticks. Rejected: deleting only the visitor's messages (leaves the business's replies quoting them).
- **D3 — The request record outlives the deletion with the requester's details masked** (`m•••@gmail.com`, `+65 ••••1234`, initials) and `requester_erased_at`; the verification method and masked note stay as evidence. Rejected: keeping full details (PII of someone who asked to be deleted); deleting the request (no proof of compliance).
- **D4 — Correction covers contact name/email/phone and lead free-text fields; messages are never edited.** Rejected: editing message text (falsifies the record; the inbox has no edit).
- **D5 — Export is JSON, direct download, re-auth, attachments listed not bundled, `audit_pii` left out** (it only copies values already in the other stores; FEAT-060 D5). Rejected: a ZIP with files (new dependency), an async export job.
- **D6 — The chat opens a request and still escalates**, one live request per conversation; type from triage args, default deletion. Rejected: request only (the team might not notice it until the due alert).
- **D7 — Verification methods are a fixed list plus a required note.** Rejected: free text only (unreportable).
- **D8 — `dsr_due_soon` can't be muted**, sent once at 7 days. Rejected: an `ALERT_EVENTS` entry users can mute (legal deadline).
- **D9 — Find runs on `open` requests too (preview), all actions need `verified`.** Rejected: blocking search until verified (Admins need to see whether data exists to answer "we hold nothing").
- **D10 — Exact identifier match for contacts; mentions and KB hits are opt-in; the server re-runs find and rejects IDs outside it.** Rejected: name matching (false positives); trusting the client's selection.
- **D11 — The chain check after erase reuses `verifyForDashboard`; a cooldown shows "Verify from the Audit log".** Rejected: bypassing the cooldown.
- **D12 — Backups age out (RDS 35 days); no backup surgery.** GOV-05 allows "within the backup retention window". Rejected: restoring and scrubbing snapshots.
- **D13 — Re-auth on erase and export; none on correction** (AUTH-03 lists PDPA deletion and exports, not correction).
- **D14 — UI mockup not reviewed by Ken** (autonomous run); committed at `mockup/dsr-mockup.html`.
- **D18 — "Audit reference" links to the Audit log's Contacts group (UI build).** FEAT-060's Audit log has no entry-number filter, so `/settings/audit?seq=` would show the unfiltered log. Rejected: adding a `seq` filter to FEAT-060 here (another feature's screen and contract).
- **D19 — Find results are read-only while a request is Open, and on correction requests (UI build).** Ticking only matters for export and delete, which need "verified" (D9); the preview shows what is held. Rejected: tick boxes on the preview that nothing uses.
- **D20 — "Close without action" takes a required free-text reason with two quick-fill buttons ("Duplicate", "They withdrew the request") (UI build).** Rejected: a radio list plus an "Other" text field (one more control for the same stored text).

## 8. Escalations and open items

- Leads already sent to webhooks (FEAT-053, later) or exported as CSV are outside the system; the operations doc says so.
- Conversations open in a widget when deleted: the visitor's next message starts a new conversation (the old one 404s); turn jobs for deleted messages already skip.
- `usage_events` keep a conversation ID that no longer resolves (ID only, analytics).

## 9. Self-check

Every AC traces to GOV-05, UC-30, UC-28, LED-07, AUTH-03 or GOV-01; each decision has a reason and rejected options. Tenant ID only from the session or the verified visitor token. New table: forced RLS, policy, `TENANT_SCOPED_TABLES`, RLS case. Deletes only through a NOLOGIN-owned SECURITY DEFINER function; side effects (S3, alerts) through the outbox or the scheduler. No PII in audit payloads (codes and counts; requester values in `audit_pii`). Governance imports nothing above it. IDs checked: GOV-05, GOV-01, LED-07, AUTH-03, UC-30, UC-28, SCR-APP-047/048/049, ADR-004/005/009/012/014/015/025, NFR-09.
