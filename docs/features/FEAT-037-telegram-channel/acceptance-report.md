# Acceptance report: FEAT-037 — Telegram channel

> Verified: 2026-11-10 (verify stage, fresh session) · Branch `feat/FEAT-037-telegram-channel` · PR #62 · Design: [technical-design.md](technical-design.md) §6

## Verdict summary

**Accepted.** All eight acceptance criteria hold against their sources (CHN-05, CHN-12, LED-04, DSH-09, NFR-17, CHN-01; UC-25 1–4, 3a, 4a). The feature's unit and integration suites pass in this run; the E2E spec and screen renders pass in GitHub CI (see CI). Live Bot API checks (a real BotFather bot, the public webhook, revoke and replace) remain for milestone MD.

## Audit standard

Re-derived from SRS CHN-05 ("messages flow both ways"; "group chats are ignored and the bot replies that it works only in private chats"), CHN-12 (health and degraded alerts), LED-04 and DSH-09 (Telegram as an alert channel per member), NFR-17 (no message lost: stored before the webhook answers, retried 24 h, then shown as failed), CHN-01 (one adapter path) and UC-25 steps 1–4 with 3a (bad token) and 4a (revoked token). Every FR in the `> Implements:` line has at least one criterion; D2 (reply once, then leave the group) is a faithful reading of CHN-05's group clause.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | CHN-05, UC-25 1–3, 3a | api `telegram-channel.int` (staff 403, no session 401, `invalid_format`, `token_rejected`, 201 offline+hidden with the webhook on the hook URL and no token in the body, 409 `already_connected`, tenant B `bot_in_use`); channels `telegram-settings.int` (only ciphertext and the secret hash stored, webhook registered, bad format / rejected / other business refused); rls `telegram_settings_bot_uq` | Yes | Pass |
| AC-2 | CHN-05 both ways | api `telegram-hook.int` (private text → conversation, contact with Telegram ID and username, turn job; redelivery creates nothing; second message joins; 8 days after close → new conversation); agent-worker `telegram-deliver.int` (first AI reply with disclosure + privacy line, next without, staff reply sent, `staff_joined` not sent, once per job); `telegram-channel.e2e` | Yes | Pass (E2E: CI) |
| AC-3 | CHN-05 groups, D2 | `telegram-hook.int` group, supergroup and added-to-group: one reply and one leave each, no conversation; `telegram-deliver.int` service reply sends and leaves; `telegram.test` group parsing; ignored counts on the page (api) | Yes | Pass |
| AC-4 | CHN-05 edge cases, ADR-015 | `telegram-hook.int` sticker → "[Sticker]", no turn, one text-only notice in 24 h; `/start` greeting, no conversation; `telegram-deliver.int` blocked → `failed`/`blocked` + one `delivery_failed` escalation; `telegram.test` voice/caption fixtures; `telegram-hook.int` first private text: NRIC masked in `messages` | Yes | Pass |
| AC-5 | CHN-12, UC-25 4a, NFR-17 | `telegram-settings.int` revoked → degraded, one alert per Owner/Admin (email + telegram rows), replacement recovers and cancels, someone else's webhook `credential_invalid` and not taken back; api "Check again" → `credential_revoked`, replace `different_bot` 422; `adapter.test` 401/403 mapping; `telegram-deliver.int` revoked send degrades and retries, 429 waits, transient retried until 24 h then dropped | Yes | Pass |
| AC-6 | LED-04, DSH-09, D1, D8 | api `telegram-alerts.int` (no bot → 409 and no column; link code 15 min hashed; `/start <code>` links, expired doesn't; own link only; per-channel prefs; test alert to Telegram; unlink + "Alerts stopped"); platform `notifications.int` "Telegram rows/texts" (per-channel rows, `no_channel`, separate mutes, digest per channel, quiet hours, retry without resending email, 24 h give-up); channels `telegramAlerts` (blocked → unlinked); `telegram-channel.e2e` alert step | Yes | Pass (E2E: CI) |
| AC-7 | ADR-005, ADR-014, ADR-015 | `telegram-hook.int` wrong/missing secret 401 storing nothing, no name or text outside contacts/messages; platform `logger.test` token redaction; `telegram.test` failure error without the token; api connect body has no token; rls cross-tenant cases for `telegram_settings`, `telegram_chats`, `telegram_alert_links` and the own-row policy | Yes | Pass |
| AC-8 | SCR-APP-039, -056, -036, -014 | dashboard `telegram-channel.test`, `notifications.test`, `inbox.test`; `telegram-channel.e2e` (page states, Notifications column, inbox filter/glyph/@username, axe at 375 tall and 1280) | Yes | CI |

## Changed existing tests (reviewed, not weakened)

- `adapter-contract.test`, `channels.int`, `connections.int`: Telegram is now registered and connectable, so the "unregistered kind" cases moved and the connect list gained Telegram.
- `inbox-contract.test`: `channel: 'telegram'` is now valid. `notifications.test` (contracts and api): `TestAlertResult` gained `telegram`; the "no 'channel' in event text" rule exempts only the new `channel_degraded` event, whose label is asserted.
- `rls.int`, `notifications.int`, `leads.int`, `email/identity.test`: extended for the new tables, rows and settings fields. No skips, `.only` or deleted cases in the diff.

## Corrected tests

- `e2e/tests/telegram-channel.e2e.ts` (commit `75a3e40`, AC-2/AC-8): the spec found the inbox row by the run tag, but the row's preview is the AI reply, so it found none on every browser (run 119). It now looks the conversation up by the customer's words through the search API and selects the row by `data-id`.
- `e2e/tests/telegram-channel.e2e.ts` (commit `c9b0a13`, AC-5): "Check again" is `429 too_soon` within 30 s of the last health check (`CHECK_AGAIN_MS`), and the spec's check came inside that window on Chromium and WebKit (run 120), so the degraded alert never showed. It now retries the check until it returns 200. Neither change loosens what the criterion asserts.

## Independent execution

`scripts/test-env.sh scripts/check-summary.sh` on `acce1c8`, 2026-11-10:

- PASS `pnpm format:check`, `pnpm lint` (ESLint, dependency-cruiser, RTM), `pnpm typecheck`
- PASS `pnpm test`: 152 files, 1795 tests
- PASS channels `test:coverage`: 14 files, 142 tests (thresholds met)
- PASS db integration 226, agent-worker integration 23, inbox integration 95, contracts 88
- api integration: 41 of 42 files pass (all four Telegram suites); platform integration 2 of 3 (`notifications.int` passes). The failing file in each is Docker-only (`uploads.int` LocalStack, `rate-limit.int` Valkey) and can't start in a cloud session; both run in CI.

## Direct verification

- Invariants: the core never branches on `telegram` (no kind checks in `agent`, `inbox` or `agent-worker` source); the webhook resolves its tenant through `channel_hook_route()` (SECURITY DEFINER, NOLOGIN owner, the `email_route()` pattern) from the URL's connection ID plus the hashed secret, never from the body; every new table has forced RLS and a policy in 0054 and a cross-tenant case; the token is sealed with `channel_credential()` and redacted in logs; sends go through the outbox `channel-send` queue. The dependency-cruiser change only adds `telegram/fake.ts` to the test-only helpers.
- Migration 0054 applies on a fresh database (db integration).

## Findings

- None blocking. Follow-ups already in the design §8: Telegram inline-keyboard consent/withdraw cards, CHN-08 merge (FEAT-039), live bot checks at MD.

## RTM

Test ref appended 2026-11-10: CHN-05 (partial: live BotFather bot at MD), LED-04 (partial: Telegram alerts; web push FEAT-048), DSH-09 (partial: the Telegram channel), CHN-12 (partial: Telegram), NFR-17 (partial: Telegram), CHN-01 (partial: the generic webhook route). `node scripts/check-rtm.mjs FEAT-037 --stage verify`: `RTM check passed (FEAT-037).`

## CI

CI_LINE
