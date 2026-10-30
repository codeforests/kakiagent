# Handoff: FEAT-035 — Onboarding wizard frame and go-live readiness check
Branch: feat/FEAT-035-onboarding-wizard · PR: none · Updated: 2026-10-30 by build (backend)
Stage done: build (T1–T3 of 9)
Next: build (UI, T4–T9) — kickoff: "Build FEAT-035 (UI) on branch feat/FEAT-035-onboarding-wizard. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the UI session needs
- Routes (all `settings.manage`; Agent 403): `GET /api/v1/onboarding/progress` → `OnboardingProgress`; `PUT /api/v1/onboarding/progress/:step` body `StepOutcomeBody` → `OnboardingProgress` (400 `not_skippable` for profile/go_live skipped, 404 unknown step, 400 `invalid_body`); `GET /api/v1/onboarding/readiness` → `ReadinessResponse` (items always seven in `ReadinessKey` order, `channels` = the Channels page's `ChannelItem`s); `POST /api/v1/onboarding/go-live` body `GoLiveBody` → `ReadinessResponse` after the change.
- Errors: 409 `{ error: 'not_ready', missing: ReadinessKey[] }` (contract `NotReady`) from go-live and from `POST /channels/:id/live` before the first go-live; 409 `warnings_unacknowledged`; 409 `version_conflict` and 404 `not_found` as the channels routes.
- Contracts (`packages/contracts/src/index.ts`, last section): `OnboardingStep`, `OnboardingProgress` (`steps` is a partial record), `StepOutcomeBody`, `ReadinessKey`, `ReadinessResponse`, `GoLiveBody`, `NotReady`. `firstLiveAt` is an ISO string or null.
- `PUT …/:step` with `done`/`skipped` already moves `currentStep` to the next step; `visited` sets it to that step. Going live sets `currentStep = 'go_live'`.
- Dev tenants are seeded as already live (`onboarding_progress` row with `first_live_at`), so their Channels page is never gated and the Home "Continue setup" card won't show for them; E2E needs a fresh sign-up (as `auth.e2e.ts`) to see the wizard state.
- Deviation: `first_live_by` has no FK to `users` (as `boundary_rules.created_by` and the audit's actor IDs); design §4 had one.
- `review.e2e.ts:209` and `privacy.e2e.ts:192,202` assert "Step N of the setup"; change them to the header text in T5.

## Left to CI or later
- E2E and renders run in the verify stage's GitHub CI (no Docker here). `uploads.int.test.ts`'s S3 presigner case needs Docker; the known flaky FEAT-027 coach audit case failed once and passed on re-run (pending-actions.md).

## Pending for Ken
- None.
- Token tracking: each stage appends to `/mnt/project-files/reviews/feat-035-token-use.md`; verify writes the closing comparison against FEAT-054 and earlier (Ken, 2026-10-30).
