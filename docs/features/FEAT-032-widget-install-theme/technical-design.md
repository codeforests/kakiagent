# Technical Design: FEAT-032 — Widget install, theme matching, allowed origins, install check

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E3) · Milestone: M2
> Implements: ONB-07, CHN-11, CHN-14, CHN-02 (p: brand colour, logo, position, theme-matched look) · Realizes: UC-05 steps 1–5, 5a · Screens: SCR-APP-011 (new, partial: no other channels, no pre-live form), SCR-APP-037 (new, partial: no pre-live mode, tracking or proactive greetings), SCR-WGT-001 (extended: themed launcher, left or right) (see [ui-design.md](ui-design.md))
> Status: Designed · Date: 2026-10-25

## 1. Intent

The Owner or an Admin puts the widget on their website and sees it look like part of the site. The dashboard previews the real widget styled from the site (brand colour, font, corner radius, light or dark), lets them override any of it plus the logo and the corner, shows the one-line snippet with WordPress, Wix, Shopify and plain-HTML steps, and turns the install check green once the widget loads on an allowed origin (ONB-07). On the site, the loader detects the page's look at run time, clamps colours to WCAG AA, follows the page between light and dark, and stays isolated from host CSS in both directions (CHN-14, ADR-016). The owner manages the allowed origins; on any other origin the widget shows nothing and creates nothing, and the install check names the domain that tried (CHN-11, UC-05 5a).

## 2. Codebase context

- **Widget (FEAT-001):** `apps/widget/src/loader.ts` (IIFE, closed Shadow DOM, `HOST_STYLE` inline `!important` positioning restored by a `MutationObserver`, `LAUNCHER_CSS` with `:host{all:initial;${widgetTokens.light}}`, lazy `panel.js`), `panel.tsx` / `panel.css.ts` (already use `--kaki-accent`, `--kaki-on-accent`, `--kaki-radius`, `--kaki-font`), `types.ts` (`PanelContext`). `build.mjs` (esbuild: `loader.js` iife, `panel.js` esm into `dist/w/v1`), `.size-limit.json` (loader 14 KB, panel 35 KB, initial 30 KB), dev host page `dev/host.html` + `dev/hostile.css` on :5175. The skeleton always uses the light defaults.
- **Tokens:** `@kaki/design-tokens/widget` exports `widgetTokens = { light, dark }` (declaration strings). design.md §4.9 defines the four detected variables and their clamps. The anchor prototype `docs/02-design/anchors/scr-wgt-002-chat-panel.html` (`detectTheme`, `clampAccent`, ~l. 76–100) is a working sketch to port (it mixes in sRGB; production uses OKLCH lightness, same thresholds).
- **Config route:** `apps/api/src/app.ts` `GET /widget/v1/config`: `resolveWidgetKey(visitorDb, key)` (tenancy, SECURITY DEFINER `resolve_widget_key` in 0001 returning `tenant_id, allowed_origins, status`), `isAllowedOrigin` (`@kaki/channels`, exact origin match), 404 `not_here` for unknown key, wrong origin or suspended tenant; persona via `visitorTenantState` (FEAT-024). `WidgetConfigResponse` in contracts (`// ---- Widget API`).
- **Origins today:** `tenants.widget_key`, `tenants.allowed_origins text[]` (schema comment: "move to the channels module in FEAT-032"). FEAT-012 `kb/src/sources.ts` (~l. 154) adds `https://<host>` for each confirmed website domain, sorted and de-duplicated, in the source's transaction; `createWorkspace` (identity, FEAT-005) creates no origins; `db/src/setup.ts` seeds the dev tenants with the dev host origin.
- **Chromium (FEAT-012):** `apps/ingest-worker/src/chromium.ts` `chromiumFetchers` (one browser per worker, a guarded context per job: `assertPublicHost` on every request, dev-only `hostMap`, images/media/fonts skipped, `READ_PAGE` evaluated as a string). Jobs arrive on the `ingest` outbox topic (`enqueue(tx, { topic: 'ingest', groupKey, payload })`, consumed in `main.ts`).
- **Dashboard:** Settings index `pages/settings.tsx` ("Website widget" row without a link yet); setup steps `/setup` → `/setup/sources` → `/setup/review` → `/setup/test` (`SetupTestPage` in `pages/coach.tsx`, "Continue" goes to `/`). Capability `settings.manage` (Owner, Admin) in `identity/src/capabilities.ts`.
- **Channels package:** `packages/channels` holds only the `ChannelAdapter` contract and `isAllowedOrigin`; no database code or dependencies yet.

## 3. API contracts

New contracts section `// ---- Dashboard API: website widget (ONB-07, CHN-11, CHN-14; FEAT-032 §3)`; the widget section gains `WidgetTheme`. Dashboard routes need `settings.manage`: agent 403 `forbidden`, no session 401.

```ts
Hex = z.string().regex(/^#[0-9a-f]{6}$/)                       // lower-case on parse
FontChoice = { kind: 'site' } | { kind: 'system' } | { kind: 'custom', family: string /* ≤ 100, /^[\w \-,'"]+$/ */ }
ThemeOverrides = { accent?: Hex, font?: FontChoice, radius?: int 0–20, scheme?: 'light' | 'dark' }   // absent = follow the site
DetectedTheme = { accent: Hex | null, font: string | null, radius: number | null,
  scheme: 'light' | 'dark', url: string, detectedAt: datetime }
WidgetTheme = { position: 'right' | 'left', overrides: ThemeOverrides, detected: DetectedTheme | null, logoUrl: url | null }
WidgetConfigResponse += { theme: WidgetTheme }                 // additive

AllowedOrigin = { origin: string, fromWebsite: boolean }       // fromWebsite: a confirmed website source's host (FEAT-012)
InstallCheck = { state: 'waiting' | 'detected' | 'wrong_domain',
  origin: string | null, seenAt: datetime | null,              // first load on an allowed origin
  lastSeenAt: datetime | null,
  rejectedOrigin: string | null, rejectedAt: datetime | null } // latest load on an unlisted origin
Detection = { status: 'none' | 'queued' | 'running' | 'done' | 'failed',
  failure: 'unreachable' | 'blocked' | 'timeout' | 'no_page' | null, requestedAt: datetime | null }
WidgetSettings = { widgetKey, snippet /* the one-line <script> tag */, theme: WidgetTheme,
  detection: Detection, siteUrl: string | null, allowedOrigins: AllowedOrigin[], install: InstallCheck,
  previewUrl: url /* the widget's preview page */ }
```

| Method, path | Body | 200/201 response | Errors |
|---|---|---|---|
| `GET /api/v1/widget` | | `WidgetSettings` | 403 |
| `PUT /api/v1/widget/appearance` | `{ position, overrides: ThemeOverrides }` | `WidgetSettings` | 403, 422 `invalid_body` |
| `POST /api/v1/widget/theme/detect` | `{ origin?: string }` (default: `siteUrl`'s origin) | 202 `{ detection }` | 403, 422 `no_site` (no allowed origin), 422 `origin_not_allowed`, 409 `detect_running` (queued or running for < 2 min) |
| `PUT /api/v1/widget/logo` | raw `image/png`, `image/jpeg` or `image/webp`, ≤ 100 KB | `WidgetSettings` | 403, 413 `logo_too_large`, 415 `logo_type` (header or magic bytes don't match) |
| `DELETE /api/v1/widget/logo` | | `WidgetSettings` | 403 |
| `POST /api/v1/widget/origins` | `{ origin: string }` | 201 `WidgetSettings` | 403, 422 `invalid_origin`, 409 `origin_exists`, 422 `too_many_origins` (> 20) |
| `DELETE /api/v1/widget/origins/:origin` | (URL-encoded origin) | `WidgetSettings` | 403, 404 `not_found` |
| `GET /widget/v1/logo/:key` | `?v=<logo version>` | the image, `cache-control: public, max-age=31536000, immutable`, `x-content-type-options: nosniff` | 404 (unknown key, suspended tenant, no logo) |

- **Origin rule** (`normaliseOrigin` in channels, D3): input may be a bare host (`bakery.sg`) or a URL; result is `https://host[:port]`, lower-case, no path, query, user info or trailing dot. Rejected: wildcards, IP literals, `http:` (except `http://localhost[:port]` when `KAKI_BUILD !== 'production'`), hosts without a dot. `isAllowedOrigin` stays an exact match.
- **Install check states:** `detected` when `seenAt` is set and its origin is still allowed; `wrong_domain` when there is a `rejectedAt` newer than `seenAt` (or no `seenAt`); else `waiting`.
- **Config route** (visitor zone): on success it also returns `theme` and records the install (`install_seen_*` the first time per allowed origin set, `last_seen_at` at most hourly); on a known key and active tenant with a wrong origin it records `rejected_origin` (at most once a minute per tenant) and still answers 404 `not_here` with no conversation and no token (CHN-11).

## 4. Schema changes (migration `0031_widget_settings.sql`; Drizzle, then grants and policies by hand)

`widget_settings` is the channels module's per-tenant widget configuration (architecture §5.2 CHANNELS; plan: `widget_settings`). Allowed origins stay in `tenants.allowed_origins` (D2).

- **`widget_settings`**: `tenant_id uuid primary key` → `tenants` (on delete cascade); `position text not null default 'right'` (check `right`/`left`); `theme_overrides jsonb not null default '{}'` (check object); `detected_theme jsonb null`; `detect_status text not null default 'none'` (check the five values), `detect_failure text null`, `detect_requested_at timestamptz null`; `logo bytea null`, `logo_type text null` (check the three types, both null or both set, `octet_length(logo) <= 102400`), `logo_version integer not null default 0`; `install_seen_at`, `install_seen_origin`, `last_seen_at`, `rejected_origin`, `rejected_at` (timestamptz / text, null); `updated_at timestamptz not null default now()`. Forced RLS, tenant policy, name in `TENANT_SCOPED_TABLES`, tenant-B cases in `rls.int.test.ts`.
- **Rows:** the migration inserts one row per existing tenant; `createWorkspace` inserts the tenant's row in the same transaction; `setup.ts` seeds rows for the dev tenants.
- **Grants:** dashboard zone SELECT, UPDATE (all but `tenant_id`, install and rejected columns); visitor zone SELECT (`position, theme_overrides, detected_theme, logo, logo_type, logo_version`) and UPDATE (`install_seen_at, install_seen_origin, last_seen_at, rejected_origin, rejected_at`); outbox zone (ingest-worker) UPDATE (`detected_theme, detect_status, detect_failure, updated_at`). `tenants`: check `cardinality(allowed_origins) <= 50` (FEAT-012 sources may add more than the 20 a person can add by hand); the dashboard zone's existing UPDATE on `allowed_origins` is reused.
- **`resolve_widget_key`** is unchanged (the config route reads `widget_settings` under `withTenant` after resolving the key).
- Rollback (local only): drop the table and the check.

## 5. Component design

### 5.1 Theme module (`packages/channels/src/theme/`, export `@kaki/channels/theme`)

DOM-only, no Node or database imports, so the loader can bundle it (D4). `colour.ts`: parse `rgb()/rgba()/#hex`, sRGB ↔ OKLCH, relative luminance, `contrast(a, b)`. `clamp.ts` `clampAccent(hex, scheme) → { accent, onAccent, adjusted: boolean }`: on-accent is `#FFFFFF` or `#0B1117`, whichever contrasts more; lightness moves in OKLCH steps until on-accent ≥ 4.5:1 and accent vs the scheme's `--kaki-surface` ≥ 3:1 (design.md §4.9). `detect.ts` `detectTheme(doc, win) → DetectedTheme-like` per ADR-016 decision 3: scheme from the first non-transparent computed background walking up from `body` to `html` (luminance < 0.4 is dark), cross-checked with `color-scheme`; brand from `meta[name=theme-color]`, else the most frequent saturated (OKLCH chroma > 0.06) background among up to 40 visible `button, [class*=btn], a[class*=button], [role=button]`, else the most frequent link colour; font from `body` (first family that isn't an icon or decorative font: `/icon|awesome|material|symbol|emoji/i`); radius the median of the sampled buttons, clamped 0–20. `resolve.ts` `resolveTheme({ overrides, live, stored }, defaults) → { scheme, vars: string /* --kaki-* declarations */, adjusted }`: per token override > live > stored > default (ADR-016 decision 4), the accent always clamped (overrides too, D5), bubbles' radius `min(radius + 4, 20)`; `font.kind === 'system'` uses the default stack, `custom` the family plus the default stack as fallback.

### 5.2 Loader (`apps/widget/src/loader.ts`)

After the config fetch: `detectTheme` in `requestIdleCallback` (or `setTimeout 0`), `resolveTheme`, then `:host{all:initial;<defaults for scheme>;<resolved vars>}` as the first adopted sheet; replacing that one sheet swaps tokens without re-rendering. Live following when scheme isn't overridden: `matchMedia('(prefers-color-scheme: dark)')` change plus a `MutationObserver` on `class`, `style`, `data-theme`, `data-mode`, `data-color-scheme` of `html` and `body`, debounced 150 ms, re-running detection. `position: 'left'` swaps `right:` for `left:` in `HOST_STYLE` (still restored by the observer). Launcher shows the logo (`img`, alt "") when `logoUrl` is set, otherwise the chat icon. Detection, clamp and following add ≤ 5 KB gz (CHN-14): the build records the loader's gz size on `main` and after this feature in the tasks evidence; `.size-limit.json` keeps its three budgets.

### 5.3 Preview page (`dist/w/v1/preview.html` + `preview.js`, D6)

A static page in the widget build: renders the real launcher and an open panel (`mountPanel` with `ctx.preview = { messages }`: sample greeting, a visitor question and a reply; composer disabled with "Preview: messages aren't sent"; no network calls) over a mock page block in the site's background colour and font. It accepts `postMessage({ type: 'kaki-preview', theme: WidgetTheme, scheme, botName, greeting })` only from `window.parent`, validates it, and re-resolves tokens with the same `resolveTheme`. The dashboard embeds it in an `iframe sandbox="allow-scripts"` at `previewUrl` (`PUBLIC_WIDGET_PREVIEW_URL` api config, next to `PUBLIC_WIDGET_PANEL_URL`).

### 5.4 Server-side detection (ingest-worker, ADR-016 decision 5)

`POST /widget/theme/detect` sets `detect_status = 'queued'` and enqueues `{ topic: 'ingest', groupKey: 'theme:' + tenantId, payload: { kind: 'theme_detect', tenantId, url } }` in one transaction. The ingest-worker's consumer routes `kind: 'theme_detect'` to `runThemeDetect` (channels, `widget-settings.ts`, with a `ThemeProbe` port): `running`, then the Chromium probe opens the URL in a guarded context (`chromiumFetchers`, a new `probeTheme(url, script)`: same request guard and host map, 15 s cap, fonts allowed so computed families are real), injects the **same** detection code as an IIFE (`dist/w/v1/detect.js`, `window.__kakiDetect`, built from `@kaki/channels/theme` by `build.mjs` and fetched once per worker from `WIDGET_ASSET_URL`), evaluates it with `emulateMedia({ colorScheme: 'light' })`, and stores `detected_theme` + `done`, or `failed` with the failure code (unreachable, blocked by the guard, timeout, no page). Redelivery of a `done` job is a no-op unless the request is newer than `detectedAt`. No screenshots are stored (D6).

### 5.5 Channels domain (`packages/channels/src/widget-settings.ts`)

`getWidgetSettings(tx, tenantId)`, `setAppearance`, `setLogo` / `clearLogo` (bumps `logo_version`), `addOrigin` / `removeOrigin` (sorted, de-duplicated, ≤ 20 added by hand), `requestDetection`, `runThemeDetect`, `visitorWidgetTheme(tx)`, `recordInstallSeen(tx, origin, now)`, `recordRejectedOrigin(tx, origin, now)`, `normaliseOrigin`. Writes audit `widget.appearance_changed`, `widget.logo_changed`, `widget.origin_added`, `widget.origin_removed`, `widget.theme_detect_requested` with codes, IDs and the origin only (a business domain, not personal data; ADR-014). `fromWebsite` is computed by matching origins against the tenant's confirmed website-source hosts (kb's `originsOf`, read through kb's index). `channels` gains `@kaki/db` and `@kaki/platform` dependencies.

### 5.6 API (`apps/api/src/widget.ts`, `registerWidgetRoutes`)

The §3 dashboard routes; the logo route uses a raw-body content-type parser limited to 100 KB for that route only. `app.ts` config route adds `theme` and the install and rejected-origin writes (§3). The snippet is built from `PUBLIC_WIDGET_LOADER_URL` (new api config, in `.env.example`) and the widget key. `siteUrl`: the tenant's first website source root, else the first allowed origin, else null.

### 5.7 Dashboard (ui-design.md)

`/settings/widget` (SCR-APP-037) and `/setup/website` (SCR-APP-011, step 5 of the setup; `SetupTestPage`'s Continue moves there). Shared parts in `pages/widget-parts.tsx`: `WidgetPreview` (the iframe plus swatches), `AppearanceForm`, `SnippetBox` (copy + platform tabs), `InstallCheck` (polls `GET /api/v1/widget` every 5 s while `waiting` or `wrong_domain` and the page is visible), `OriginsList`. `lib/widget.ts` holds the copy maps and the preview `postMessage` helper; it imports `clampAccent` from `@kaki/channels/theme` to show "adjusted to … for contrast".

### 5.8 Fixtures and E2E

Four static host pages in `apps/widget/dev/sites/` (`wordpress.html`, `wix.html`, `shopify.html`, `plain.html`), each with a known brand colour, font, radius and scheme, typical platform markup and resets (the WordPress one with a pale brand that must clamp, one dark), served by the widget dev server. E2E `widget-install.e2e.ts` loads each with the dev tenant's snippet and asserts the resolved `--kaki-*` values (through `openShadowRoots`), contrast, a host-page CSS probe unchanged, a mode switch followed, and no conversation from an unlisted origin.

## 6. Acceptance criteria

- **AC-1** (ONB-07, ADR-005) Only `settings.manage` reaches the widget routes: agent 403, no session 401; tenant B never reads or changes tenant A's widget settings, logo or origins; the RLS suite covers `widget_settings`.
- **AC-2** (ONB-07 "copy a one-line snippet; instructions for WordPress, Wix, Shopify and plain HTML") `GET /widget` returns the snippet with the tenant's key and loader URL; the screens show it with a Copy button and steps for the four platforms.
- **AC-3** (ONB-07 acceptance, UC-05 5) The first config fetch from an allowed origin sets the install check to `detected` with that origin; before it the check is `waiting`; `last_seen_at` updates at most hourly; the screen turns green without a reload.
- **AC-4** (CHN-11, UC-05 5a) A config fetch with a known key from an unlisted origin returns 404 `not_here`, issues no token, creates no conversation, and records the origin so the install check is `wrong_domain` naming it; message routes reject a token used from another origin (existing check kept).
- **AC-5** (CHN-11 "KB-13 plus any the tenant adds") Owners add and remove origins: input is normalised; wildcards, IPs, paths and `http:` (outside dev) give 422 `invalid_origin`; duplicates 409; a 21st hand-added origin 422; removing an origin makes the widget silent there on the next load; website-source origins are marked `fromWebsite`; each change is audited.
- **AC-6** (CHN-14 detection; ADR-016 decision 3) `detectTheme` on each of the four fixture sites returns its brand colour, font, radius and scheme; `theme-color` wins over buttons; icon fonts are skipped; with nothing to detect the defaults apply.
- **AC-7** (CHN-14 "adjusted … to keep WCAG 2.1 AA contrast", NFR-09) For any accent, light or dark, `clampAccent` gives on-accent text ≥ 4.5:1 and accent vs panel ≥ 3:1, leaves passing colours unchanged and reports `adjusted`; overrides are clamped too.
- **AC-8** (CHN-14 "following the page if it switches", UC-05 5) When the host page toggles a dark class or the OS scheme changes, the widget's scheme and tokens follow within 500 ms without re-mounting; a scheme override stops following.
- **AC-9** (CHN-14 isolation) A hostile host stylesheet (resets, `!important` on `button`, `*`) doesn't change the widget's computed styles, and the widget adds no style or global to the host page other than `window.__kaki` and the `<kaki-agent>` element.
- **AC-10** (CHN-14 "preview … and override any setting", ADR-016 decisions 4–5, UC-05 1–2) Requesting detection queues one job; the worker stores the detected theme from the site (`done`) or a failure code; overrides of accent, font, radius and scheme, the position and the logo are saved and reach the live widget on its next load with override > live > stored > default precedence.
- **AC-11** (CHN-02 (p) logo) PNG, JPEG and WebP logos up to 100 KB are accepted, others 415 and larger 413; the logo is served from `/widget/v1/logo/:key` with immutable caching and a version that changes on replace; deleting it brings the chat icon back.
- **AC-12** (CHN-14 "≤ 5 KB gzipped", NFR-02, ADR-016) The loader stays ≤ 14 KB gz and the initial load ≤ 30 KB gz; detection, clamp and following add ≤ 5 KB gz over the loader on `main` before this feature (sizes recorded in the evidence).
- **AC-13** (ui-design) SCR-APP-037 and SCR-APP-011 render every designed state (detecting, detected, detect failed, waiting, detected install, wrong domain, no origins, error, permission) with no serious axe violations; E2E covers the four fixture sites and the install check turning green.

## 7. Decisions

- **D1 — Scope.** Pre-live mode and the go-live switch (ONB-10, FEAT-034), tracking and consent mode (CHN-03, FEAT-029), proactive greetings (AGT-10, FEAT-030), other channels on SCR-APP-011 (FEAT-034+) and the Lighthouse ≤ 2-point check of CHN-02 are not in this feature; their parts of SCR-APP-037 and -011 are absent, not placeholders that do nothing. The Lighthouse check is proposed for the M2 close (pending-actions).
- **D2 — Allowed origins stay on `tenants`.** `resolve_widget_key` and FEAT-012's source write already use the column; moving it into a table would change three features' code for no behaviour. `widget_settings` holds everything else. The schema comment is updated.
- **D3 — Exact origins, no wildcards.** Each subdomain is listed (FEAT-012 already adds `www.`); `https` only outside dev. Driver: CHN-11 "only works on the tenant's allowed domains"; a wildcard on a shared host (`*.myshopify.com`) would let other shops embed it.
- **D4 — One detection module in `@kaki/channels/theme`.** The loader bundles it; the build also emits it as `detect.js`, which the worker injects into Chromium, so the preview and the live widget detect with the same code (ADR-016 decision 5) without an app importing another app.
- **D5 — Overrides are clamped too.** An owner's colour that fails AA is adjusted and the screen says so; NFR-09 holds for every tenant.
- **D6 — Preview in an iframe of the real widget, no screenshots.** The preview page is part of the widget build, so the dashboard shows the real launcher and panel; the site is suggested by its background and font, not a stored screenshot, which saves S3 storage and a screenshot pipeline. ADR-016 decision 5's screenshots are left out; noted in §8.
- **D7 — Logo in the database.** ≤ 100 KB PNG, JPEG or WebP (no SVG: script risk), stored as `bytea` and served by the api with immutable caching keyed on a version, instead of a public S3 path. Driver: one small public image per tenant, no new bucket policy.
- **D8 — Install check from the config route.** The first successful config fetch from an allowed origin is the install (ADR-016 decision 6); a wrong-origin fetch is recorded (throttled, latest only) so 5a can name the domain. The dashboard polls every 5 s while waiting; no realtime event.

## 8. Escalations and open items

- **ADR-016 decision 5 deviation (D6):** no screenshots in `detected_theme`. Not an ADR change: the decision's intent (real widget, real detection) is kept; recorded here.
- **Later features:** pre-live form and go-live (FEAT-034, UX-R4), proactive greetings on SCR-APP-037 (FEAT-030), tracking and consent (FEAT-029), widget strings in 中文 (FEAT-033), Lighthouse check (M2 close, pending-actions), CloudFront hosting of `w/v1/*` (Terraform, MD).

## 9. Self-check

ONB-07 → AC-1–AC-3, AC-13; CHN-11 → AC-4, AC-5; CHN-14 → AC-6–AC-10, AC-12, AC-13; CHN-02 (p) → AC-10, AC-11, AC-12; UC-05 1–2 → AC-10, 3 → AC-2, 5 → AC-3, AC-8, 5a → AC-4. ADR-016 decisions 1–7 → §5.1–5.4, AC-9, AC-12; ADR-005 → AC-1; ADR-014 → §5.5. Contract changes are additive (`WidgetConfigResponse.theme`). Tasks run schema → contracts → theme module → channels domain → worker → api → widget → UI → E2E → verify. IDs checked: ONB-07, ONB-10, CHN-02, CHN-03, CHN-11, CHN-14, AGT-10, NFR-02, NFR-09, UC-05, SCR-APP-011, SCR-APP-037, SCR-WGT-001, ADR-005, ADR-014, ADR-016, FEAT-012, FEAT-029, FEAT-030, FEAT-033, FEAT-034 resolve.
