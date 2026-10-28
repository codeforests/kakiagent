# Technical Design: FEAT-057 — Kill switch: pause and resume the AI on all channels

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E10) · Milestone: M2
> Implements: GOV-08 (the Owner or an Admin pauses the AI on all channels instantly; effect within 5 seconds; visitors see the tenant's fallback message; recorded in the audit log. Lead capture on the fallback is FEAT-049, so the "with lead capture" clause stays partial, D6) · Realizes: UC-31 steps 1–4, UC-20 5e, journey J8 · Screens: SCR-APP-058 (new), SCR-WGT-005 (adds the paused state) (see [ui-design.md](ui-design.md))
> Status: Designed · Date: 2026-10-28

## 1. Intent

The send gate already honours `tenants.ai_paused` (FEAT-001/004: checked before every turn and before each segment is released, and it wins over every other gate reason), but nothing in the product can set it: tests flip it with a superuser `update`. This feature makes the kill switch a real, deliberate Owner/Admin action. The AI status pill in the dashboard's top bar shows Live, Paused or Not live and opens the Pause AI dialog; pausing or resuming goes through the API, is audited, and notifies every open dashboard. While paused, a danger banner sits on every page with "Resume AI", the widget opens with a paused notice (the tenant's fallback text and contact details) above a composer that still works, because staff keep answering from the inbox, and each conversation gets the fallback once rather than after every visitor message.

## 2. Codebase context

- **Gate:** `aiAllowed` (`packages/agent/src/gate.ts`) reads `visitor_tenant_state()` in the turn's transaction; `paused` is checked first and fails closed. `runVisitorTurn` stores `textsFor(language, persona).fallback` as a `system` message with outcome `paused`; between segments, `composeReply` re-checks and closes with the released text plus the fallback (`turn.ts`, the `now.reason === 'paused'` branch). Covered by `turn.int.test.ts` "with the kill switch on…" and "stops between segments…" (FEAT-004 AC-14).
- **Column:** `tenants.ai_paused boolean not null default false` (0002). `app_dashboard` has column grants on `tenants` for `name` (0019), `allowed_origins` (0021), `fact_review_months` (0029); `rls.int.test.ts` currently lists `update tenants set ai_paused = true` among the statements `app_dashboard` is refused.
- **Capability:** `killswitch.toggle` already exists for Owner and Admin (`packages/identity/src/capabilities.ts`).
- **Fallback text:** tenant-worded in Assistant settings (`fallback_en`/`fallback_zh`, SCR-APP-041, `getAssistantSettings`), defaulted by `textsFor` in `@kaki/agent`.
- **Channels:** `listChannels` / `visitorChannel` (`@kaki/channels`, FEAT-034) give the live state and the business contacts the widget shows.
- **Shell:** `apps/dashboard/src/shell/app-shell.tsx` has a static "Not live" pill marked for FEAT-057; `shell/banners.tsx` reserves banner #1 "AI paused" above the degraded-channel banner.
- **Realtime:** the API's `notify(channels, event)` publishes post-commit on Valkey; the dashboard's `useInboxSocket` (`lib/realtime.ts`, mounted by the Inbox page) parses `RealtimeEvent`.
- **Widget:** `GET /widget/v1/config` (in `apps/api/src/app.ts`) returns `availability`; the panel's not-live view is `notLiveView` in `apps/widget/src/chat.ts`.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: kill switch (GOV-08; FEAT-057 §3)`)

```ts
export const AiStatus = z.object({
  paused: z.boolean(),
  /** When the current pause started; null while not paused. */
  pausedAt: z.iso.datetime().nullable(),
  /** Channels in state `live` (FEAT-034). 0 and not paused → the pill says "Not live". */
  liveChannels: z.number().int().min(0),
  /** The fallback visitors get while paused, resolved (tenant wording or the default). */
  fallback: z.object({ en: z.string(), zh: z.string() }),
});
export type AiStatus = z.infer<typeof AiStatus>;
export const AiStatusResponse = z.object({ status: AiStatus });
```

| Route | Who | Body | Answer |
|---|---|---|---|
| `GET /api/v1/ai/status` | any member (`inbox.read`) | — | 200 `AiStatusResponse` |
| `POST /api/v1/ai/pause` | `killswitch.toggle` (Owner, Admin) | none (empty or `{}`) | 200 `AiStatusResponse`; already paused → 200, unchanged, no audit |
| `POST /api/v1/ai/resume` | `killswitch.toggle` | none | 200 `AiStatusResponse`; already running → 200, unchanged, no audit |

Errors use the existing shapes: 401 no session, 403 `forbidden` (Agent), 500 `internal`. No version and no 409: the target state is explicit in the route, so two people pressing Pause at once both get "paused" and exactly one audit entry is written (D3). Not on the AUTH-03 re-auth list, so no re-auth (D4).

**Realtime event** (added to the `RealtimeEvent` union): `AiStatusEvent = z.object({ type: z.literal('ai_status'), paused: z.boolean() })`, published after commit on `channels.inbox(tenantId)` when the state changed. Clients refetch `GET /api/v1/ai/status`; the event is a nudge, Postgres is the record (ADR-017).

**Widget config** (`WidgetConfigResponse`), one new field:

```ts
/** Kill switch (GOV-08; FEAT-057): null while the AI runs. Paused → the panel shows this notice above the composer. */
aiPaused: z.object({
  message: z.object({ en: z.string(), zh: z.string() }),
  contact: z.object({ email: z.string().nullable(), phone: z.string().nullable() }),
}).nullable(),
```

`message` is the resolved fallback (persona wording or default), `contact` the same profile contacts `availability` uses. When the widget is offline, `availability` wins and `aiPaused` is still filled but unused by the panel (D7). `POST /widget/v1/conversations` is **not** refused while paused: visitors can still write and staff answer (UC-31 step 3).

## 4. Schema changes (migration `0035_kill_switch.sql` + Drizzle columns)

```sql
ALTER TABLE tenants ADD COLUMN ai_paused_at timestamptz;
ALTER TABLE tenants ADD COLUMN ai_paused_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tenants ADD CONSTRAINT tenants_ai_paused_at_ck
  CHECK ((ai_paused AND ai_paused_at IS NOT NULL) OR (NOT ai_paused AND ai_paused_at IS NULL AND ai_paused_by IS NULL));
GRANT UPDATE (ai_paused, ai_paused_at, ai_paused_by) ON tenants TO app_dashboard;
```

`tenants` already has forced RLS and the `tenant_isolation` policy (`id = app_current_tenant()`, 0001), so the grant is limited to the session's own row. `ai_paused_by` is a user ID (no PII on `tenants`; the email stays in the identity zone). Drizzle: `aiPausedAt`, `aiPausedBy` next to `aiPaused`, with the check. `rls.int.test.ts`: the `ai_paused` statement moves out of the refused list into a new case (D5): as `app_dashboard` in tenant B, `update tenants set ai_paused = true, ai_paused_at = now()` changes B's row only and A's stays false; `update tenants set route_complexity_threshold = 0` and `cost_governor_step` stay refused. `visitor_tenant_state()` is unchanged.

## 5. Component design

### 5.1 Governance (`packages/governance/src/kill-switch.ts`, exported from `src/index.ts`)

Architecture §5.2 puts `killSwitch` in governance.

- `aiPauseState(tx, tenantId): Promise<{ paused: boolean; pausedAt: Date | null }>` — reads the tenant row.
- `setAiPaused(tx, { tenantId, userId, paused }): Promise<{ changed: boolean; paused; pausedAt }>` — one conditional update `where id = $tenant and ai_paused = not $paused` setting `ai_paused`, `ai_paused_at = now()` / null, `ai_paused_by = $user` / null. No row updated → `changed: false`, no audit (repeat or lost race, D3). Changed → `audit.append(tx, tenantId, { action: paused ? 'ai.paused' : 'ai.resumed', actorType: 'user', actorId: userId, subjectType: 'tenant', subjectId: tenantId, payload: {} })` in the same transaction (ADR-014: IDs only).

### 5.2 Channels (`packages/channels/src/connections.ts`)

- `liveChannelCount(tx): Promise<number>` — `count(*) where state = 'live'` on `channel_connections` (RLS scopes it). Exported from `src/index.ts`.

### 5.3 Agent (`packages/agent/src/turn.ts`)

- The gate-closed `paused` branch stores the fallback **once** per run of visitor messages, like `not_live`: `prep.lastReply === fallback ? null : store('paused', …)` (D2). The mid-stream paused close is unchanged. Update the code-map line for the visitor turn.
- No gate change: `aiAllowed` already reads the flag from Postgres in the turn's transaction before the turn and before each segment (D1).

### 5.4 API (`apps/api/src/ai.ts`, `registerAiRoutes(app, deps, sessionFrom, notify)`, wired at the end of `app.ts`)

- `statusOf(tx, tenantId)`: `aiPauseState` + `liveChannelCount` + `getAssistantSettings` → `fallback = { en: textsFor('en', persona).fallback, zh: textsFor('zh', persona).fallback }` (the same resolution the turn uses). Parsed with `AiStatusResponse`.
- `GET /api/v1/ai/status`: session with `inbox.read`; `withTenant(dashboardDb, s.tenantId, statusOf)`.
- `POST /api/v1/ai/pause|resume`: session, `can(role, 'killswitch.toggle')` else `ForbiddenError`; one `withTenant` transaction runs `setAiPaused` then `statusOf`; after commit, if `changed`, `notify([channels.inbox(tenantId)], { type: 'ai_status', paused })`. A publish failure is logged and ignored (the change is committed; the gate reads Postgres).
- Widget config: inside the existing visitor-zone transaction, `aiPaused = tenantState.aiPaused ? { message: { en, zh } from textsFor with the visitor persona, contact: channel.contact } : null`. No new visitor-zone grant: `visitor_tenant_state()` already returns `ai_paused` and the fallback words, `visitor_channel()` the contacts.

### 5.5 Dashboard (detail in ui-design.md)

- `lib/api.ts`: `getAiStatus`, `pauseAi`, `resumeAi`. `lib/ai-status.ts`: `useAiStatus()` (query key `['ai-status']`, `refetchInterval` 30 s, refetch on focus), `useSetAiPaused()` (mutation; on success `setQueryData` from the response, no optimistic update), `pillState(status) → 'live' | 'paused' | 'not_live'` (paused wins; then `liveChannels > 0`). Unit tests in `lib/ai-status.test.ts`.
- `lib/realtime.ts`: an `ai_status` event invalidates `['ai-status']`.
- `shell/ai-status.tsx`: `AiStatusPill` (button for Owner/Admin, a non-interactive status with a tooltip for Agents) and `KillSwitchDialog` (pause and resume modes). `app-shell.tsx` replaces the static pill.
- `shell/banners.tsx`: `useAiPausedBanner(role)` first in the list; its "Resume AI" opens the same dialog in resume mode (dialog state lifted into a small context or a callback prop from the shell).

### 5.6 Widget (`apps/widget/src`)

- `chat.ts`: `pausedNotice(config, navLang)` → `{ text, email, phone } | null` (same language rule as `notLiveView`). `panel.tsx`: when `config.aiPaused` and the widget is live, the log starts with a `system-notice` (paused variant) holding the text and contact links; the greeting and the AI disclosure row are not shown; the composer stays. Strings: `pausedRegion` "Message from {business}" / "来自{business}的消息" (reuse `notLiveRegion` if identical), contact labels reused. Mid-chat pauses need no push: the visitor's next message gets the fallback `system` message from the turn.
- Size: a few hundred bytes in `panel.js`; the loader is untouched (budgets in `.size-limit.json`).

### 5.7 E2E (`e2e/tests/kill-switch.e2e.ts`)

Owner signs in → pill "Live" → opens dialog → "Pause AI now" → pill "Paused" within 5 s of the click and the banner shows on Inbox and Knowledge pages → in a second page, the widget host page opens the panel: paused notice visible, composer enabled; the visitor sends a message → the fallback appears in the log within 5 s and no AI answer → Owner resumes from the banner → pill "Live", banner gone → a new visitor message gets an AI answer. `afterEach` resumes the AI through the API if a step failed (shared dev tenant). axe light and dark on the dialog, the banner and the widget notice; one run at 375 px for the pill and the bottom-sheet dialog.

## 6. Acceptance criteria

- **AC-1** (GOV-08 "the Owner or an Admin can pause"; UC-31 1, 4) `POST /api/v1/ai/pause` and `/resume` work for Owner and Admin and return the new `AiStatus`; an Agent gets 403 and nothing changes; repeating the current state returns 200 with no change and no audit entry; two concurrent pauses leave one `ai.paused` entry.
- **AC-2** (GOV-08 "recorded in the audit log") Each change appends exactly one `ai.paused` / `ai.resumed` entry with actor type `user`, the user ID and the tenant ID only (no email, no text), and the audit chain verifies.
- **AC-3** (GOV-08 "takes effect within 5 seconds"; ADR-013 decision 3) Once `pause` has returned, the next visitor turn makes no triage, retrieval or model call and stores one `system` fallback message (outcome `paused`); a second visitor message gets no further fallback; a reply being composed when pause commits releases no further segment (existing FEAT-004 AC-14 test still passes). End to end (E2E) the visitor sees the fallback within 5 s of the pause acknowledgement.
- **AC-4** (GOV-08 "visitors see the tenant's fallback message"; UC-31 2) `GET /widget/v1/config` returns `aiPaused` with the tenant's fallback wording (or the default) and the profile contacts while paused, null otherwise; the widget panel shows the paused notice above an enabled composer, with no greeting or AI disclosure row. Lead capture is FEAT-049 (D6).
- **AC-5** (UC-31 3) While paused, a visitor can still start a conversation and send messages, and staff replies from the inbox reach the visitor.
- **AC-6** (UC-31 4) After `resume`, the next visitor message gets a normal AI answer; `ai_paused_at` and `ai_paused_by` are null.
- **AC-7** (ADR-005) `GET /api/v1/ai/status` works for every role and returns only the session tenant's state; pausing tenant A leaves tenant B's gate open; `app_dashboard` can update only its own tenant's kill-switch columns (RLS case), and other `tenants` columns stay refused.
- **AC-8** (SCR-APP-058; design.md `ai-status-pill`, §4.10) The pill shows Live, Paused or Not live from the status; Owners and Admins open the dialog from it; the dialog confirms, shows "Pausing…"/"Resuming…" until the server answers and changes the pill only then; a failure keeps the dialog open with an error; Agents see the pill without a button.
- **AC-9** (design.md `banner` #1; ux-foundations F4) While paused, the "AI paused" banner shows on every page above any other banner, not dismissible, with "Resume AI" for Owners and Admins only; another open dashboard sees the change on its next status refresh (≤ 30 s, or at once on the Inbox via the `ai_status` event).
- **AC-10** (NFR-08/INB-06, NFR-02) No serious axe violations on the pill, dialog, banner and widget notice in light and dark; the pill and dialog work at 375 px (bottom sheet); widget budgets still pass `pnpm size`.

## 7. Decisions

- **D1 — The gate keeps reading Postgres; Valkey only notifies.** ADR-013 allows workers to cache the flag for up to 2 s from Valkey. The gate already reads `visitor_tenant_state()` inside each turn's transaction and before every segment, so the flag takes effect at the next check with no cache at all, which is stricter than the ADR's budget and matches architecture §10's Valkey-failure row ("kill-switch flag read from Postgres directly"). Valkey carries only the `ai_status` dashboard nudge. Adding a cache would add a staleness window to save one primary-key read per segment.
- **D2 — The fallback is sent once per run of visitor messages**, not after every message, the same rule FEAT-034 uses for the offline message (`lastReply` equal → no new message). Staff are answering; repeating "our team will get back to you" after each line reads like a broken bot.
- **D3 — Explicit target routes, no version.** `pause` and `resume` are idempotent and race-safe through a conditional update; the loser of a race is a no-op with no audit. A version check would turn "two people pressed Pause" into an error for something both wanted.
- **D4 — No re-auth.** The kill switch isn't on AUTH-03's list, and GOV-08 asks for "instantly"; design.md §4.10's sequence applies without the re-auth step.
- **D5 — `app_dashboard` gets a column grant for the kill-switch columns**, as for `name`, `allowed_origins` and `fact_review_months`; the RLS suite's refused statement for `ai_paused` was a placeholder until this feature and is replaced by a positive own-tenant case plus a cross-tenant case.
- **D6 — GOV-08 stays partial** on "with lead capture": the contact form on SCR-WGT-005 is FEAT-049 (UX-R4). The paused notice shows the business's email and phone meanwhile.
- **D7 — Not live wins over paused in the widget.** A channel that isn't live shows its offline view (FEAT-034), whether or not the AI is paused; the gate already orders paused first for the turn, which only matters once a visitor can write.
- **D8 — "Not live" on the pill means no channel is live and the AI isn't paused.** Paused always shows as Paused. Opening the dialog from "Not live" still offers Pause (useful before go-live), with a line saying no channel is live yet.

## 8. Escalations and open items

- GOV-08 partial until FEAT-049 (lead capture on the fallback); record in the acceptance report and the RTM Test ref.
- Human takeover (FEAT-043) doesn't change here: resume doesn't hand back conversations staff own.
- Email alerts on pause/resume to other admins are not required by GOV-08; FEAT-052 may add them from the audit entries.
- Widget and dashboard files change → GitHub CI (E2E, size) runs in the verify stage.

## 9. Self-check

- Every GOV-08 criterion maps to an AC (AC-1/2/3/4), with lead capture partial (D6); UC-31 steps 1–4 are AC-1, AC-4, AC-5, AC-6.
- No new table; the new grant is column-scoped on a table with forced RLS, with an RLS case (AC-7).
- The gate stays the single check before every turn and segment (ADR-013); no new path around the dispatcher (ADR-025).
- Audit payloads carry IDs only (ADR-014); `ai_paused_by` is a user ID.
- Only `var(--…)` tokens; components from design.md (`ai-status-pill`, `kill-switch-dialog`, `banner`, `system-notice`); no new token.
