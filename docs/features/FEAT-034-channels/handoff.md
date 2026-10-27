# Handoff: FEAT-034 — Channel framework: adapter contract, go-live and go-offline per channel, health and degraded alerts
Branch: feat/FEAT-034-channels · PR: none · Updated: 2026-10-27 by build (backend)
Stage done: build (T1–T6 of 11)
Next: build (UI, T7–T11) — kickoff: "Build FEAT-034 (UI) on branch feat/FEAT-034-channels. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (`apps/api/src/channels.ts`, `settings.manage`): `GET /api/v1/channels` → `ChannelsResponse`; `POST /api/v1/channels/:id/live|offline` `{ version }` → `ChannelItem` (repeat = 200, unchanged); `PUT /api/v1/channels/:id/offline-settings` `ChannelOfflineBody` → `ChannelItem`; `POST /api/v1/channels/:id/check` (widget: 400 `no_health_check`; 429 `too_soon`).
- Errors: 404 `not_found`, 409 `version_conflict`, 400 `invalid_body` with `fields` (`{ mode: 'not_allowed' }`, `{ 'message.en': 'max_300' }`, `{ 'message.zh': … }`), 403 `forbidden`.
- Contracts in `@kaki/contracts` (section "Dashboard API: channels"): `ChannelItem`, `ChannelsResponse`, `ChannelStateBody`, `ChannelOfflineBody`, `OfflineText`, `ChannelOfflineMode`, `ChannelHealthReason`, `CHANNEL_OFFLINE_TEXT_MAX` (300). The defaults come in each item's `offline.defaults`.
- Widget: `WidgetConfigResponse.availability` is required: `{ live: true }` or `{ live: false, mode, message: { en, zh } (resolved), contact: { email, phone } }`. `apps/widget/src/preview.ts` passes `{ live: true }` already; `chat.test.ts` fixtures may need it when T9 touches them. `POST /widget/v1/conversations` returns 409 `{ error: 'not_live' }` while offline.
- Seeded dev tenants are live; the bakery has email and phone, the second tenant no contacts (good for the "no contacts" state).
- The agent's offline notice is a `system` message with outcome `not_live`; the dashboard's coaching explainer already renders `not_live` (`lib/coach.ts`).
- No channel can be degraded in dev (only the widget is registered, `checksHealth: false`). To see the degraded banner and state, stub the API in Playwright, or set a row by hand: `insert into channel_connections (tenant_id, kind, offline_mode, health, health_reason, degraded_since) values (…, 'telegram', 'message', 'degraded', 'credential_revoked', now())`; it lists only if the kind is registered, so stubbing is simpler.

## Deviations from the design
- Contracts landed in T3 (the domain returns `ChannelItem`). `runChannelHealth` takes no sealer (adapters get the sealed `CredentialRef` and own their sealer). `checkChannelNow` takes a `credentialOf` dep since the dashboard zone can't read credentials; FEAT-036/037 supply it (e.g. a definer function).
- The outbox zone gained `INSERT` on `audit_entries` and `EXECUTE audit_head_lock()` (it audits `channel.degraded`/`recovered`); it still can't read entries.
- `@kaki/agent` and `@kaki/scheduler-worker` now depend on `@kaki/channels` (lockfile links).

## Left to CI or later
- E2E `channels.e2e.ts` and the widget size budget run in Ken's local CI: widget files and the lockfile change, so CI is due before merge.
- Not run here: `uploads.int.test.ts` "the S3 presigner" (needs an S3 endpoint), and `agent` `language-hours` "carries the notice once per closed period" fails on the design commit too (clock-dependent regex: "tomorrow at midnight"); verify should look at it.

## Pending for Ken
- Nothing blocking.
