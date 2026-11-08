# Handoff: FEAT-036 — Email channel
Branch: feat/FEAT-036-email-channel · PR: none · Updated: 2026-11-08 by build (backend 3)
Stage done: build (T1–T10 of 14)
Next: build (UI, T11–T14) — kickoff: "Build FEAT-036 (UI) on branch feat/FEAT-036-email-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- **UI (T11–T14) contracts:** `GET/POST /api/v1/channels/email` → `EmailChannelResponse`; `PUT …/reply-cap` (`EmailReplyCapBody`; 422 `invalid_body` with `fields`, 409 `stale`); `POST …/domain` (`EmailDomainBody`; 422 `platform_domain`, 502 `provider_unavailable`), `POST …/domain/check` (429 `too_soon`; the response's records carry that check's per-row result), `DELETE …/domain` (`EmailDomainRemoveBody`); every write answers the fresh `EmailChannelResponse`. `POST /api/v1/messages/:id/delivery/retry` → 202 (409 `not_failed`) and publishes a `message` event with `delivery.status: 'sending'`; `GET /api/v1/attachments/:id` → 302. Thread messages carry `delivery` and `attachments`; summaries carry `subject`; the list takes `channel=email`. Go live/offline and offline settings are FEAT-034's routes on the email connection; the Channels page's Connect entry comes from the registry (`connectPath /settings/channels/email`).
- Local: `EMAIL_IDENTITY_PROVIDER=fixture` (api and scheduler `.env.example`): a `.test` domain verifies on its first check; E2E can add `hello@kakibakery.test`. `pnpm email:receive <file.eml>` feeds a fixture through the local bucket and queue (fixtures in `packages/channels/test/fixtures/email/`).
- Decisions taken in build: reply-cap and domain bodies answer 422 (not 400) for invalid values; records shown from the stored state between checks (verified → all ok, no DMARC row). The Gmail "ignored" counts come from `inbound_events` (7 days). Audit actions: `channel.connected`, `channel.reply_cap`, `channel.domain_added`, `channel.domain_removed`, `channel.delivery_retry`.
- Receive and deliver integration tests live in `apps/agent-worker/test/` (moving them fixed a turbo build cycle); keep `@kaki/channels` free of an `@kaki/inbox` dependency.
- T10 (Terraform) is done; nothing in it affects the UI. Terraform in a cloud session: download 1.16.6 from releases.hashicorp.com and the providers into a filesystem mirror (`TF_CLI_CONFIG_FILE`), since registry.terraform.io is blocked.
- Footer GOV-14 question from session 1 still open for verify (template notice shows the business name only).

## Left to CI or later
- E2E (`email-channel.e2e.ts`) and renders: GitHub CI in verify. Terraform: tested on mocked providers, not applied (MD).
- MD checks: SES email receiving must be available in ap-southeast-1 when applied (the design assumes it); add the `dns_records` output (now with the `in.` MX, DKIM and MAIL FROM rows) at the DNS host.
- Time-of-day failures seen here, not caused by this feature: agent `language-hours` "closed today" and api `escalation.int` two cases (after hours SGT); api `uploads.int` needs LocalStack (no Docker).

## Pending for Ken
- Nothing blocking.
