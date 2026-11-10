# Handoff: FEAT-037 — Telegram channel
Branch: feat/FEAT-037-telegram-channel · PR: https://github.com/codeforests/kakiagent/pull/62 · Updated: 2026-11-10 by verify
Stage done: verify (accepted)
Next: merge on Ken's go-ahead, then design FEAT-039.

## What the next stage needs
- Report: `acceptance-report.md`. Two E2E selector/timing corrections in `telegram-channel.e2e.ts` (row by ID via search; retry "Check again" past its 30 s cooldown).
- Contacts now carry `telegram_id`/`telegram_username` and never merge automatically (D5); CHN-08 merge is FEAT-039's.

## Left to CI or later
- Live BotFather bot, public webhook, revoke/replace at MD.

## Pending for Ken
- Merge PR #62.
