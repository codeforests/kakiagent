# Handoff: FEAT-029 — Web context and first-party intent tracking; consent mode
Branch: feat/FEAT-029-web-context · PR: none · Updated: 2026-11-12 by design
Stage done: design
Next: build (backend, T1–T7) — kickoff: "Build FEAT-029 (backend) on branch feat/FEAT-029-web-context.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- D1 (Ken, 2026-11-12): the tracking consent prompt is inside the chat panel, not on the host page.
- Endpoint is `/widget/v1/events` (plan said `/v/events`); token travels in the body because `sendBeacon` can't set headers; accept `text/plain`.
- Migration is `0058`; `visitor_events` has no contact ID (D8). Mode is derived from two booleans on `widget_settings`.
- The model never gets UTM/source or dwell (D5); `trackingGuard` runs after the leak guard in `compose.ts`.
- Replay uses only the message's stored `page_path` (`page_only`).

## Left to CI or later
- E2E `web-context.e2e.ts` and axe run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken
- None blocking. FEAT-061 (GOV-05) must delete tracking rows per contact: added to pending actions.
