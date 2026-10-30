# Handoff: FEAT-035 — Onboarding wizard frame and go-live readiness check
Branch: feat/FEAT-035-onboarding-wizard · PR: draft (see below) · Updated: 2026-10-30 by build (UI)
Stage done: build (T1–T9 of 9), status developer-done
Next: verify — kickoff: "Verify FEAT-035 on branch feat/FEAT-035-onboarding-wizard. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Routes and contracts as the backend handoff (design §3). UI: `/setup/*` now sits under its own layout route (`router.tsx`): `AppShell focused` → `SetupLayout` (`shell/wizard-header.tsx`) → step page. Step data and helpers in `lib/onboarding.ts`; go-live page `pages/go-live.tsx`; Home card `pages/home.tsx`; not-ready alert in `pages/channels-parts.tsx` `ChannelCard`.
- Deviations from ui-design: Go live's disabled caption also names the other two causes ("Tick \"I understand\"…", "Choose a channel…"), not only "Fix the missing items". "Save assistant" is enabled while the settings were never saved, so the defaults can be saved as they are (D3 needs a save). Fix links have the accessible name "Fix: {label}". The "You're live" lede has a fallback when every channel was taken offline later.
- The profile step now continues to `/setup/sources` (was `/knowledge`) with the same toast, raised by the frame's toast (`useWizardToast`) since step pages don't all read router-state toasts.
- E2E: new `e2e/tests/onboarding.e2e.ts` (fresh sign-up; needs a working Mailpit like `auth.e2e.ts`). Updated for the frame: `review`, `privacy` (Continue is a button; "Step N of 7 · title"; the caption now includes saved assistant settings), `coach` (Continue button), `business-profile` (continues to step 2).
- In dev (StrictMode) each step change records `visited` twice; harmless (idempotent).

## Left to CI or later
- All E2E (incl. the new spec and the four updated ones) and renders run in the verify stage's GitHub CI (no Docker here). A stubbed-API Chromium run covered the go-live flow, focus and axe (tasks.md AC-9).
- Integration suites were run in the backend session; this session changed no backend code.

## Pending for Ken
- None.
- Token tracking: each stage appends to `/mnt/project-files/reviews/feat-035-token-use.md`; verify writes the closing comparison against FEAT-054 and earlier (Ken, 2026-10-30).
