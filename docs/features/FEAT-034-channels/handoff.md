# Handoff: FEAT-034 — Channel framework: adapter contract, go-live and go-offline per channel, health and degraded alerts
Branch: feat/FEAT-034-channels · PR: none · Updated: 2026-10-27 by design
Stage done: design
Next: build (backend, T1–T6) — kickoff: "Build FEAT-034 (backend) on branch feat/FEAT-034-channels. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- 11 tasks: backend T1–T6, then `## Build session 2 (UI)` T7–T11 (kickoff "Build FEAT-034 (UI) on branch feat/FEAT-034-channels. …").
- Migration is `0034_channels.sql`. The seed (`packages/db/src/setup.ts` `seed()`) must set the dev tenants' widget rows `live`, or every existing agent, api and E2E suite stops answering (the trigger makes new tenants offline + hidden; D3).
- The widget is registered, not re-plumbed (D2): no widget adapter class; its registry entry has `checksHealth: false`. The health job therefore checks nothing in dev; T3 tests it with `test/fake-adapter.ts` in a test registry.
- The old minimal `ChannelAdapter`/`InboundMessage`/`OutboundMessage` in `packages/channels/src/index.ts` are unused; replace them with `adapter.ts`.
- Gate order: paused → missing → not_ai → not_live (kill switch wins). `not_live` makes no model call and stores the offline text once in a row.
- `@kaki/channels/contract-suite` imports Vitest: declare it as a separate `exports` entry and keep it out of `src/index.ts` (like `@kaki/db/testing`); check dependency-cruiser allows it only from tests.
- No KMS SDK and no new config for credentials (D5); only `CHANNEL_HEALTH_INTERVAL_MS` is new (scheduler `.env.example`).
- Alerts are in-app only (banner + Channels page, D6); FEAT-052 turns the `channel.degraded` audit transition into an email.

## Left to CI or later
- E2E `channels.e2e.ts` and the widget size budget run in Ken's local CI: widget files change, so CI is due before merge.

## Pending for Ken
- Nothing blocking. Decisions D1–D10 are in technical-design §7; D3 (dev tenants backfilled live, new tenants start offline and hidden) and D6 (degraded alerts in-app until FEAT-052) are the ones to glance at.
