# Technical Design: FEAT-034 — Channel framework: adapter contract, go-live and go-offline per channel, health and degraded alerts

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E5) · Milestone: M2
> Implements: CHN-01 (the ADR-011 `ChannelAdapter` contract, the channel registry and its contract-test suite), ONB-10 (go live and go offline per channel as explicit Owner/Admin actions; a channel that isn't live never gets an AI reply; the pre-live widget mode "hidden" or "message"), CHN-12 (p: health checks every 5 minutes, send-rejection hook, degraded state shown on the Channels page and in a dashboard banner; alert emails arrive with FEAT-052 and Telegram alerts with FEAT-037, D6) · Realizes: UC-25 step 4 (set live) and 4a (degraded), UC-03 (go live per channel; the readiness check is FEAT-035) · Screens: SCR-APP-036 (new), SCR-WGT-005 (p: not live; the contact form is FEAT-049) (see [ui-design.md](ui-design.md))
> Status: Designed · Date: 2026-10-27

## 1. Intent

Today every tenant's widget answers as soon as it's installed, and nothing in the product can stop one channel without pausing the whole AI. This feature gives every channel a connection row with an explicit live/offline state that only an Owner or Admin changes, and puts "channel live" into the AI send gate, so a channel that isn't live never gets an AI reply (ONB-10). While the widget is offline the tenant chooses whether the chat button is hidden or shows a short "we're not open yet" message with the business's contact details. It also lays the ground for the channels that come in M4: the full ADR-011 adapter contract, a registry that makes a new channel "an adapter module and a config entry" (CHN-01), sealed credential storage, and a scheduler job that checks each connection's health every 5 minutes and marks a broken one degraded, which the dashboard shows on the Channels page and in a banner on every page (CHN-12).

## 2. Codebase context

- **Contract today:** `packages/channels/src/index.ts` has a minimal `ChannelAdapter` (`kind`, `normalise`, `send`) used by nothing, `ChannelKind`, and the widget origin rule. Channels also owns `widget_settings` (`widget-settings.ts`, FEAT-032) and the `@kaki/channels/theme` export.
- **Send gate:** `aiAllowed` (`packages/agent/src/gate.ts`) checks the kill switch and the conversation status; its comment reserves "channel live (FEAT-034)". `runVisitorTurn` (`turn.ts`) stores the persona fallback when the gate says `paused` and nothing for other closed reasons; it re-checks the gate before each segment (`gate_closed` branch).
- **Coaching and replay** (`coach.ts`, `replay.ts`) take an optional `channelLive` dep that no caller passes (defaults to live); `VisitorsWouldGet` already has `not_live`, and the dashboard shows it (`lib/coach.ts`).
- **Widget API** (`apps/api/src/app.ts`): `GET /widget/v1/config` resolves the key, records the install, and reads tenant values through SECURITY DEFINER functions (`visitor_tenant_state()`, `visitorWidgetTheme`, `visitor_privacy()`); `POST /widget/v1/conversations` creates a conversation; `conversations.channel` is `enum ['widget']`.
- **Tenants** are created only by the dev seed (`packages/db/src/setup.ts` `seed()`, also used by `startTestDatabase`); sign-up arrives later, so a trigger on `tenants` is the one place every path passes.
- **Scheduler** (`apps/scheduler-worker/src/main.ts`): `setInterval` jobs on the outbox zone; cross-tenant jobs call a SECURITY DEFINER function owned by a NOLOGIN role (`kb_stale_scan`, `kb_gap_cluster`), then work per tenant with `withTenant`.
- **Settings pattern:** `apps/api/src/settings.ts` / `widget.ts` (`manager()` checks `settings.manage`, optimistic `version`, `version_conflict` 409, audit names fields not text). The Settings index row "Channels" has no `to` yet; the shell has no banner component.
- **Business profile:** `contact_email`, `contact_phone` on `business_profiles` (FEAT-009) are the public contact details for the offline message.
- **No KMS client** in the lockfile and no crypto helper in `platform`.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: channels (ONB-10, CHN-12; FEAT-034 §3)`)

```ts
ChannelKind = z.enum(['widget', 'email', 'telegram', 'messenger', 'instagram', 'whatsapp'])
ChannelHealthReason = z.enum(['credential_revoked', 'credential_invalid', 'unreachable', 'send_rejected'])
OfflineText = z.object({ en: z.string().trim().min(1).max(300).nullable(), zh: z.string().trim().min(1).max(300).nullable() })
ChannelItem = z.object({
  id: z.uuid(), kind: ChannelKind, name: z.string(),              // name from the registry ("Website chat widget")
  state: z.enum(['live', 'offline']),
  stateChangedAt: z.iso.datetime().nullable(),                   // null = never changed (never live)
  health: z.enum(['ok', 'degraded', 'unknown']),
  healthReason: ChannelHealthReason.nullable(),
  healthCheckedAt: z.iso.datetime().nullable(),
  degradedSince: z.iso.datetime().nullable(),
  checksHealth: z.boolean(),                                     // registry: false for the widget
  offlineModes: z.array(z.enum(['hidden', 'message'])).min(1),   // widget: both; others: ['message']
  offline: z.object({ mode: z.enum(['hidden', 'message']), message: OfflineText,
                      defaults: z.object({ en: z.string(), zh: z.string() }) }),
  version: z.number().int().positive(),
})
ChannelsResponse = z.object({ channels: z.array(ChannelItem),
  connectable: z.array(z.object({ kind: ChannelKind, name: z.string(), connectPath: z.string() })) })  // [] until FEAT-036
ChannelStateBody = z.object({ version: z.number().int().positive() })
ChannelOfflineBody = z.object({ mode: z.enum(['hidden', 'message']), message: OfflineText, version: z.number().int().positive() })
```

| Route (dashboard, `settings.manage`) | Body | 200 | Errors |
|---|---|---|---|
| `GET /api/v1/channels` | — | `ChannelsResponse`, registry order | 403 Agent |
| `POST /api/v1/channels/:id/live` | `ChannelStateBody` | `ChannelItem` (already live: 200, no audit) | 404 unknown or another tenant's id; 409 `version_conflict`; 403 |
| `POST /api/v1/channels/:id/offline` | `ChannelStateBody` | `ChannelItem` (already offline: 200, no audit) | as above |
| `PUT /api/v1/channels/:id/offline-settings` | `ChannelOfflineBody` | `ChannelItem` | 400 `invalid_body` (field errors; a mode not in `offlineModes`); 404; 409; 403 |
| `POST /api/v1/channels/:id/check` | — | `ChannelItem` after one health check | 400 `no_health_check` (`checksHealth` false); 429 within 30 s of the last check; 404; 403 |

**Widget config** (`WidgetConfigResponse`, new field):

```ts
availability: z.discriminatedUnion('live', [
  z.object({ live: z.literal(true) }),
  z.object({ live: z.literal(false), mode: z.enum(['hidden', 'message']),
             message: z.object({ en: z.string(), zh: z.string() }),          // stored text or the default, resolved
             contact: z.object({ email: z.string().nullable(), phone: z.string().nullable() }) }),
])
```

The config still answers 200 with a token when the widget is offline (the install check must work before go-live, FEAT-032 D8); `hidden` tells the loader not to mount. `POST /widget/v1/conversations` returns **409 `{ error: 'not_live' }`** when the widget connection isn't live. Messages on an existing conversation are still accepted (staff see them); the agent answers per §5.3.

## 4. Schema changes (migration `0034_channels.sql` + Drizzle table)

- **`channel_connections`** (tenant-scoped, forced RLS, policy, in `TENANT_SCOPED_TABLES`, RLS case): `id uuid pk`, `tenant_id` (FK, cascade), `kind` (check: the six kinds), `state` (`live`|`offline`, default `offline`), `state_changed_at timestamptz null`, `state_changed_by uuid null` (the user; no FK across zones), `offline_mode` (`hidden`|`message`, default `hidden`; check `kind = 'widget' or offline_mode = 'message'`), `offline_message_en`/`_zh text null` (≤ 300 chars, check), `health` (`ok`|`degraded`|`unknown`, default `unknown`), `health_reason text null` (check: the four reasons), `health_failures int not null default 0`, `health_checked_at`, `degraded_since timestamptz null`, `credential_ciphertext bytea null`, `credential_key_ref text null`, `version int not null default 1`, `created_at`, `updated_at`; `unique (tenant_id, kind)`, `unique (tenant_id, id)`.
- **Grants:** `app_dashboard` SELECT on every column **except** `credential_ciphertext` and `credential_key_ref` (column grants), UPDATE on `state`, `state_changed_at`, `state_changed_by`, `offline_mode`, `offline_message_en`, `offline_message_zh`, `version`, `updated_at`, plus the health columns (the "check now" route). `app_outbox` (scheduler) SELECT all columns, UPDATE the health columns. No INSERT for app roles yet (FEAT-036+ grant it with their connect flows). The visitor zone gets nothing on the table.
- **Trigger** `tenants_widget_connection` (AFTER INSERT ON tenants, SECURITY DEFINER, owned by the migration's NOLOGIN owner): inserts the tenant's widget connection, `offline`, `hidden`, health `ok` (the widget has no credential to check). Every future tenant starts not live (ONB-10).
- **Backfill:** one widget connection per existing tenant, `live` (D3), `state_changed_at = now()`.
- **`visitor_channel(p_kind text)`** SECURITY DEFINER, `stable`, granted to the visitor and agent roles: for the current tenant (`current_setting('app.tenant_id')`, nothing without it) returns `state`, `offline_mode`, `offline_message_en`, `offline_message_zh` and the business profile's `contact_email`, `contact_phone`. Never the credential.
- **`channel_health_due(p_kinds text[])`** SECURITY DEFINER, owned by a NOLOGIN role, EXECUTE for `app_outbox` only: `tenant_id, id, kind` of connections of those kinds (cross-tenant, IDs only).
- **Seed:** `seed()` upserts each dev tenant's widget connection to `live` after the tenant insert, so dev, E2E and every existing integration suite keep answering.

## 5. Component design

### 5.1 Channels module (`packages/channels/src/`)

- **`adapter.ts`** — the ADR-011 contract replaces the old minimal one in `index.ts`: `ChannelCapabilities` (`streaming`, `maxLength`, `richContent`, `attachments`, `replyWindow?`, `typing`), `RawInbound`, `VerifiedInbound`, `InboundEvent` (canonical: tenant, connection, external user ID, text, attachments, locale hint, timestamp, `extensions`), `OutboundMessage` (`id`, text, quick replies), `SendContext`, `SendResult` (`ok` | `{ failed: 'auth' | 'transient' | 'permanent', status? }`), `HealthStatus` (`{ ok: true } | { ok: false, reason: ChannelHealthReason }`), `CredentialRef`, `ChannelAdapter` with `verifyInbound`, `normalise`, `shouldIgnore`, `threadKey`, `send`, `stream?`, `checkHealth`, `connect?` exactly as ADR-011.
- **`registry.ts`** (ADR-011 "registration is configuration"; the file ADR-011 calls `channels.config.ts`) — `ChannelRegistryEntry { kind, name, adapter?: () => Promise<ChannelAdapter>, checksHealth, offlineModes, connectPath? }` and `CHANNEL_REGISTRY` with the widget only: `{ kind: 'widget', name: 'Website chat widget', checksHealth: false, offlineModes: ['hidden', 'message'] }` (D2). `registryEntry(kind)`, `connectable(registry, connectedKinds)`. Functions that need the registry take it as a parameter defaulting to `CHANNEL_REGISTRY`, so tests register a fake adapter without touching core code (AC-1).
- **`contract-suite.ts`** exported as `@kaki/channels/contract-suite` (test-only, like `@kaki/db/testing`): `adapterContractSuite(name, makeAdapter, fixtures)` registers Vitest cases: each recorded webhook fixture → `verifyInbound` → `normalise` gives the expected canonical events; ignore fixtures give the expected `IgnoreReason`; `send` twice with one `id` sends once; `checkHealth` maps a revoked-credential fixture to `credential_revoked`. `test/fake-adapter.ts` implements the contract and passes the suite.
- **`secrets.ts`** — `SecretSealer { seal(plain, aad): Promise<{ ciphertext: Uint8Array; keyRef: string }>; open(ciphertext, keyRef, aad): Promise<Uint8Array> }` and `localSealer(key32: Uint8Array)` (AES-256-GCM via `node:crypto`, random 12-byte IV, `keyRef = 'local:v1'`, AAD = connection ID so a blob can't be moved between rows). The KMS envelope sealer and its config arrive with the first adapter that stores a credential (D5).
- **`connections.ts`** —
  - `listChannels(tx, registry?)` → items in registry order (rows whose kind isn't registered are left out), `connectable` list.
  - `setChannelState(tx, { tenantId, id, state, version, userId })` → updates state, `state_changed_at/by`, bumps version; stale version → `ChannelConflictError`; unknown id → `ChannelNotFoundError`; same state → returns the row unchanged (no audit). Audits `channel.live` / `channel.offline` with `{ kind, connectionId }` only (ADR-014).
  - `saveOfflineSettings(tx, { …, mode, message, version })` → validates `mode` against the registry entry (`OfflineModeError` → 400), stores trimmed text or null; audits `channel.offline_settings` with `{ kind, mode, changed: ['message_en', …] }` (field names, no text).
  - `visitorChannel(tx, kind)` → `{ live, mode, message: { en, zh } (stored or default), contact }` via `visitor_channel()`; no row or no tenant context → not live, hidden (fail closed).
  - `OFFLINE_DEFAULTS` = en "Our chat isn't open yet. Please contact us directly for now." / zh 「我们的在线聊天尚未开放，请先直接联系我们。」
  - `recordHealth(tx, connection, status, now)` — the transition rules: `credential_revoked`/`credential_invalid` → degraded at once; `unreachable` → `health_failures + 1`, degraded at the second consecutive failure (one network blip isn't an alert; two checks 5 minutes apart still meet 15 minutes); `ok` → health ok, failures 0, `degraded_since` null. Entering degraded sets `degraded_since` and audits `channel.degraded` `{ kind, connectionId, reason }`; leaving it audits `channel.recovered`. Always sets `health_checked_at`.
  - `reportSendFailure(tx, connectionId, result)` — for adapters' send paths (FEAT-036+): `failed: 'auth'` (a 401/403) → degraded `send_rejected` at once (ADR-011); other failures change nothing here (the outbox retries, NFR-17).
  - `runChannelHealth(zdb, { registry, sealer, now, timeoutMs = 10_000 })` — `channel_health_due(kinds with checksHealth)`; per row, `withTenant` → load the connection → `adapter.checkHealth(credentialRef)` with the timeout (a throw or timeout counts as `unreachable`) → `recordHealth`. One failing tenant doesn't stop the others; returns counts for the log.
  - `checkChannelNow(tx, …)` for the dashboard's "Check again": the same per-connection step, refused with `NoHealthCheckError` when `checksHealth` is false and `TooSoonError` within 30 s of `health_checked_at`.

### 5.2 Workers and config

- **scheduler-worker:** a `channelHealthOnce` job every `CHANNEL_HEALTH_INTERVAL_MS` (default `300000`, in `.env.example`), first run at start-up, cleared on shutdown; logs counts (checked, degraded, recovered). With only the widget registered it finds nothing to check, which is correct.
- No new queue, outbox topic or infra (D6).

### 5.3 Agent (send gate and turn)

- `aiAllowed` gains the channel check after the conversation lookup: `visitorChannel(tx, conversation.channel)`; not live → `{ open: false, reason: 'not_live', tenant, offline }` (offline = the resolved message). Order: kill switch (`paused`) → missing → not AI-owned (`not_ai`) → not live. Kill switch wins over not live, so a paused tenant always shows the paused fallback.
- `runVisitorTurn`: gate `not_live` → no triage, retrieval or model call; stores the offline message (language from the visitor's message as for `paused`: zh text when the conversation's language is Chinese) as a `system` message with outcome **`not_live`** (new `TurnOutcome`), audited in the one `agent.decision` (code `not_live`). It stores nothing if the conversation's latest non-visitor message is already that text, so a visitor typing three times gets one notice. In the `gate_closed` branch (the widget went offline mid-reply) it keeps the released prefix and adds the offline message the same way as `paused`.
- Coaching and replay: the API passes `channelLive: () => withTenant(… visitorChannel(tx, 'widget')).live`, so the explainer's existing `not_live` case shows while the widget is offline (coaching itself keeps working: it's the dashboard entry point, ADR-009).

### 5.4 API (`apps/api/src/channels.ts`, `registerChannelRoutes(app, deps, sessionFrom)`, wired in `app.ts`)

- Routes per §3 through `manager()` (`settings.manage`) and `withTenant(dashboardDb, session.tenantId, …)`; errors map to 404 / 409 `version_conflict` / 400 `invalid_body` / 400 `no_health_check` / 429 `too_soon`.
- `/widget/v1/config` reads `visitorChannel(tx, 'widget')` in its existing tenant transaction and adds `availability`; `/widget/v1/conversations` checks it first and returns 409 `not_live`.

### 5.5 Dashboard and widget (detail in ui-design.md)

- `/settings/channels` (SCR-APP-036): the Settings row "Channels" links to it. `lib/channels.ts` (query, mutations, `channelStatus(item)` → live/offline/degraded display, `validateOffline`), calls in `lib/api.ts`.
- `shell/banners.tsx`: the page-wide banner slot (design.md `banner`, priority order, at most two); this feature adds "Degraded channel" (warning) for Owner/Admin, fed by the same `GET /api/v1/channels` query (refetch every 60 s and on focus). FEAT-057 adds "AI paused" to the same slot.
- Widget: `loader.ts` doesn't mount when `availability` is `{ live: false, mode: 'hidden' }`; `panel.tsx` renders the not-live view (message, contact links, no composer) when `mode: 'message'`; strings in `strings.ts`.

### 5.6 E2E (`e2e/tests/channels.e2e.ts`)

Owner on `/settings/channels` → widget Live → Go offline (confirm) → widget host page: no launcher (hidden) → set "Show a message", save → host page: launcher, panel shows the message and no composer → Go live (confirm) → host page: composer back. `afterEach` restores live and hidden (code-map E2E pitfalls). axe on the page, light and dark.

## 6. Acceptance criteria

- **AC-1** (CHN-01 "only a new adapter module and a config entry") `@kaki/channels` exports the ADR-011 `ChannelAdapter` contract and a registry; a fake adapter registered in a test registry passes `adapterContractSuite`, appears in `listChannels`, and is checked by `runChannelHealth`, with no change to `agent`, `inbox` or the API routes.
- **AC-2** (ONB-10 "explicit owner/admin actions per channel") An Owner or Admin sets a channel live or offline through its own route; an Agent gets 403; a stale version is 409; another tenant's connection ID is 404; each change writes one audit entry (`channel.live` / `channel.offline`) holding kind and connection ID only; repeating the current state changes nothing and audits nothing.
- **AC-3** (ONB-10 "a tenant that is not live never answers real visitors") With the widget offline: `POST /widget/v1/conversations` is 409 `not_live`; a visitor message on an existing conversation produces no triage, retrieval or model call (fake provider call count unchanged) and one `system` message with the offline text (outcome `not_live`), not repeated for the next message; the kill switch still wins (paused tenant → paused fallback); going offline during a reply stops further segments and closes with the offline text. Coaching's explainer says `not_live`.
- **AC-4** (ONB-10 "the widget shows only a configurable … message, or stays hidden, as the tenant chooses") `GET /widget/v1/config` returns `availability`; `hidden` → the loader adds no launcher; `message` → the panel shows the stored or default text in the visitor's language and the business profile's email and phone as links, with no composer; a new tenant's widget starts offline and hidden (trigger); the install is still recorded while offline.
- **AC-5** (offline settings) Saving the mode and texts trims them, stores null for empty, rejects > 300 characters and `hidden` on a channel whose registry entry lacks it (400 with field errors), and audits field names only.
- **AC-6** (CHN-12 "detected within 15 minutes") The scheduler checks every health-checked connection every 5 minutes; a revoked or invalid credential marks it degraded on the first check, `unreachable` (including a throw or a 10 s timeout) on the second consecutive one; an `ok` check recovers it; `reportSendFailure` with an auth failure degrades at once; entering and leaving degraded audit `channel.degraded` / `channel.recovered` once each; one tenant's failure doesn't stop the others.
- **AC-7** (CHN-12 "shown as degraded, and the Owner/Admin is alerted"; p) A degraded connection shows "Not working" with the reason and "Check again" on the Channels page, and the "Degraded channel" banner shows on every dashboard page for Owners and Admins (not Agents); "Check again" re-runs the check (429 within 30 s). Email and Telegram alerts: FEAT-052, FEAT-037 (D6).
- **AC-8** (isolation and secrets, ADR-005, NFR-05) RLS case: tenant B can't read or update tenant A's connections; `app_dashboard` selecting `credential_ciphertext` fails with permission denied; `visitor_channel()` returns only the current tenant's row and nothing without a tenant context; `channel_health_due` is owned by a NOLOGIN role and executable only by `app_outbox`; `localSealer` round-trips, fails on a changed byte or a different AAD, and never returns plaintext in errors; no API response contains credential fields.
- **AC-9** (SCR-APP-036, SCR-WGT-005; NFR-19) The page and the widget show the states in ui-design (loading, error with Try again, live, offline never live, degraded, confirming, saving, conflict, action failed, permission; widget not-live); go live and go offline always confirm first and are never optimistic (design.md §4.10).
- **AC-10** (WCAG 2.1 AA) Status chips pair text and icon; dialogs trap and return focus; the offline form follows the validation convention; axe has no serious or critical issues on the page (light, dark) and in the widget's not-live view.

## 7. Decisions

- **D1 — One connection row per channel kind per tenant** (`unique (tenant_id, kind)`). MVP needs one widget, one email, one Telegram bot and one Meta page each; ADR-011's `/hooks/:kind/:connectionId` still keys on the row ID, so lifting the limit later is a constraint change only.
- **D2 — The widget is registered, not re-plumbed.** Its inbound path (token API) and streaming (realtime) stay as they are; it has no webhook or credential, so its entry declares capabilities, `checksHealth: false` and both offline modes. The first full adapter is email (FEAT-036), which also adds the outbound shaper. Writing a widget adapter now would be code nothing calls.
- **D3 — Existing tenants backfill as live; new tenants start offline and hidden.** The migration has never run in production (ADR-023: nothing applied before MD), so "existing" means dev and test databases, which must keep answering; the seed sets the dev tenants live after a reset. Every tenant created from now on, by any path, starts not live (trigger).
- **D4 — Live/offline and health are separate.** A live channel can be degraded (its credential broke); the gate checks only live/offline. A degraded live channel still receives messages; FEAT-036+ decide per adapter whether sends wait in the outbox (NFR-17).
- **D5 — Sealed credentials now, KMS with the first credential.** The column, the `SecretSealer` interface and the local AES-256-GCM sealer ship here (NFR-05's "encrypted channel tokens" foundation); the KMS envelope sealer, its config variable and the AWS SDK dependency come with the first adapter that stores a credential (FEAT-037's bot token), so no lockfile change and no unused config now.
- **D6 — Degraded alerts are in-app now; email and Telegram follow.** The plan puts the notification queue and alert emails in FEAT-052 (M3) and Telegram alerts in FEAT-037 (M4); no channel that can degrade exists before M4, so FEAT-034 shows the state on the Channels page and in the dashboard banner, and audits the transition, which FEAT-052 turns into an alert. CHN-12 is partial until then (RTM note at verify).
- **D7 — The offline message is per channel, separate from the AI-paused fallback.** "Not open yet" and "the AI is paused, the team will reply" mean different things; the persona fallback stays the kill switch's text (FEAT-024, FEAT-057).
- **D8 — The pre-live contact form is FEAT-049.** UX-R4 allows it only once the purpose statement and privacy notice are saved (FEAT-058 `privacyReadiness`); it collects personal data and needs consent records, which FEAT-049 creates. FEAT-034's "message" mode shows the business's own contact details instead, which collects nothing.
- **D9 — Go-live readiness is FEAT-035.** Going live here is the explicit action with a confirmation; FEAT-035 adds the ONB-09 checks in front of it (a precondition in `setChannelState` for `live`) and the "choose channels" step of SCR-APP-012. Re-authentication isn't required (AUTH-03's list doesn't include go-live).
- **D10 — No placeholders for channels that don't exist yet.** The "Connect a channel" section renders only when `connectable` isn't empty (from FEAT-036).

## 8. Escalations and open items

- CHN-12 stays partial until FEAT-052 (email alert from the `channel.degraded` audit transition) and FEAT-037 (Telegram alert); note both in the acceptance report and RTM Test ref.
- The 15-minute target holds only while the scheduler runs; MD's alarms (NFR-11) cover a stopped scheduler.
- FEAT-057 adds the "AI paused" banner to `shell/banners.tsx` and the paused state of SCR-WGT-005 (same panel view, persona fallback text); FEAT-049 adds the contact form to it.
- Widget files change → Ken's local CI is due before merge (size budget, STATE.md cadence).

## 9. Self-check

- Every Must criterion of CHN-01 and ONB-10 maps to an AC; CHN-12 is partial with the gap named (D6).
- New tenant table has forced RLS, a policy, `TENANT_SCOPED_TABLES` and an RLS case; the visitor zone reads through a definer function only; the cross-tenant job function is NOLOGIN-owned.
- The gate is checked before every turn and before each segment (ADR-013); no model call when not live.
- Audit payloads carry kinds, IDs, reasons and field names only (ADR-014).
- Only `var(--…)` tokens in the UI; no new component beyond the `banner` design.md already defines.
