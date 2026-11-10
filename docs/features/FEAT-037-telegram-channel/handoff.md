# Handoff: FEAT-037 — Telegram channel
Branch: feat/FEAT-037-telegram-channel · PR: none · Updated: 2026-11-10 by build (backend, part 1)
Stage done: build (T1–T6 of 12)
Next: build (backend, continued: T7–T8) — kickoff: "Build FEAT-037 (backend) on branch feat/FEAT-037-telegram-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Start at T7 (alerts on Telegram), then T8 (dashboard routes, Terraform); stop at `## Build session 2 (UI)` with the UI kickoff.
- `notify` already writes `channel` and conflicts on `(tenant_id, user_id, channel, dedupe_key)`, but `kinds.ts` `CHANNELS` is still `['email']`: widen it in T7 together with `send.ts` (otherwise telegram rows would be mailed). `channel_degraded` alerts already fire from `recordHealth`/`reportSendFailure` (recipients via `channel_alert_recipients()`, Owners/Admins) and cancel on recovery; T4's test asserts the email rows only, T7 adds the Telegram row assertion.
- Link codes: `/start link-<22 base64url>` (`LINK_CODE`, `codeHash` = sha256) is already handled by `receiveTelegram` (link, expired, `/stop` and a member blocking the bot unlink). T7 writes the code: `telegram_alert_links` insert/update (`code_hash`, `code_expires_at`) in the dashboard zone under `withMember` (@kaki/db; sets `app.user_id` for the own-row policy). `linkPending()` gives `pending`.
- Alert sender (T7): read the link and the credential in the visitor zone (`channel_credential()`), never the identity zone (D9). The scheduler has no visitor DB yet: add `VISITOR_DATABASE_URL`, `CHANNEL_SECRET_KEY`, `TELEGRAM_API_BASE` to its config, `.env.example` and `scripts/gen-local-env.mjs` (api and agent-worker already have them).
- Deviations from the design, all small: `telegram_chats.bot_id` (to drop a previous bot's chats on connect); `telegram_alert_links.staff_notice_at` (the hourly staff-chat reply); credentials are write-only for the dashboard (column grants) and read through SECURITY DEFINER `channel_credential()`; `telegram_alert_link_count()`/`telegram_alert_links_clear()` because the dashboard sees only its own link row. The sealer is `localSealer(CHANNEL_SECRET_KEY)` (32 bytes base64url, the same in api, agent-worker, scheduler); KMS replaces it at MD (pending actions).
- Test-only fake Bot API: `@kaki/channels/telegram-fake` (`fakeBotApi()` as a `fetch`, `fixtureToken(id)`); tokens with `revoked` give 401. The api takes it through `Deps.telegram = { api: { base, fetch } }` (`testApp(tdb, { telegram })`). The UI session's `scripts/telegram-fake.mjs` can follow the same rules.
- `SendResult` gained `reason: 'blocked'` and `retryAfterSeconds`; `deliverMessage` maps them (`failed`/`blocked`, 429 wait). `ChannelCapabilities.footer` (`with_disclosure` for Telegram) is in `shape.ts`.
- Old tests changed only where the design changed behaviour (each says why): Telegram may be hidden offline (offline-mode checks now use `messenger`), the outbox zone may insert/cancel notifications, the dashboard may write (not read) a credential, the registry lists Telegram, `channel=telegram` is valid, "channel" allowed in `channel_degraded`'s text.
- Email's ignored counts now filter by connection (they counted Telegram's too).
- Already done ahead of T7/T8 to keep the contracts green: the sidebar's `telegramUsername` (`contactOf`), `sendTo.telegram: null` and `TestAlertResult.telegram: false` placeholders in `notifications.ts` (T7 fills them), `channel_degraded` listed only for `settings.manage`.
- Here, `uploads.int` (S3 presigner) and platform `rate-limit.int` need LocalStack/Valkey containers and can't run in a cloud session; everything else in api/platform integration is green.

## Left to CI or later
- E2E (`telegram-channel.e2e.ts`) with `scripts/telegram-fake.mjs`; screen renders; `terraform test`.
- Live bot checks at MD.

## Pending for Ken
- None.
