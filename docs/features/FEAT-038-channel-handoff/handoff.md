# Handoff: FEAT-038 — Continue on another channel with the history
Branch: feat/FEAT-038-channel-handoff · PR: https://github.com/codeforests/kakiagent/pull/64 · Updated: 2026-11-11 by verify
Stage done: verify (accepted)
Next: merge (Ken approved), then M4: FEAT-026 → 029, then M4 close.

## What the next stage needs
- Verify fixed the confirm page's `Referrer-Policy` (`same-origin`; `no-referrer` made browsers POST `Origin: null`).
- Verify ported a FEAT-055 `approvals.int` date fix (fixed `now`) and made `handoff.e2e` wait for its Telegram deliveries.

## Left to CI or later
- Live Telegram bot and live email at MD, as for FEAT-036/037.

## Pending for Ken
- Confirm-page copy follow-up and the phone thread/banner layout bug (pending actions).
