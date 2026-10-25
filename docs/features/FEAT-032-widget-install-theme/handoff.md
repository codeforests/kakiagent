# Handoff: FEAT-032 — Widget install, theme matching, allowed origins, install check
Branch: feat/FEAT-032-widget-install-theme · PR: none · Updated: 2026-10-25 by design
Stage done: design
Next: build (backend, T1–T7) — kickoff: "Build FEAT-032 (backend) on branch feat/FEAT-032-widget-install-theme. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Allowed origins stay in `tenants.allowed_origins` (D2); everything else is the new `widget_settings` (migration 0031), owned by `packages/channels`, which gains `@kaki/db` and `@kaki/platform` deps (lockfile changes).
- One detection module, `@kaki/channels/theme` (DOM-only, no Node imports): the loader bundles it, and `build.mjs` also emits it as `dist/w/v1/detect.js`, which the ingest-worker fetches from `WIDGET_ASSET_URL` and injects into Chromium (D4). Don't import the widget app from the worker.
- Port `detectTheme`/`clampAccent` from `docs/02-design/anchors/scr-wgt-002-chat-panel.html` (~l. 76–100), but clamp in OKLCH lightness (design.md §4.9). Overrides are clamped too (D5).
- Theme-detect jobs ride the existing `ingest` outbox topic with `payload.kind = 'theme_detect'`; the crawl consumer must keep treating payloads without `kind` as source jobs.
- Config route: on a known key + active tenant + wrong origin, record `rejected_origin` (throttled) and still answer the same 404 `not_here`.
- The four fixture host pages (`apps/widget/dev/sites/`) are made in T5 and reused by E2E (T11).
- Record the loader's gz size on `main` before changing it (AC-12 needs before/after).
- Widget unit tests run in Node (no DOM library; don't add one): DOM detection is tested in Chromium (T5) and E2E.

## Left to CI or later
- E2E `widget-install.e2e.ts`, screen renders and axe: Ken's local CI (this feature touches the widget, so its verify asks Ken for a local CI run anyway).
- Lighthouse ≤ 2-point check (CHN-02): not in this feature (D1); proposed for the M2 close.

## Pending for Ken
- Non-blocking: confirm the Lighthouse check moves to the M2 close (pending-actions.md).
