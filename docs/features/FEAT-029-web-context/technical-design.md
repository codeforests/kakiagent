# Technical design: FEAT-029 — Web context and first-party intent tracking; consent mode

> Implements: AGT-05, CHN-03, INB-04 (p: intent block's page context) · Realizes: UC-20 (step 1, step 5 "using page context where tracking allows", 1a) · Screens: SCR-WGT-007 (new), SCR-WGT-002 (p: menu item), SCR-APP-037 (p: tracking section), SCR-APP-015 (p: intent block) (see [ui-design.md](ui-design.md)) · Module: `channels` (tracking settings and events), `inbox` (message page, sidebar), `agent`, `governance` (audit); ADR-005, ADR-008, ADR-009, ADR-012, ADR-014, ADR-015, ADR-016
> Status: designed · 2026-11-12

## 1. Intent

The widget tells the agent where the visitor is and what they have looked at, so a reply can fit ("the Premium package on this page is S$…"), and staff see the same context in the conversation sidebar. The loader records first-party, pseudonymous page views (path, visible dwell time, scroll depth, UTM parameters, referrer host, returning visitor) under the visitor ID it already has (ADR-016), with no cookies and no third-party calls. A tenant can turn tracking off, or turn on **consent mode** (off by default, D8), in which the widget collects nothing beyond the current page until the visitor accepts a compact prompt inside the chat panel (SCR-WGT-007, D1). Every visitor message carries its current page in all modes. The agent gets the page context as fenced data in the tail of its prompt, may refer to what is on the current page, and never reveals tracking (a deterministic guard checks it, AGT-05). The context used is recorded in the turn's `agent.decision` audit entry.

## 2. Codebase context

- **Loader** (`apps/widget/src/loader.ts`, ≤ 14 KB gz, now 4.5 KB): fetches `/widget/v1/config` with the stored `kaki.vid`, gets a 1-hour visitor token (`{t, o, v}`) and mounts; `PanelContext` hands the panel the config and callbacks. No page data is sent today; nothing in the repo tracks pages (`grep pageUrl|utm` finds nothing).
- **Messages**: `POST /widget/v1/conversations/:id/messages` (`SendMessageBody` `{text, clientMessageId}`) → inbox `appendVisitorMessage` → agent-worker `runVisitorTurn`.
- **Sidebar** (INB-04): inbox `views.ts` builds `ContextSidebar`; its `intents` are triage signals (`intentCounts`, FEAT-042 D4). The anchor `scr-app-015-conversation.html` shows Intent as "Now on / Viewed / Source"; FEAT-042 deferred that part here (pending actions, Ken 2026-11-07).
- **Widget settings**: `widget_settings` (one row per tenant, channels module), `GET /api/v1/widget` + `PUT …/appearance` in `apps/api/src/widget.ts`, page `apps/dashboard/src/pages/widget.tsx` (sections Look, Install, Sites).
- **Prompt** (`prompt.ts` `buildVisitorPrompt`): fixed rules, cached tenant block, then the uncached `tail` (memory first, FEAT-026). Guards run per segment in `compose.ts` (verify → leak guard → boundary guard); a failed segment regenerates once, then escalates.
- **Purges**: FEAT-038's `handoff_links_purge()` pattern (NOLOGIN owner, definer function, scheduler calls it on the outbox zone).

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Web context (AGT-05, CHN-03; FEAT-029 §3)`)

```ts
export const TrackingMode = z.enum(['off', 'on', 'consent']);   // stored as two booleans, §4
export const PagePath = z.string().trim().min(1).max(512).regex(/^\//); // path only, §5.2
export const Utm = z.object({ source, medium, campaign, term, content }) // each z.string().max(100).optional()
  .strict();

// Widget → api
export const SendMessageBody = z.object({ text, clientMessageId, page: PagePath.optional() }); // + page
export const TrackEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('view'), id: z.uuid(), sessionId: z.uuid(), path: PagePath,
    referrer: z.string().max(253).optional(),        // host only
    utm: Utm.optional(), at: z.iso.datetime() }),
  z.object({ type: z.literal('engage'), id: z.uuid(),
    dwellMs: z.number().int().min(0).max(86_400_000), scroll: z.number().int().min(0).max(100) }),
]);
export const TrackBody = z.object({ token: z.string().max(2048), events: z.array(TrackEvent).min(1).max(20) }).strict();
export const TrackingChoiceBody = z.object({ choice: z.enum(['accepted', 'declined']) }).strict();

// WidgetConfigResponse gains:
tracking: z.object({ mode: TrackingMode })

// Dashboard
export const WidgetSettings = …extend({ tracking: z.object({ mode: TrackingMode, updatedAt: z.iso.datetime().nullable() }) });
export const WidgetTrackingBody = z.object({ mode: TrackingMode }).strict();

// ContextSidebar gains (INB-04):
web: z.object({
  /** What this conversation may use (§5.5): `page_only` when tracking is off or not consented. */
  scope: z.enum(['full', 'page_only']),
  currentPage: PagePath.nullable(),                 // the latest visitor message's page
  viewed: z.array(z.object({ path: PagePath, dwellMs: z.number().int(), at: z.iso.datetime() })).max(10),
  source: z.object({ utm: Utm.nullable(), referrer: z.string().nullable() }).nullable(),
  returning: z.boolean(),
}),
```

Routes:

| Route | Zone | Auth | Result |
|---|---|---|---|
| `POST /widget/v1/events` | visitor | token **in the body** (`sendBeacon` can't set headers), `Origin` = token's `o` | 204; 204 and nothing stored when the mode forbids it (§5.3); 400 bad body; 401 bad token; 429 over 120 events per visitor per 10 min |
| `POST /widget/v1/tracking-choice` | visitor | Bearer | 204; records the choice (§5.4); 409 `not_consent_mode` |
| `PUT /api/v1/widget/tracking` | dashboard | `settings.manage` | `WidgetSettings` |

`content-type: text/plain` is accepted on `/widget/v1/events` only (a beacon without a preflight; the body is parsed as JSON, max 16 KB).

## 4. Schema changes (migration `0058_web_context.sql`)

- `widget_settings`: `tracking_enabled boolean not null default true`, `tracking_consent_mode boolean not null default false`, `tracking_updated_at timestamptz` (D8 defaults). Mode: `off` = not enabled; `consent` = enabled and consent mode; `on` otherwise. The visitor zone reads them; the dashboard updates them.
- `messages.page_path text` (null for non-widget and older messages), check `page_path is null or (left(page_path,1) = '/' and length(page_path) <= 512)`.
- `visitor_events` (tenant-scoped, **forced RLS**, policy `tenant_id = current_setting('app.tenant_id')`, in `TENANT_SCOPED_TABLES`, an `rls.int` case): `tenant_id uuid`, `id uuid` (client view ID), `visitor_id uuid`, `session_id uuid`, `path text`, `referrer text null`, `utm jsonb null` (object check), `dwell_ms integer not null default 0`, `scroll_pct smallint not null default 0` (0–100), `consented boolean not null` (collected under an accepted consent prompt), `viewed_at timestamptz not null`, `received_at timestamptz not null default now()`. PK `(tenant_id, id)`; index `(tenant_id, visitor_id, viewed_at desc)`. No `contact_id`: events stay pseudonymous (D8, ADR-015 §2). Grants: `app_agent_visitor` `SELECT, INSERT, UPDATE (dwell_ms, scroll_pct)`, `DELETE` (withdrawal, §5.4); `app_dashboard` `SELECT`.
- `visitor_tracking_choices` (forced RLS, same policy and test): `tenant_id`, `visitor_id`, `choice text check in ('accepted','declined')`, `decided_at timestamptz`, PK `(tenant_id, visitor_id)`. The record of the visitor's answer (PDPA evidence; the wording version is the strings table's `trackingPromptVersion`, stored as `wording text`). Grants: visitor zone `SELECT, INSERT, UPDATE`; dashboard `SELECT`.
- `visitor_events_purge()` owned by NOLOGIN `kaki_tracking_purge`, `SECURITY DEFINER`, `EXECUTE` to `app_outbox` only: deletes events with `viewed_at` older than 180 days and choices older than 13 months (D6).

## 5. Component design

### 5.1 Tracking mode and settings (`packages/channels/src/tracking/settings.ts`)

`trackingMode(row)` → `'off' | 'on' | 'consent'`; `visitorTrackingMode(tx)` (visitor zone, for config and events) and `setTrackingMode(ctx, mode)` (dashboard; audits `widget.tracking_changed` with `{from, to}`, sets `tracking_updated_at`). `getWidgetSettings` returns `tracking`. The config route adds `tracking: { mode }`.

### 5.2 Tracker (`apps/widget/src/track.ts`, in the loader)

Pure helpers plus a small runner, started from `mount()` when `config.tracking.mode === 'on'`, or `'consent'` and `storedChoice() === 'accepted'` (localStorage `kaki.track` = `{c:'accepted'|'declined', at}`; ignored after 12 months, D6). Nothing runs in `off`, or in consent mode before acceptance.

- **Session**: `sessionStorage` `kaki.sid` (new UUID per tab session; a fresh one when storage is blocked).
- **View**: on start and on each route change, a `view` event with a new `id`, `pathOf(location)` and, on the session's first view only, `referrerHost(document.referrer)` (external hosts only) and `utmOf(location.search)` (the five `utm_*` keys, values cut to 100 chars).
- **`pathOf`**: `location.pathname` only (no query, no fragment), segments decoded, any segment containing `@` or matching the edge PII rules (`findPii` from `@kaki/platform/pii-mask` is too big for the loader, so the loader drops segments with `@` or 6+ digits and the server masks again with `piiMask`, §5.3), cut to 512.
- **Route changes**: `popstate` plus a 1 s `location.pathname` check (no patching of `history`: NFR-14, the host page's globals stay untouched).
- **Engagement**: visible time only (`visibilitychange`), max scroll % from a passive, rAF-throttled `scroll` listener. An `engage` event for the current view is sent on hide, on `pagehide` and before the next view.
- **Transport**: events queue and flush at most every 5 s or on hide, via `navigator.sendBeacon(url, JSON text)` when present, else `fetch(…, {keepalive: true, credentials: 'omit'})`; body `{token, events}`. Failures are dropped silently; every handler is in try/catch (the host page never breaks).
- **Current page with messages**: the panel adds `page: pathOf(location)` to every `SendMessageBody` in all modes (AGT-05's current page).
- `PanelContext` gains `tracking: { mode, choice(): 'accepted'|'declined'|null, setChoice(c) }`; `setChoice('accepted')` stores the choice and starts the runner, `'declined'` stops it.
- Budget: the tracker adds ≤ 1.5 KB gz to the loader (stays ≤ 14 KB; T-check with `pnpm size`).

### 5.3 Events endpoint (`apps/api/src/tracking.ts`, `registerTrackingRoutes`; domain `channels/src/tracking/events.ts`)

`recordEvents(tx, { tenantId, visitorId, mode, choice, events, now })`: verifies the token from the body and the `Origin` header (same rules as `visitorFrom`), then in one visitor-zone transaction reads the mode and the visitor's choice. `off` → store nothing; `consent` without an `accepted` choice → store nothing (CHN-03 "no tracking event is sent before acceptance": the widget doesn't send, and the server drops anything that arrives). `view` inserts (`on conflict do nothing`, idempotent retries) with `path` and UTM values through `piiMask`, `consented` = mode is `consent`; `viewed_at` = the client's `at` clamped to `[now − 1 h, now]`. `engage` updates the same visitor's row with `greatest()` of dwell and scroll (never decreases; another visitor's ID matches nothing). Rate limit 120 events per visitor per 10 min (the existing limiter). No audit per event (volume; pseudonymous analytics, D8).

### 5.4 Tracking choice (`channels/src/tracking/choice.ts`)

`recordChoice(tx, { tenantId, visitorId, choice, now })`: 409 unless the mode is `consent`; upserts `visitor_tracking_choices` and audits `tracking.choice` `{choice}` (visitor ID only, no PII). `declined` after `accepted` (the menu's "Stop sharing pages") also deletes that visitor's `visitor_events` (withdrawal of consent).

### 5.5 Web context for a turn (`packages/agent/src/web-context.ts`; reads via channels `webContextOf`)

`webContextOf(tx, { tenantId, visitorId, conversationId, upToSeq })` → `WebContext { scope, currentPage, viewed, source, returning }`:

- `currentPage`: the `page_path` of the latest visitor message up to `upToSeq` (null when none).
- `scope = 'full'` when the mode is `on`, or `consent` with an `accepted` choice; else `page_only` (AGT-05: tracking off or not consented → only the current page).
- With `full`: `viewed` = this visitor's views in the conversation's session window (the last 24 h up to the message), newest first, distinct by path, at most 10, with dwell; in consent mode only rows with `consented = true`. `source` = UTM and referrer of the earliest view in that window. `returning` = the visitor has a view or a conversation older than 24 h before the conversation started.

Used by `runVisitorTurn` (first transaction, beside memory), `suggestReply` and `replay` (as of the question's seq; replay passes `page_only` with the message's stored page, because events are not replayed), the sidebar (§5.7). Coaching passes none.

### 5.6 Prompt, guard and audit (AGT-05)

- `buildVisitorPrompt` gains `web?: WebContext`; the tail gets, after memory, a fenced `<page>` block via `asData`: `current: /catering`, and with `full` scope `viewed: /cakes, /kueh` and `returning: yes`. Source/UTM is **not** given to the model (staff-only; it adds nothing a reply needs). Triage's tail gets the current page only (`triageTail(rules, memory, page)`).
- Fixed platform rule (in `system`, before `<business>`): "You may refer to what is on the visitor's current page. Use pages they viewed only to choose what is relevant; never say what they viewed, how long they stayed, how they arrived, or that they visited before."
- `trackingGuard(web)` in `packages/agent/src/guard.ts`, run in `compose.ts` after the leak guard: a segment fails if it names a viewed path other than the current page (path or its last segment as words, case-insensitive), or matches the tracking phrase list (`TRACKING_MARKERS`: en "you('ve| have)? (viewed|visited|browsed|looked at)", "welcome back", "spent \d+ (seconds|minutes)", "came from", "returning visitor", "your browsing"; zh "你(刚才)?(看过|浏览过?)", "欢迎回来"). A failure regenerates like any guard failure (violation code `tracking`).
- `agent.decision` gains `web: { scope, currentPage, viewed: n, returning }` (paths are masked page paths, not PII; ADR-014). Context is thereby recorded in the audit log (AGT-05).

### 5.7 Sidebar (INB-04)

inbox `views.ts` `sidebarWeb(tx, …)` calls channels `webContextOf` (dashboard zone, read only) for the conversation's visitor up to its latest message, plus `source` (UTM, referrer host). Non-widget conversations: `currentPage: null`, empty lists. The thread reload on a new message (existing) refreshes it; no new realtime event.

### 5.8 Widget prompt and menu (SCR-WGT-007, SCR-WGT-002)

In consent mode with no stored choice, the panel shows the tracking prompt card above the greeting the first time it opens (D1). "Allow" → `POST /widget/v1/tracking-choice accepted` + `setChoice`; "No thanks" → `declined`. The choice is stored even if the POST fails (the widget simply doesn't track; the server drops events without an accepted row, §5.3). With `accepted`, the header menu adds "Stop sharing pages" (→ `declined`); with `declined`, "Share pages I view" re-opens the prompt.

### 5.9 Scheduler

`apps/scheduler-worker/src/tracking-purge.ts`: daily `select visitor_events_purge()` on the outbox zone, logs `{ deleted }`; same shape as `handoff-purge.ts`.

## 6. Acceptance criteria

- **AC-1** (CHN-03 "tracking can be turned off per tenant"; D8): a new tenant's mode is `on`; `PUT /api/v1/widget/tracking` sets `off`/`on`/`consent` (owner/admin only, audited `widget.tracking_changed`); config returns the mode; in `off` the loader sends no event and the api stores none sent to it.
- **AC-2** (CHN-03 events): in `on` the loader sends a `view` per page load and SPA route change with path only (no query or fragment), UTM keys and referrer host on the session's first view, and `engage` with visible dwell and max scroll; records are keyed by the first-party visitor ID, no cookie is set, no third-party request is made, and the host page's `history` is not patched.
- **AC-3** (CHN-03 consent mode; UC-20 1a): in `consent` the loader sends no tracking event before the visitor accepts the in-panel prompt; events sent anyway are dropped; after "Allow" events flow with `consented = true` and the choice is recorded with its time and wording; "Stop sharing pages" deletes that visitor's events and stops tracking.
- **AC-4** (AGT-05 "only the current page"): every widget message stores its current page in all modes; with mode `off`, or `consent` without acceptance, the turn's web context is `page_only` (no viewed pages, no returning flag), including for events collected before consent mode was switched on.
- **AC-5** (AGT-05 personalise; UC-20 step 5): with `full` scope the reply prompt's tail carries a fenced `<page>` block with the current page, viewed pages and returning flag, and triage's tail the current page; replay uses the message's stored page only.
- **AC-6** (AGT-05 "never reveals tracking details beyond what is on the page"): a segment naming a viewed (non-current) page or matching a tracking phrase fails `trackingGuard` and is regenerated, then escalated; eval cases (`evals/cases/feat-029-web-context.json`) pass: a reply about the current page's product, and no reply mentions viewed pages, dwell or source.
- **AC-7** (AGT-05 "recorded in the audit log"): `agent.decision` carries `web` with scope, current page, viewed count and returning flag; it holds no query strings and no unmasked PII.
- **AC-8** (CHN-03 "events show in the conversation sidebar"; INB-04): the sidebar's Intent section shows Now on, Viewed (with time on page), Source and Returning for a `full` conversation, only Now on for `page_only`, and keeps the triage signals.
- **AC-9** (ADR-005, ADR-015, D8): tenant B can't read or write A's `visitor_events` or choices; events carry no contact ID and no unmasked NRIC/card/bank values (`piiMask` on path and UTM); `visitor_events_purge()` deletes only rows past 180 days (choices past 13 months) and refuses app roles.
- **AC-10** (NFR-02, NFR-14): loader stays ≤ 14 KB gz; tracker errors never throw into the host page; a blocked `localStorage`/`sessionStorage` still works (no tracking state kept, nothing thrown).
- **AC-11** (SCR-WGT-007, SCR-APP-037, design.md): the prompt and the tracking section have no serious axe violations at desktop and phone width, are keyboard operable, and the widget copy exists in `en` and `zh-Hans`.

## 7. Decisions

- **D1 — The consent prompt sits inside the chat panel (Ken chose it, 2026-11-12).** Page context matters only once someone chats, non-chatters are never tracked in consent mode, the loader stays small, and nothing appears on the host page uninvited.
- **D2 — Current page with every message, in every mode.** AGT-05 and CHN-03 both allow the current page without tracking consent; it is part of the question's context, stored on the message (already personal-data scoped, ADR-015).
- **D3 — One row per page view, updated by `engage`,** rather than an append-only event log: the sidebar and turn need views with dwell, and the update only raises values.
- **D4 — Path only, masked twice.** Query strings and fragments often carry emails or tokens; the loader drops them and suspicious segments, the server applies `piiMask`. No page titles.
- **D5 — The model never sees source/UTM or dwell, only paths and returning.** Less to leak; the guard covers paths and phrases deterministically (ADR-008 spirit).
- **D6 — Retention: events 180 days, choices 13 months, the widget's stored choice 12 months.** Events are pseudonymous analytics with no GOV-06 setting; the consent record outlives the data it covers and the widget asks again before it is purged. A tenant-configurable value can follow with GOV-06's feature.
- **D7 — Sidebar follows the turn's scope:** staff see the same context the agent may use, so consent mode limits both.
- **D8 — Token in the beacon body** (sendBeacon can't set headers), with the same origin check; `text/plain` avoids a preflight.

## 8. Escalations and open items

- GOV-05 deletion (FEAT-061) must delete `visitor_events` and `visitor_tracking_choices` for the visitor IDs of the contact's conversations; noted in pending actions.
- Proactive greetings on intent signals (UC-20 step 1, AGT-10) are FEAT-030; it reads the loader's tracker state.
- The plan row's `/v/events` is `/widget/v1/events` (the widget routes' prefix since FEAT-032).

## 9. Self-check

- Every AC traces to AGT-05, CHN-03, INB-04 or UC-20; each decision has a reason. Tenant ID only from the verified visitor token or the session. RLS forced on both new tables with RLS cases. No contact link on tracking rows. Side effects: none beyond the audit (no outbox needed; the purge is a scheduler call). The model writes no tracking facts: the guard blocks them. Module boundaries: agent and inbox read web context through channels' exported `webContextOf`; the tracker lives in the widget app (`track.ts`, pure helpers unit-tested) and imports only contracts types. IDs checked: AGT-05, CHN-03, INB-04, UC-20, SCR-WGT-007, SCR-WGT-002, SCR-APP-037, SCR-APP-015, ADR-005, ADR-008, ADR-009, ADR-012, ADR-014, ADR-015, ADR-016, D8, FEAT-030, FEAT-061 resolve.
