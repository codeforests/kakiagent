# Handoff: FEAT-037 — Telegram channel
Branch: feat/FEAT-037-telegram-channel · PR: draft (see the thread) · Updated: 2026-11-10 by build (UI)
Stage done: build (T1–T12 of 12; developer-done)
Next: verify — kickoff: "Verify FEAT-037 on branch feat/FEAT-037-telegram-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `pages/telegram-channel.tsx` + `telegram-channel-parts.tsx`, `lib/telegram-channel.ts`; Notifications Telegram column in `pages/notifications.tsx`; inbox `placeholderKind`/`channelCaption` (`lib/inbox.ts`), `Bubble` `channel` prop, Telegram `CopyRow`; Channels' Telegram card (`TelegramMeta` reads `GET /channels/telegram`, since `ChannelItem` has no username).
- An Agent gets 403 on `GET /channels/telegram`, so the page shows only the alerts card (their own link).
- The "no email alerts" note on Notifications now counts email switches only (ui-design: Telegram switches don't change it).
- E2E `e2e/tests/telegram-channel.e2e.ts` uses `scripts/telegram-fake.mjs` (`pnpm fixtures:telegram`, :5177, Playwright `webServer`; controls `/_fake/update|sent|revoke|block`). It routes escalations to the Owner for its alert step and restores round robin, alert prefs, the link and the bot in `afterEach`. Never run against a real stack yet: expect first-run fixes (selectors, timings).
- Backend fix in this session: `apps/api/src/telegram-channel.ts` hook rate-limit `allowed` (lint `no-useless-assignment`).

## Left to CI or later
- All E2E (incl. older specs that may now see Telegram in Channels' Connect list or the inbox filter), screen renders, tflint.
- platform/api `test:coverage` thresholds: here `rate-limit.int` (Valkey) and `uploads.int` (LocalStack) can't start, so coverage stopped there; all other suites passed.
- Live bot checks at MD.

## Pending for Ken
- None.
