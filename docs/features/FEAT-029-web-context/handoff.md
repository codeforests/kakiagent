# Handoff: FEAT-029 — Web context and first-party intent tracking; consent mode
Branch: feat/FEAT-029-web-context · PR: draft (see the PR list) · Updated: 2026-11-12 by build (UI)
Stage done: build (T1–T12 of 12), status `developer-done`
Next: verify — kickoff: "Verify FEAT-029 on branch feat/FEAT-029-web-context.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Widget: `apps/widget/src/track.ts` (pure helpers + `startTracker`), started in `loader.ts` `mount()` by `tracks(mode, choice)`; the loader keeps the choice in memory as well as in `localStorage` `kaki.track`, so a blocked storage still honours the page's answer. `PanelContext.tracking` is optional (the preview has none). Loader 4.47 → 5.96 KB gz (+1.49 KB; design budget ≤ 1.5 KB).
- Panel: `TrackingPrompt` (cards.tsx) at the top of the log in consent mode with no choice; menu items `stopTracking`/`shareTracking` from `menuItems(…, { tracking })`; the "stopped" notice is a local `li.notice[data-notice="tracking-stopped"]`. `api.send` takes `page` (`pathOf(location)`), `api.trackingChoice` (failures ignored).
- Dashboard: `TrackingSection` (widget-parts.tsx, after Websites) and `WebIntent` (conversation-parts.tsx, top of the Intent section, then a "Signals" caption when a current page exists). Helpers in `lib/widget.ts` and `lib/inbox.ts`; tests in `lib/web-context.test.ts`.
- T8 and T9 share one commit (both edit `panel.tsx`).
- Stubbed Playwright check of the widget (tasks.md T8/T9 note): all assertions held. The dashboard screens were not rendered here; the E2E covers them.

## Left to CI or later
- `e2e/tests/web-context.e2e.ts` (2 serial tests, axe on prompt at desktop and 375×5000, and on the settings section) runs first in the verify stage's GitHub CI.
- With dev tenants in mode `on`, every widget E2E spec now sends page beacons; watch for any spec that counts widget requests.
- `apps/api` `uploads.int` needs LocalStack (untouched).

## Pending for Ken
- None blocking. FEAT-061 (GOV-05) must delete tracking rows per contact (already in pending actions).
