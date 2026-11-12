# Handoff: FEAT-029 — Web context and first-party intent tracking; consent mode
Branch: feat/FEAT-029-web-context · PR: none · Updated: 2026-11-12 by build (backend)
Stage done: build (T1–T7 of 12)
Next: build (UI, T8–T12) — kickoff: "Build FEAT-029 (UI) on branch feat/FEAT-029-web-context.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the UI session needs
- Contracts (`@kaki/contracts`, section "Web context"): `TrackingMode`, `PagePath`, `Utm`, `TrackEvent`, `TrackBody`, `TrackingChoiceBody`, `WidgetTrackingBody`, `WebContext`, `TRACKING_PROMPT_VERSION` (`'tracking-v1'`: use it as the widget strings' `trackingPromptVersion`; the server stores it with the choice).
- `WidgetConfigResponse.tracking: { mode }` (defaults to `off` when absent); `SendMessageBody.page` (path only; send it on every message in every mode).
- `POST /widget/v1/events`: body `{ token, events }` as `text/plain` JSON via `sendBeacon` (no headers); 204 always when accepted (also when the mode drops it), 400 bad body, 401 bad token/origin, 429 over 120 events/10 min. Max 20 events, 16 KB. `view` ids are client UUIDs (retries are idempotent); `engage` uses the view's id, `dwellMs` ≤ 86 400 000, `scroll` 0–100; `referrer` host only.
- `POST /widget/v1/tracking-choice` (Bearer token) `{ choice }` → 204, or 409 `not_consent_mode`. `declined` deletes the visitor's events.
- Dashboard: `GET /api/v1/widget` → `tracking: { mode, updatedAt }`; `PUT /api/v1/widget/tracking` `{ mode }` → `WidgetSettings` (staff 403; invalid body 422).
- Sidebar: `ConversationThread.sidebar.web` = `WebContext` (`scope`, `currentPage`, `viewed[{path, dwellMs, at}]`, `source{utm, referrer}|null`, `returning`). Email/Telegram conversations: `page_only`, `currentPage: null`.
- Fixtures already updated: `apps/dashboard/src/lib/inbox.test.ts`, `lib/widget.test.ts`, `apps/widget/src/preview.ts` (`tracking: { mode: 'off' }`).
- Dev tenants default to mode `on` (columns default). The E2E (T11) must restore `on` in `afterEach`.
- Deviations (in tasks.md notes): sidebar `web` is assembled in `apps/api/src/inbox.ts` (inbox doesn't depend on channels); `agent.decision` uses flat keys `webScope/webPage/webViewed/webReturning`.

## Left to CI or later
- E2E `web-context.e2e.ts` and axe (T11) in the verify stage's GitHub CI. `apps/api` `uploads.int` needs LocalStack (not run here; untouched).
- Full `pnpm typecheck` and the T12 checks run in the UI session (format:check and lint already pass here).

## Pending for Ken
- None blocking. FEAT-061 (GOV-05) must delete tracking rows per contact (in pending actions).
