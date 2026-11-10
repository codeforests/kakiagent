# Handoff: FEAT-037 — Telegram channel
Branch: feat/FEAT-037-telegram-channel · PR: none · Updated: 2026-11-10 by build (backend, part 2)
Stage done: build (T1–T8 of 12; backend complete)
Next: build (UI: T9–T12) — kickoff: "Build FEAT-037 (UI) on branch feat/FEAT-037-telegram-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (all `apps/api/src/telegram-channel.ts` unless noted; contracts in `packages/contracts` "Telegram section"):
  `GET`/`POST /api/v1/channels/telegram` (`TelegramChannelResponse`; POST `{ token }` → 201), `PUT /api/v1/channels/telegram/token` `{ token, settingsVersion }`, `DELETE /api/v1/channels/telegram` `{ settingsVersion }` → 200 view. `settings.manage` only (staff 403). Errors `{ error, message }`: 422 `invalid_format` / `token_rejected` / `different_bot` / `invalid_body`, 409 `already_connected` / `not_connected` / `bot_in_use` / `stale`, 502 `provider_unavailable` (`TelegramChannelErrorCode`).
- "Check again" is the existing `POST /api/v1/channels/:id/check`; it now checks Telegram (getMe + webhook) too.
- Alerts (`apps/api/src/notifications.ts`): `GET /api/v1/me/notifications` has `channels: ['email','telegram']` and `events[].telegram` only when the business has a bot; `sendTo.telegram` is `TelegramAlertLink` (`not_linked` | `pending` | `linked`, `name`, `linkedAt`) or null (no bot → no column). `PUT` takes `events[].telegram` (absent = unchanged). `POST …/telegram/link` → 201 `{ url: https://t.me/<bot>?start=link-…, expiresAt }` (15 min; a new one replaces the old), 409 `no_bot`. `DELETE /api/v1/me/notifications/telegram` → 204. Test alert's `telegram: true` when linked.
- Linking completes when the member taps Start in Telegram (the webhook links it); the page polls `GET /me/notifications` while `pending`.
- Fakes: `@kaki/channels/telegram-fake` (`fakeBotApi()`, `fixtureToken(id, suffix)`: `<id>:fixture<suffix>xxx…`; tokens containing `revoked` or `revoke()`d give 401; `blocked` set gives 403). The api takes it via `testApp(tdb, { telegram: { api: { base, fetch } } })`. `scripts/telegram-fake.mjs` (T11, :5177) should follow the same token rules; `TELEGRAM_API_BASE` already points there in `gen-local-env.mjs` for api, agent-worker and scheduler.
- Deviations (recorded in tasks.md T7/T8): `notify` writes a Telegram row only when the business has a bot (`alert_channels()` in 0054), so tenants without Telegram are unchanged; the scheduler binds the Telegram adapter for its health job and needs `PUBLIC_HOOKS_URL`, `VISITOR_DATABASE_URL`, `CHANNEL_SECRET_KEY` (in `.env.example`, `gen-local-env.mjs`, prod Terraform). Terraform: `/hooks/*` on ALB and CloudFront, WAF `body-size` rule (8 KB limit kept outside `/hooks/*`), `channel-secret-key` secret.
- E2E: the scheduler must run with `VISITOR_DATABASE_URL` etc. (regenerate `.env` with `node scripts/gen-local-env.mjs`). A Telegram alert E2E must turn the member's quiet hours off (CI evening runs).
- T12's `code-map.md` lines: the Telegram adapter, the hook route, alert channels (`TelegramAlertSender` port in platform, `telegramAlerts` in channels, bound by the scheduler).

## Left to CI or later
- E2E (`telegram-channel.e2e.ts`) with `scripts/telegram-fake.mjs`; screen renders; tflint.
- Here `uploads.int` (LocalStack) and platform `rate-limit.int` (Valkey) can't run; everything else in api, platform, channels, agent, inbox, leads, approvals, db, agent-worker is green.
- Live bot checks at MD.

## Pending for Ken
- None.
