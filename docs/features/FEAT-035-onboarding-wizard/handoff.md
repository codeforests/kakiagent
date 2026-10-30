# Handoff: FEAT-035 — Onboarding wizard frame and go-live readiness check
Branch: feat/FEAT-035-onboarding-wizard · PR: none · Updated: 2026-10-30 by design
Stage done: design
Next: build (backend, T1–T3) — kickoff: "Build FEAT-035 (backend) on branch feat/FEAT-035-onboarding-wizard. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Readiness lives in `tenancy` (`readiness.ts`, `onboarding.ts`) and imports kb, approvals, governance, identity, channels by package name (D1). Add the four deps to `packages/tenancy/package.json`; run `pnpm lint` early to confirm dependency-cruiser sees no cycle.
- Inputs that already exist: governance `privacyReadiness`, approvals `rulesSaved`, kb `reviewSummary(dashboardKb(tx, tenantId, userId))` (`approvedInUse`, `needsReview`, `conflicts`), tenancy `getBusinessProfile`/`getAssistantSettings` (`version` 0 = never saved). Identity gets a new `termsAccepted(tx, tenantId)`.
- The gate applies only while `first_live_at` is null (D4). Migration 0039 backfills tenants already live, and the dev seed (`packages/db/src/setup.ts` `seed`) must add the row for both dev tenants, or `channels.e2e.ts` breaks.
- `POST /channels/:id/live` goes through tenancy `goLiveOne`; warnings never block there (D5).
- Fresh tenants for tests: no progress row, widget offline (FEAT-034 trigger). Build them like the welcome-flow tests do.
- UI session: the setup routes move under one `/setup` layout route with `AppShell focused`; paths stay (D7). `review.e2e.ts:209` and `privacy.e2e.ts:192,202` assert "Step N of the setup" and must change to the header text.

- Token tracking: each stage appends to `/mnt/project-files/reviews/feat-035-token-use.md`. The verify stage also writes the closing comparison against FEAT-054 and earlier features, separating what the FEAT-054 token fixes (PRs #39, #40) saved from what is just feature size (Ken, 2026-10-30).

## Left to CI or later
- E2E (`onboarding.e2e.ts`, the changed review/privacy/channels specs) and screen renders run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken
- Q1: is a UEN required to go live? Recommended no (D2); designed that way, decision card open. A "yes" adds one condition to `profileComplete` and one copy line.
