# Handoff: FEAT-037 — Telegram channel
Branch: feat/FEAT-037-telegram-channel · PR: none · Updated: 2026-11-09 by design
Stage done: design
Next: build (backend) — kickoff: "Build FEAT-037 (backend) on branch feat/FEAT-037-telegram-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Backend is T1–T8, UI is T9–T12 (split at `## Build session 2 (UI)`).
- D1 (alerts from the business's own bot, linked per member by a `t.me/<bot>?start=<code>` link) was chosen by Ken on 2026-11-09.
- Reuse FEAT-036's delivery trigger, `deliverMessage` and `inbound_events`; rename `EmailInboxPort` to `InboxPort` with a `channel` parameter.
- Receive runs in the api's webhook transaction (D10), no new queue; service replies (group notice + leave, link confirmations, greeting) are `channel-send` jobs of `type: 'service'`.
- Telegram 403 "blocked by the user" is `permanent`/`blocked`, never `auth` (a blocked customer is not a revoked token).
- `notify` writes one row per channel (D8); `NotificationPrefsBody` widens with `AlertEvent` (new `channel_degraded`).
- The bot token: sealed, never logged (redact `/bot<token>/`), never in the identity zone (D9).

## Left to CI or later
- E2E (`telegram-channel.e2e.ts`) with `scripts/telegram-fake.mjs`; screen renders; `terraform test`.
- Live bot checks at MD.

## Pending for Ken
- None.
