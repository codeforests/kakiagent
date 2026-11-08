# Handoff: FEAT-036 — Email channel
Branch: feat/FEAT-036-email-channel · PR: none · Updated: 2026-11-08 by build (backend 1)
Stage done: build (T1–T6 of 14)
Next: build (backend, T7–T10) — kickoff: "Build FEAT-036 (backend) on branch feat/FEAT-036-email-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Start at T7 (gate). Then T8 identity, T9 API, T10 Terraform; then hand off the UI session (T11–T14).
- **Cycle rule:** inbox → tenancy → channels, so `@kaki/channels` must not import `@kaki/inbox` or `@kaki/tenancy`. `receiveEmail` takes an `EmailInboxPort` (the worker passes `import * as inbox`), `deliverMessage` takes `DeliverDeps` (`senders`, `footer`, `escalate`). Keep T8/T9 code the same way.
- **Schema extras beyond §4 (0053):** `channel_send_rejected(conn)` (visitor zone degrades a connection on 401/403; `reportSendFailure` now calls it), `email_bounce_route(rfc)`, `inbound_events_purge()`, dashboard INSERT on `channel_connections` (restrictive: never `widget`) plus SELECT/UPDATE `ai_reply_cap`. `channel_deliveries_due()` enqueues itself (`channel-send` for due rows, `conversation-turns` `{kind:'delivery_failed'}` for timed-out ones), as `approvals_queue_due()` does. Two FEAT-034 RLS cases were adjusted for D3 and the dashboard insert (T1 commit).
- **Contracts:** `Message.delivery`/`attachments` are optional (like `card`); the inbox views (T9) should fill them. `deliveryView(row)` in channels maps `pending` → `sending`. Queue jobs: `ChannelSendJob`, `DeliveryFailedJob` (in `TurnQueueJob`), `AttachmentScanJob`.
- **Retry route (T9):** set the delivery `pending`, `failed_reason` null, `attempts 0`, `first_attempt_at now()`, then `enqueue` a `channel-send` `{tenantId, messageId}` (group = conversation); the dashboard has the grants.
- **Config added:** agent-worker `EMAIL_INBOUND_*`, `EMAIL_SNS_TOPIC_ARN`, `SQS_EMAIL_INBOUND_QUEUE_URL`, `QUARANTINE_BUCKET`, `SQS_CHANNEL_SEND_QUEUE_URL`, `SMTP_URL`, `EMAIL_FROM`, `SES_MESSAGE_ID_DOMAIN` (default `ap-southeast-1.amazonses.com`, not yet checked against live SES docs); scheduler `SQS_CHANNEL_SEND_QUEUE_URL`, `DELIVERY_SWEEP_MS`; ingest-worker `ATTACHMENTS_BUCKET`. The api still needs `EMAIL_INBOUND_DOMAIN`, `ATTACHMENTS_BUCKET`, `EMAIL_IDENTITY_PROVIDER` (T8/T9). Terraform (T10) needs the same names, plus the agent-worker's S3 put on quarantine and get/delete on the inbound bucket.
- `pnpm email:receive <file.eml> [--to local] [--spam FAIL]` lives in `apps/agent-worker/scripts/` (root script forwards). Fixtures: `packages/channels/test/fixtures/email/*.eml`.
- **Footer (GOV-14):** the email footer links the tenant's own notice URL only; for a template notice it shows the business name, because the hosted page needs the widget key and the visitor zone can't read it. T9 or verify should decide whether to expose the key (e.g. via `visitor_tenant_state()`).
- EICAR as a `.pdf` is refused at receive as `unsupported_type` (it sniffs as text); the `malware` reason is covered by an infected PNG in `kb/test/attachment-scan.int.test.ts`.

## Left to CI or later
- E2E (`email-channel.e2e.ts`) and screen renders: GitHub CI in verify (no Docker here). LocalStack scripts (`01-queues.sh`, `02-buckets.sh`) were syntax-checked only.
- Terraform is written and tested, not applied (MD). Real Gmail/Outlook threading, SES Message-ID domain, mail-tester at MD.

## Pending for Ken
- Nothing blocking. Design decisions D1, D3, D7 (technical-design §7) stand unless he overrules them.
