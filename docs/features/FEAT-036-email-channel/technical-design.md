# Technical design: FEAT-036 — Email channel

> Implements: CHN-04, CHN-10, CHN-12 (p: the custom sending domain's health and the email channel's failed-send retry), NFR-17 (p: email inbound and outbound are never dropped: retried for 24 hours, then shown to staff as failed), NFR-18 (p: replies are DKIM-signed and SPF/DMARC-aligned to the forwarding domain or a verified custom domain; bounces mark the delivery failed), CHN-01 (p: the first full adapter and the outbound shaper) · Realizes: UC-27 steps 1–3, 2a, 3a, 3b, 3c; UC-25 (p: connecting the email channel) · Screens: SCR-APP-038 (new), SCR-APP-036 (p: the Connect entry), SCR-APP-014 (p: email in the list, subject, delivery state, attachments) (see [ui-design.md](ui-design.md)) · Module: `channels`, `inbox`, `agent`, `kb` (scan), architecture §5.2, ADR-005, ADR-008, ADR-011, ADR-012, ADR-013, ADR-014, ADR-015, ADR-018, ADR-019
> Status: designed · 2026-11-08

## 1. Intent

A tenant turns on email in two minutes: KakiAgent gives them a forwarding address (`kaki-bakery@in.<platform domain>`), they set their existing mailbox (Gmail, Outlook) to forward to it, and the assistant answers each customer email from the knowledge base in the same thread. Replies go out from the forwarding address, or from the tenant's own address (`hello@kakibakery.sg`) once its DKIM, SPF (custom MAIL FROM) and DMARC records verify; an unverified domain is never used. Out-of-office replies, bounces, mailing lists, bulk mail, spam and unsafe mail never get an AI reply; a thread gets at most 10 AI replies in 24 hours (tenant-set), then the AI stops and the conversation is escalated. Attachments are stored only after the KB-11 checks. A reply that can't be sent is retried for 24 hours and then shown to staff as failed, with a Retry. Staff see email conversations in the same inbox and reply there; their replies go out by email too.

## 2. Codebase context

- **Adapter contract** (`packages/channels/src/adapter.ts`, FEAT-034): `ChannelAdapter` (`verifyInbound`, `normalise`, `shouldIgnore`, `threadKey`, `send`, `checkHealth`, `connect?`), `IgnoreReason` (`auto_reply` | `group` | `bulk` | `echo` | `unsupported`), `SendResult` (`auth` | `transient` | `permanent`). `registry.ts` has only the widget; `connectable()` feeds Channels' Connect section. `connections.ts`: `visitorChannel(tx, kind)` (via `visitor_channel()`), `recordHealth`, `reportSendFailure`, `runChannelHealth`. `@kaki/channels/contract-suite` is the adapter test.
- **Conversations** are `channel` `'widget'` only (schema, contracts `ConversationSummary`, `ConversationListQuery`, sidebar). Inbox `createConversation(tx, tenant, visitorId)` hard-codes the widget; `appendVisitorMessage` masks (GOV-04), reopens within 7 days (INB-08), enqueues `conversation-turns` and is idempotent on `clientMessageId` (text). FEAT-042's 72-hour auto-close for non-widget channels exists but is untested.
- **Message writers** that reach the visitor: inbox `appendAgentReply`, `appendSystemNotice`, `appendSystemMessage`, ownership `sendStaffMessage`/`staffNotice`, approvals `deliver`. The widget delivers by the stored row plus SSE; nothing sends elsewhere yet (FEAT-043 §8, FEAT-055 D7).
- **Gate** (`packages/agent/src/gate.ts` `aiAllowed`): kill switch → conversation status/owner → `visitorChannel(conversation.channel).live`; `not_live` stores the channel's offline message once.
- **Contacts** (FEAT-049): `contacts` unique on `(tenant, email)`; `captureLead` resolves by email. CHN-08's verified merge is FEAT-039.
- **Outbox** topics `conversation-turns`, `ingest`; dispatcher in the scheduler; queues created by `infra/local/localstack/01-queues.sh`. Buckets `kaki-local-quarantine`, `-sources` (`02-buckets.sh`). Scanner port `MalwareScanner` and `sniffType` exported by `@kaki/kb`; ClamAV client in `apps/ingest-worker/src/clamav.ts`.
- **Mail out**: `@kaki/platform` `Mailer` (SMTP: Mailpit locally, SES SMTP at MD) sends `{ to, subject, text, html }` only. Terraform `modules/mail` (FEAT-052) has an SES identity for the alert domain, Easy DKIM, MAIL FROM, DMARC output and a bounce-rate alarm.
- **Escalations** (FEAT-044) `requestEscalation(tx, { source })`, sources `visitor_button`, `visitor_asked`, `unverified`, `approval_sla`, `data_request`; each alerts per routing.

## 3. API contracts (`packages/contracts/src/index.ts`)

Widened: `ConversationSummary.channel`, `ConversationListQuery.channel`, the sidebar's `channel` → `ConversationChannel = z.enum(['widget', 'email'])`. `ConversationSummary.subject: z.string().nullable()` (email only). `Message` gains `delivery: MessageDelivery.nullable()` (null for the widget and for visitor rows) and `attachments: z.array(MessageAttachment)` (default `[]`). `EscalationSource` + `reply_cap`, `delivery_failed`.

```ts
MessageDelivery = { status: z.enum(['sending', 'sent', 'failed']), failedReason: z.enum(['bounced', 'rejected', 'timed_out']).nullable(), sentAt: iso.nullable() }
MessageAttachment = { id: uuid, name: string, contentType: string | null, size: int, status: z.enum(['scanning', 'clean', 'rejected']), rejectReason: z.enum(['unsupported_type', 'too_large', 'malware', 'encrypted', 'too_many']).nullable() }

// ---- Dashboard API: email channel (CHN-04, CHN-10; FEAT-036 §3)
EmailDomainRecord = { purpose: z.enum(['dkim', 'mail_from_mx', 'mail_from_spf', 'dmarc']), type: z.enum(['CNAME', 'MX', 'TXT']), host: string, value: string, status: z.enum(['pending', 'ok', 'failing']) }
EmailChannelResponse = {
  connected: boolean,                       // false → the page shows "Set up email"
  connection: { id: uuid, state: 'live' | 'offline', version: int } | null,
  forwardingAddress: string | null,         // kaki-bakery@in.<domain>
  lastReceivedAt: iso | null,               // last accepted inbound mail: "forwarding works"
  forwardingConfirmation: { code: string | null, link: string | null, receivedAt: iso } | null, // Gmail's confirmation mail (D5)
  replyFrom: string,                        // the address replies use now
  domain: { address: string, domain: string, state: 'pending' | 'verified' | 'failing', checkedAt: iso | null, verifiedAt: iso | null, failingSince: iso | null, records: EmailDomainRecord[] } | null,
  replyCap: int,                            // AI replies per thread per 24 h
  ignored: { reason: EmailIgnoreReason, count: int }[],  // last 7 days, from inbound_events
  settingsVersion: int,
}
EmailIgnoreReason = z.enum(['auto_reply', 'bounce', 'bulk', 'list', 'spam', 'unsafe', 'echo', 'loop'])
EmailReplyCapBody = { replyCap: z.number().int().min(1).max(50), settingsVersion: int }
EmailDomainBody   = { address: z.email().max(254), settingsVersion: int }   // a mailbox on the tenant's domain
```

Routes (`apps/api/src/email-channel.ts`, `registerEmailChannelRoutes`; all `settings.manage` (Owner, Admin, as FEAT-034) except where noted; tenant from the session):
- `GET /api/v1/channels/email` → `EmailChannelResponse`.
- `POST /api/v1/channels/email` → 201 `EmailChannelResponse`: creates the connection (offline, mode `hidden`) and the settings with the forwarding address; 409 `already_connected`.
- `PUT /api/v1/channels/email/reply-cap` `EmailReplyCapBody` → 200; 409 `stale`.
- `POST /api/v1/channels/email/domain` `EmailDomainBody` → 201 (domain `pending`, records); 422 `platform_domain` (the address is on our domain or a free-mail domain: gmail.com, outlook.com, hotmail.com, yahoo.com, icloud.com), 409 `stale`, 502 `provider_unavailable`.
- `POST /api/v1/channels/email/domain/check` → 200 (re-checks now; at most once per 30 s, else 429 `too_soon`).
- `DELETE /api/v1/channels/email/domain` `{ settingsVersion }` → 200: replies go back to the forwarding address; the SES identity is deleted.
- `POST /api/v1/messages/:id/delivery/retry` (`inbox.reply`: anyone who may reply) → 202; 409 `not_failed`; 404 another tenant's.
- `GET /api/v1/attachments/:id` (`inbox.read`) → 302 to a 5-minute presigned GET of a `clean` attachment (`Content-Disposition: attachment`); 404 otherwise.

## 4. Schema changes (migration `0053_email_channel.sql`)

- `conversations.channel` check → `('widget', 'email')`. `outbox.topic` + `channel-send`. `ESCALATION_SOURCES` + `reply_cap`, `delivery_failed`.
- `channel_connections`: `ai_reply_cap smallint null` (check 1–50; null = no cap; the email row gets 10) and `channel_connections_offline_mode_ck` widened so `email` may be `hidden` (D3). `visitor_channel()` also returns `ai_reply_cap`.
- **`email_settings`** (tenant PK; channels module): `connection_id`, `forwarding_local text unique` (globally; the tenant slug at setup, suffixed `-2…` on a clash; never changes after), `domain_address`, `domain`, `domain_state` (`pending` | `verified` | `failing` | null), `dkim_tokens text[]`, `mail_from_domain`, `domain_checked_at`, `domain_verified_at`, `domain_failing_since`, `last_received_at`, `forwarding_confirmation jsonb`, `version`. Dashboard: SELECT, UPDATE of the domain columns, `version`; visitor zone: SELECT, UPDATE `last_received_at`, `forwarding_confirmation`.
- **`inbound_events`** (ADR-011): `(tenant_id, id)`, `connection_id`, `provider_event_id` (SES message ID), `received_at`, `outcome` (`accepted` | `ignored` | `failed`), `ignore_reason` (EmailIgnoreReason), unique `(tenant_id, connection_id, provider_event_id)`. No headers, addresses or body (ADR-015). Purged after 30 days by the delivery sweep.
- **`email_messages`** (threading): `(tenant_id, rfc_message_id)` unique, `conversation_id`, `message_id` (nullable for ignored or echo), `direction` (`in` | `out`), `created_at`. Index `(tenant_id, conversation_id, created_at desc)`.
- **`email_threads`**: `(tenant_id, conversation_id)` PK, `subject` (masked, ≤ 200), `references text[]` (≤ 20, oldest first: the chain the next reply carries), `last_inbound_id`.
- **`message_deliveries`**: `(tenant_id, message_id)` PK, `conversation_id`, `connection_id`, `status` (`pending` | `sent` | `failed`), `attempts`, `first_attempt_at`, `next_attempt_at`, `failed_reason` (`bounced` | `rejected` | `timed_out`), `external_id`, `sent_at`, `version`. Index on `next_attempt_at where status = 'pending'`.
- **`email_attachments`**: `(tenant_id, id)`, `conversation_id`, `message_id`, `name` (masked, ≤ 200), `content_type` (sniffed), `size`, `status`, `reject_reason`, `object_key` (null unless clean), `created_at`. Deleted with the conversation (GOV-06); the S3 object is removed by the same purge.
- **Trigger** `messages_channel_delivery` (AFTER INSERT on `messages`, SECURITY DEFINER, owner NOLOGIN `kaki_channel_delivery`): for a non-visitor row in a conversation whose channel isn't `widget` (the one channel delivered by the stored row, D2) it inserts the `message_deliveries` row and the `channel-send` outbox row (group = conversation) in the writer's transaction (ADR-012). Every existing writer is covered without a change.
- **Functions** (SECURITY DEFINER, NOLOGIN owners, as 0042/0049): `email_route(local text)` → `(tenant_id, connection_id)` for the inbound consumer, which has no tenant context yet; `channel_deliveries_due(limit)` (owner `kaki_channel_timer`) → due pending deliveries for the scheduler, and marks `failed`/`timed_out` those whose `first_attempt_at` is > 24 h old (returning them so the scheduler escalates).
- All new tables: forced RLS, tenant policy, in `TENANT_SCOPED_TABLES`, a case in `rls.int.test.ts`. Seed: none (the dev tenants set email up in E2E).

## 5. Component design

### 5.1 The email adapter (`packages/channels/src/email/`)

- `parse.ts` (pure): `mailparser` `simpleParser` on the raw MIME → `ParsedEmail { messageId, inReplyTo, references[], from {address, name}, subject, text, html, headers, attachments[], date }`. `bodyText(p)`: text/plain, else HTML → text; strips quoted history (`>` lines, "On … wrote:", Gmail `gmail_quote`, Outlook `From: … Sent:` / `-----Original Message-----` blocks) and a `-- ` signature; caps at 4,000 characters with "[…]" (contracts message max). A body empty after stripping is stored as "(no text)" when it has attachments, so staff see it, and schedules no turn.
- `ignore.ts` (pure, CHN-10), first match wins: `echo` (Message-ID in `email_messages` as `out`, or From is our forwarding or reply-from address); `bounce` (null `Return-Path`, From `mailer-daemon@`/`postmaster@`, `multipart/report`); `auto_reply` (`Auto-Submitted` other than `no`, `X-Autoreply`, `X-Autorespond`, `X-Auto-Response-Suppress` with `OOF` or `All`, `Precedence: auto_reply`, subject "Automatic reply:"/"Out of Office"/"自动回复"); `list` (`List-Id`, `List-Unsubscribe`, `List-Post`); `bulk` (`Precedence: bulk|junk|list`, `X-Mailchimp`/`Feedback-ID` with a bulk sender); `spam` (SES `spamVerdict` FAIL or `dmarcVerdict` FAIL); `unsafe` (SES `virusVerdict` FAIL). The adapter's `shouldIgnore` maps these onto `IgnoreReason`, which gains `spam`, `unsafe`, `bounce` (contract change, the widget is unaffected).
- `thread.ts`: `threadKey` = the first `References` entry, else `In-Reply-To`, else the message's own ID. Conversation lookup: the newest `email_messages` row whose `rfc_message_id` is in `references ∪ in_reply_to` for this tenant (any direction), so Gmail and Outlook replies thread even when Outlook trims the chain. No match → a new conversation (subject threading is never used: two customers can write "Enquiry").
- `send.ts`: builds the reply: From `"<business name>" <reply-from>`, To the contact's email, Subject `Re: <thread subject>` (once), `Message-ID <uuid@in.<domain>>`, `In-Reply-To` = the latest inbound ID, `References` = the thread chain + it, `Auto-Submitted: auto-replied` on AI and system messages (RFC 3834; staff messages carry none), `X-Kaki-Message: <message id>`; text and a minimal escaped HTML. Sent through the extended `Mailer` (`headers`, `from`, returns the provider message ID). SES replaces `Message-ID`, so both ours and `<sesId>@<SES_MESSAGE_ID_DOMAIN>` are stored as `out` rows (verify the domain format against live SES docs at build). `send` is idempotent on `msg.id` (an `out` row for the message → return it).
- `identity.ts`: port `SendingIdentities { create(domain): {dkimTokens, mailFrom}; status(domain): {dkim, mailFrom}; remove(domain) }` with an SES v2 implementation (`CreateEmailIdentity` Easy DKIM, `PutEmailIdentityMailFromAttributes` `mail.<domain>`, configuration set from config) and a `fixture` implementation (non-production builds only: a `.test` domain verifies on its first check). DMARC: `node:dns` `resolveTxt('_dmarc.<domain>')` behind a `TxtResolver` port; any record starting `v=DMARC1` passes. `records(domain)` renders the six rows (3 DKIM CNAMEs, MAIL FROM MX `10 feedback-smtp.<region>.amazonses.com`, MAIL FROM TXT `v=spf1 include:amazonses.com ~all`, DMARC TXT `v=DMARC1; p=none;` shown only when missing).
- `checkHealth`: forwarding only → ok. With a domain: all records ok → ok (state `verified`); a record that passed and now fails → `credential_invalid` (state `failing`, `failing_since`), which degrades the connection and alerts through FEAT-034's path. While `failing`, replies go from the forwarding address (D4).
- Registry entry: `{ kind: 'email', name: 'Email', adapter: () => import('./email/index.js'), checksHealth: true, offlineModes: ['hidden', 'message'], connectPath: '/settings/channels/email' }`; capabilities `{ streaming: false, maxLength: 20000, richContent: false, attachments: true, typing: false }`.

### 5.2 Inbound (`channels/src/email/receive.ts`, run by the agent-worker)

SES receipt rule (all recipients on `in.<domain>`, spam and virus scanning on) → S3 `inbound-mail/<sesId>` → SNS → SQS `email-inbound` (standard; DLQ after 5). `receiveEmail(deps, snsMessage)`:
1. `verifyInbound`: the SNS `TopicArn` equals config and the S3 bucket is ours, else `bad_signature` (logged, dropped). Bounce and complaint notifications from the configuration set ride the same queue (§5.3).
2. For each recipient on our domain: `email_route(local)` → tenant and connection; unknown → `unknown_connection` (logged). Then in one visitor-zone transaction under `withTenant`: insert `inbound_events` (conflict → already handled, done); Gmail's confirmation mail (From `forwarding-noreply@google.com`) → store its code and link in `forwarding_confirmation`, outcome `accepted`, no conversation (D5); `shouldIgnore` hit → outcome `ignored` + reason, nothing else; a thread already at its loop limit (> 20 inbound in 1 h) → `loop`.
3. Accepted: contact by the lower-cased From address (existing `contacts` row by email, else insert with the display name, D6); conversation from §5.1's lookup (a closed one within 7 days reopens through `appendVisitorMessage`; older → a new conversation linked to the same contact); `createConversation(tx, tenant, visitorId, 'email')` with `visitorId` = UUIDv5 of `tenant:address` (no PII in the column) and `setConversationContact`; `appendVisitorMessage` with `clientMessageId` = sha256 of the Message-ID (so a redelivery is idempotent and it schedules the turn); `email_messages` `in` row; `email_threads` subject and references; `last_received_at`.
4. Attachments: up to 10, each ≤ 10 MB and of a sniffed JPG, PNG or PDF; others are `rejected` rows with their reason and never stored. Accepted bytes go to the quarantine bucket `email/<tenant>/<attachment id>` and an `ingest` outbox job `attachment_scan` (ingest-worker: `sniffType` again, encrypted PDF → `encrypted`, `MalwareScanner` → `malware`, else copied to the `attachments` bucket and `clean`). SES `virusVerdict` FAIL never reaches here (`unsafe`).
5. The raw object is deleted after the transaction commits; the bucket's 7-day lifecycle is the backstop. A failure leaves the SQS message for redelivery (NFR-17).

### 5.3 Outbound (`channels/src/deliver.ts`, agent-worker; generic, D2)

`channel-send` job `{ tenantId, messageId }` → `deliverMessage(tx, registry, job)`: lock the `message_deliveries` row (`for update`; not `pending` → done); load the message, the conversation's connection and adapter; **shape** it (`shape.ts`, pure, reads `capabilities` and the notice kind): body + `notice` text + the disclosure on the first AI message (AGT-11) + a footer "<business> · Privacy notice: <url>" (GOV-14); cards are dropped (their text stays; D7); system rows of kinds `staff_joined`, `staff_left`, `chat_ended`, `lead_captured` aren't sent (marked `sent` with no external ID). Then `adapter.send`: ok → `sent`, `external_id`, `sent_at`; `transient` → `attempts + 1`, `next_attempt_at` = now + min(2^attempts min, 60 min); `auth` → as transient plus `reportSendFailure` (degraded at once, CHN-12); `permanent` → `failed`/`rejected` and escalation `delivery_failed`. The scheduler's `channel-deliveries.ts` (`DELIVERY_SWEEP_MS`, 60 s) calls `channel_deliveries_due()`, re-enqueues due rows and escalates the timed-out ones (UC-27 3c). A configuration-set Bounce for an `out` ID → the delivery `failed`/`bounced` + escalation. Retry route: `failed` → `pending`, `attempts 0`, `first_attempt_at now`, enqueue. Sends of one conversation stay in order: `channel-send.fifo` groups by conversation.

### 5.4 Agent gate (`packages/agent/src/gate.ts`)

- After the live check: when `channel.aiReplyCap` is set and the conversation has ≥ that many `agent` messages in the last 24 h → `{ open: false, reason: 'reply_cap' }`. `runVisitorTurn` stores nothing and calls `ConversationPort.escalate('reply_cap')` once (an open escalation already → nothing). No kind check: any channel with a cap behaves the same.
- `not_live` with offline mode `hidden` stores nothing (the email waits in the inbox for staff); `message` stores the offline text once, which is then emailed.
- `code-map.md` Agent pipeline gets one line for both.

### 5.5 Inbox and API

- Inbox: `createConversation` takes `channel` (default `widget`); `toSummary` adds `subject` (from `email_threads`, a left join), `toMessage` adds `delivery` and `attachments` (thread view reads them in the same query batch). The list filter accepts `email`.
- API: the routes in §3. `channels.ts` lists email from the registry (go live and offline settings reuse FEAT-034's routes; go-live readiness via `goLiveOne` unchanged). Publishes a `message` event when a delivery changes state so the open thread updates.

### 5.6 Infrastructure

- Local: queues `email-inbound` (standard) and `channel-send.fifo` in `01-queues.sh`; buckets `kaki-local-inbound-mail`, `kaki-local-attachments`. `pnpm email:receive <file.eml> [--to local]` (`scripts/email-receive.mjs`) puts the file in the local bucket and an SES-shaped SNS notification on the queue, as SES would; E2E uses it. Outbound goes to Mailpit through the existing SMTP mailer.
- Terraform `modules/mail`: MX for `in.<domain>`, an active receipt rule set (scan on, S3 action with the SNS topic), the inbound bucket (KMS, 7-day lifecycle, SES-only bucket policy), the SNS topic → SQS `email-inbound` (+DLQ), `channel-send.fifo` (+DLQ), the configuration set's Bounce/Complaint destination to the same topic, the `in.` sending identity (DKIM, MAIL FROM), and `ses:*EmailIdentity*` for the api and scheduler task roles. `terraform test` covers the new resources. Not applied before MD.
- Config (every role's `.env.example`): `EMAIL_INBOUND_DOMAIN`, `EMAIL_INBOUND_BUCKET`, `EMAIL_SNS_TOPIC_ARN`, `SQS_EMAIL_INBOUND_QUEUE_URL`, `SQS_CHANNEL_SEND_QUEUE_URL`, `ATTACHMENTS_BUCKET`, `SES_CONFIGURATION_SET`, `SES_MESSAGE_ID_DOMAIN`, `EMAIL_IDENTITY_PROVIDER` (`ses` | `fixture`; `fixture` refused when `KAKI_BUILD=production`), `DELIVERY_SWEEP_MS`.

## 6. Acceptance criteria

- **AC-1 (CHN-04, UC-25):** An Owner or Admin sets up email: the connection is created offline (mode hidden) with a unique forwarding address; an Agent gets 403; tenant B can't read or change tenant A's settings.
- **AC-2 (CHN-04, UC-27 1–3):** With the channel live, an email to the forwarding address creates an email conversation linked to the sender's contact, the AI replies by email from the forwarding address (Mailpit shows it), and the reply carries `In-Reply-To`, `References`, `Re:` subject and `Auto-Submitted: auto-replied`.
- **AC-3 (CHN-04 "threads correctly in Gmail and Outlook"):** Recorded Gmail and Outlook reply fixtures (full and trimmed `References`) land in the same conversation; a new email with the same subject and no references starts a new one; a reply 8 days after close starts a new conversation on the same contact; within 7 days reopens it.
- **AC-4 (CHN-10, UC-27 2a):** Fixtures for a Gmail vacation reply, an Outlook OOF, a DSN bounce, a mailing-list post, a bulk newsletter, an SES spam verdict and a virus verdict each get no AI reply and no conversation, and appear in the page's ignored counts by reason; an echo of our own reply is ignored.
- **AC-5 (CHN-10 "loop stops at the cap", UC-27 3b):** A sender that answers every reply without auto-reply headers gets exactly 10 AI replies in 24 hours (cap 10), then the conversation is escalated with source `reply_cap` once and no further AI reply is sent; a cap saved as 3 applies to the next turn; 0 and 51 are 422.
- **AC-6 (CHN-04 "sending from an unverified custom domain is not possible", NFR-18):** Adding `hello@kakibakery.test` shows six records `pending`; replies still go from the forwarding address; after Check with every record ok the state is `verified` and replies go from `hello@kakibakery.test`; when a record later fails the state is `failing`, the channel is degraded with an alert (CHN-12), and replies go from the forwarding address again; free-mail and platform addresses are 422.
- **AC-7 (CHN-04 attachments, KB-11):** A PDF and a PNG attachment are stored and downloadable by staff after the scan; an EICAR file, a renamed executable, an encrypted PDF and an 11 MB file are `rejected` with their reason, never stored in the attachments bucket, and shown to staff by name only.
- **AC-8 (NFR-17, UC-27 3c, CHN-12):** A transient send failure is retried with backoff; after 24 hours the delivery is `failed`/`timed_out`, the conversation is escalated `delivery_failed`, and staff see "Not delivered" with Retry, which sends it; an SMTP 401/403 degrades the channel at once; a bounce marks the delivery `bounced`. A redelivered SQS message creates no second message or reply.
- **AC-9 (D2, INB-02):** A staff reply and an approval notice in an email conversation are emailed; `staff_joined`/`staff_left` notices aren't; the widget's messages create no delivery rows.
- **AC-10 (ADR-005, ADR-015):** `inbound_events`, `message_deliveries` and audit rows hold no address, subject or body; masked NRIC in an email body is masked in `messages` and in the model payload; every new table passes the cross-tenant suite.
- **AC-11 (SCR-APP-038, SCR-APP-014):** The Email channel page shows forwarding only, domain pending, verified and failing, the Gmail confirmation code, errors with a next action and no serious axe violations at 375 and 1280; the inbox filters by Email and shows the subject, delivery state and attachment chips.

## 7. Decisions

- **D1 — Receive by forwarding, send from the custom domain.** CHN-04's "connects a custom domain" is the sending identity: the tenant keeps their mailbox and MX records and forwards to us; we never take over their inbound mail (an SME's mailbox breaking is worse than a forward rule). Their original mail stays in their mailbox, which is also why ignored mail is safe (D5).
- **D2 — One delivery path for every adapter channel, by trigger.** A trigger on `messages` creates the delivery and its outbox row in the writer's transaction, so the six existing writers (agent, notices, staff, approvals) need no change and a future one can't forget. The widget is the only channel delivered by the stored row; the trigger says `channel <> 'widget'` and nothing else branches on kind (ADR-011).
- **D3 — Offline email is silent by default.** Email may use offline mode `hidden` (no reply; staff see the mail in the inbox) or `message` (the offline text, once). Setup creates it `hidden` and offline, so mail forwarded before go-live is never auto-answered.
- **D4 — A failing domain falls back, never blocks.** While the custom domain isn't verified (pending or failing), replies use the forwarding address on our own aligned domain, so mail keeps flowing and nothing is ever sent from an unverified domain.
- **D5 — Gmail's forwarding confirmation is shown on the page.** Gmail requires the forwarding address to confirm; that mail is recognised by its sender and shown as a code and link on SCR-APP-038, not as a conversation.
- **D6 — Contact by the From address, as FEAT-049 does.** `contacts` is already one row per email per tenant; the email conversation joins that contact. Verified merge, unmerge and other identifiers stay FEAT-039's (CHN-08).
- **D7 — Cards don't travel.** Email has no rich content: consent, lead-form and withdraw cards are dropped and their reply text is sent; a quote card's text body is the email. Email-native consent and withdrawal wording are follow-ups (§8).
- **D8 — Loop guard beyond the cap.** Besides the per-thread AI cap (CHN-10), more than 20 inbound mails in one thread in an hour are ignored as `loop`, so a runaway sender can't fill the inbox.
- **D9 — Attachments are for staff in FEAT-036.** They are stored after scanning and downloadable in the inbox; the agent doesn't read them (CHN-09's "agent may read" is widget-only and Should).

## 8. Escalations and open items

- SES replaces `Message-ID` on send: storing both IDs covers it; build checks the SES ID domain format against live docs.
- Plan gating of channels (DSH-04) isn't enforced anywhere yet; FEAT-036 adds none.
- Follow-ups: email wording for consent and withdrawal (FEAT-051's cards don't travel, D7); CHN-08 merge (FEAT-039); FEAT-037/040 reuse §5.3's delivery path and `ai_reply_cap` unchanged.
- Live checks at MD: mail-tester score, real Gmail/Outlook threading, the receipt rule and bounce alarm (NFR-18).

## 9. Self-check

Every FR criterion of CHN-04 and CHN-10 has an AC (threading AC-3; attachments AC-7; unverified domain AC-6; auto-reply AC-4; cap AC-5). Invariants: tenant from the route function and session, never the body (ADR-005); side effects through the outbox (ADR-012, trigger in the writer's transaction); the gate before every turn (ADR-013); no PII outside contact-keyed tables (ADR-015; raw mail lives ≤ 7 days in a KMS bucket and is deleted after processing); the core never branches on kind except D2's one widget test; SES is an already-declared sub-processor (ADR-019). Traceability: CHN-04 → AC-1–AC-3, AC-6, AC-7; CHN-10 → AC-4, AC-5; CHN-12 (p) → AC-6, AC-8; NFR-17 (p) → AC-8; NFR-18 (p) → AC-2, AC-6, AC-8; CHN-01 (p) → AC-9; UC-27 1–3 → AC-2, 2a → AC-4, 3a → AC-2 (the after-hours notice is in the reply), 3b → AC-5, 3c → AC-8; UC-25 (p) → AC-1. IDs checked: CHN-01, CHN-04, CHN-08, CHN-09, CHN-10, CHN-12, NFR-17, NFR-18, KB-11, GOV-04, GOV-06, GOV-14, AGT-11, INB-08, DSH-04, UC-25, UC-27, SCR-APP-014, SCR-APP-036, SCR-APP-038, ADR-005, ADR-011, ADR-012, ADR-013, ADR-015, ADR-019.
