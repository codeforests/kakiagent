# Handoff: FEAT-032 — Widget install, theme matching, allowed origins, install check
Branch: feat/FEAT-032-widget-install-theme · PR: none · Updated: 2026-10-25 by build (backend)
Stage done: build (T1–T7 of 12)
Next: build (UI, T8–T12) — kickoff: "Build FEAT-032 (UI) on branch feat/FEAT-032-widget-install-theme. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (all `settings.manage`; 403 `forbidden` for agents): `GET /api/v1/widget` → `WidgetSettings`; `PUT /appearance` `{ position, overrides }`; `POST /theme/detect` `{ origin? }` → 202 `{ detection }`; `PUT /logo` raw body with `content-type: image/png|jpeg|webp` (413 `logo_too_large`, 415 `logo_type`); `DELETE /logo`; `POST /origins` `{ origin }` → 201; `DELETE /origins/:origin` (URL-encode it). Errors: `invalid_origin`, `origin_exists`, `too_many_origins`, `not_found`, `no_site`, `origin_not_allowed`, `detect_running`, `invalid_body` (codes and messages in `apps/api/src/widget.ts`).
- Contracts (`// ---- Dashboard API: website widget`): `WidgetSettings`, `WidgetTheme`, `ThemeOverrides`, `FontChoice`, `DetectedTheme`, `InstallCheck`/`InstallState`, `Detection`, `AllowedOrigin`, bodies `WidgetAppearanceBody`, `WidgetDetectBody`, `WidgetOriginBody`, response `WidgetDetectResponse`; `WIDGET_ORIGIN_LIMIT` (20), `WIDGET_LOGO_MAX_BYTES`, `WIDGET_LOGO_TYPES`. `Hex` lower-cases on parse.
- Preview iframe (`previewUrl`, `sandbox="allow-scripts"`): it posts `{ type: 'kaki-preview-ready' }` to its parent when listening; send it `{ type: 'kaki-preview', theme: WidgetTheme, botName, greeting, scheme?: 'light'|'dark', site?: { background: '#rrggbb'|null, font: string|null } }` (validated in `apps/widget/src/preview-message.ts`; anything else is ignored). `scheme` is the preview's light/dark toggle when no override fixes one. For the mock page, `site` can come from `theme.detected` (font) — there's no detected background, so pass `null` unless the UI has one.
- "Adjusted for contrast": `clampAccent(hex, scheme)` from `@kaki/channels/theme` (now a declared entry point in `.dependency-cruiser.cjs`); the dashboard needs `@kaki/channels` as a dependency (lockfile change).
- `siteUrl` is the first website source whose origin is still allowed, else the first allowed origin, else null; `fromWebsite` marks origins added by website sources. The 20-origin cap counts only hand-added ones.
- Install check: `detected` (seen on a still-allowed origin) wins over `wrong_domain`; poll `GET /api/v1/widget` every 5 s while `waiting` or `wrong_domain` (D8).
- Snippet now carries `data-api` (the api's public URL, new `PUBLIC_API_URL`), so a CDN-hosted loader finds the api.
- Fixture sites are served by `pnpm --filter @kaki/widget dev` at `http://localhost:5175/sites/{wordpress,wix,shopify,plain}.html` with the dev key filled in (expected values in each file's comment); E2E (T11) can use them, and the dev tenants already allow `http://localhost:5175`.
- Loader gz: 1.75 kB on `main` → 4.39 kB (AC-12 numbers in tasks.md T7).

## Left to CI or later
- E2E `widget-install.e2e.ts`, screen renders and axe: Ken's local CI (widget change, so verify asks for a run anyway).
- `apps/ingest-worker/test/files.int.test.ts` needs LocalStack (no Docker here); untouched by this feature.
- Lighthouse ≤ 2-point check (CHN-02): M2 close (D1).

## Pending for Ken
- Non-blocking: confirm the Lighthouse check moves to the M2 close (already in pending-actions.md).
