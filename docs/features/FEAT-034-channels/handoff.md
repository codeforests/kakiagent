# Handoff: FEAT-034 — Channel framework: adapter contract, go-live and go-offline per channel, health and degraded alerts
Branch: feat/FEAT-034-channels · PR: (draft, see below) · Updated: 2026-10-27 by build (UI)
Stage done: build (T1–T11 of 11), status developer-done
Next: verify — kickoff: "Verify FEAT-034 on branch feat/FEAT-034-channels. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Dashboard: `pages/channels.tsx` (SCR-APP-036) with parts in `pages/channels-parts.tsx`; data in `lib/channels.ts` (`useChannels` refetches every 60 s and on focus); banner slot `shell/banners.tsx`, rendered at the top of `<main>` in `app-shell.tsx`, Owners/Admins only, hidden on `/settings/channels`.
- Shared changes: `ConfirmDialog` gained `busyLabel`; `ErrorSummary` is now exported from `pages/privacy-parts.tsx`.
- Widget: `availability.ts` `mounts()` (loader), `chat.ts` `notLiveView()`, `NotLiveCard` in `panel.tsx`, strings `notLiveEmail`/`notLivePhone`/`notLiveRegion`. The not-live region is named after the assistant (`botName`), since the config has no business name (ui-design says "{business}").
- Contract fixtures in `packages/contracts/src/widget.test.ts` gained `availability: { live: true }`.
- How each state was checked is in the T8–T10 notes of `tasks.md` (stubbed API in the session's Chromium, axe clean).

## Left to CI or later
- Ken's local CI is due before merge: widget files, the lockfile (backend session) and a new E2E spec (`e2e/tests/channels.e2e.ts`, two tests; its `afterEach` resets the dev widget to live and hidden).
- Not run here: api `uploads.int.test.ts` "the S3 presigner" (no S3 endpoint). agent `language-hours` "carries the notice once per closed period" is clock-dependent and failed on the design commit too (backend notes); it passed in this session's coverage run.
- Running agent and api integration suites in parallel on one Postgres can collide on `CREATE ROLE kaki_widget_resolver`; run them one at a time.

## Pending for Ken
- Nothing blocking. Local CI run for the PR (above).
