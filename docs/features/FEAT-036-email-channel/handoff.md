# Handoff: FEAT-036 — Email channel
Branch: feat/FEAT-036-email-channel · PR: none · Updated: 2026-11-08 by build (backend 2)
Stage done: build (T1–T9 of 14)
Next: build (backend, T10) — kickoff: "Build FEAT-036 (backend, Terraform T10) on branch feat/FEAT-036-email-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- **T10 only, then stop for the UI session (T11–T14).** No `terraform` binary in cloud sessions: download 1.16.6 (CI's version, `.github/workflows/ci.yml` job `terraform`) from releases.hashicorp.com into the scratchpad; `terraform test` per module as CI runs it.
- T10 names to wire (task roles' env): api `EMAIL_INBOUND_DOMAIN`, `ATTACHMENTS_BUCKET`, `EMAIL_IDENTITY_PROVIDER=ses`, `SES_CONFIGURATION_SET`; scheduler `EMAIL_IDENTITY_PROVIDER=ses`, `SES_CONFIGURATION_SET`, `SQS_CHANNEL_SEND_QUEUE_URL`; agent-worker the T4/T6 names in the old handoff list (`EMAIL_INBOUND_*`, `EMAIL_SNS_TOPIC_ARN`, `SQS_EMAIL_INBOUND_QUEUE_URL`, `QUARANTINE_BUCKET`, `SQS_CHANNEL_SEND_QUEUE_URL`, `SMTP_URL`, `EMAIL_FROM`, `SES_MESSAGE_ID_DOMAIN`); ingest-worker `ATTACHMENTS_BUCKET`. IAM: api and scheduler `ses:CreateEmailIdentity`, `GetEmailIdentity`, `DeleteEmailIdentity`, `PutEmailIdentityMailFromAttributes`; api `s3:GetObject` on attachments (presigned downloads); agent-worker S3 put on quarantine, get/delete on the inbound bucket. `modules/mail` today holds only the outbound `no-reply` identity (FEAT-052).
- **UI (T11–T14) contracts:** `GET/POST /api/v1/channels/email` → `EmailChannelResponse`; `PUT …/reply-cap` (`EmailReplyCapBody`; 422 `invalid_body` with `fields`, 409 `stale`); `POST …/domain` (`EmailDomainBody`; 422 `platform_domain`, 502 `provider_unavailable`), `POST …/domain/check` (429 `too_soon`; the response's records carry that check's per-row result), `DELETE …/domain` (`EmailDomainRemoveBody`); every write answers the fresh `EmailChannelResponse`. `POST /api/v1/messages/:id/delivery/retry` → 202 (409 `not_failed`) and publishes a `message` event with `delivery.status: 'sending'`; `GET /api/v1/attachments/:id` → 302. Thread messages carry `delivery` and `attachments`; summaries carry `subject`; the list takes `channel=email`. Go live/offline and offline settings are FEAT-034's routes on the email connection; the Channels page's Connect entry comes from the registry (`connectPath /settings/channels/email`).
- Local: `EMAIL_IDENTITY_PROVIDER=fixture` (api and scheduler `.env.example`): a `.test` domain verifies on its first check; E2E can add `hello@kakibakery.test`.
- Decisions taken in build: reply-cap and domain bodies answer 422 (not 400) for invalid values, as tasks.md's Done-when says; records shown from the stored state between checks (verified → all ok, no DMARC row). The Gmail "ignored" counts come from `inbound_events` (7 days). Audit actions: `channel.connected`, `channel.reply_cap`, `channel.domain_added`, `channel.domain_removed`, `channel.delivery_retry`.
- **Package cycle fixed:** session 1 had added `@kaki/inbox` as a dev dependency of `@kaki/channels`, which made turbo's build graph cyclic (`pnpm typecheck` failed). The receive and deliver integration tests moved to `apps/agent-worker/test/` (new `test:integration` script there); keep it that way.
- Footer GOV-14 question from session 1 still open for verify (template notice shows the business name only).

## Left to CI or later
- E2E (`email-channel.e2e.ts`) and renders: GitHub CI in verify. Terraform: written and tested, not applied (MD).
- Time-of-day failures seen here, not caused by this feature: agent `language-hours` "closed today" and api `escalation.int` two cases (run at 22:40 SGT, after hours); api `uploads.int` needs LocalStack (no Docker).

## Pending for Ken
- Nothing blocking.
