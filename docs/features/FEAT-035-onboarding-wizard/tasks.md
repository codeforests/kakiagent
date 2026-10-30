# Tasks: FEAT-035 — Onboarding wizard frame and go-live readiness check

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-30

- [ ] T1 — Schema: `0039_onboarding_progress.sql` (table, checks, forced RLS, policy, `select, insert, update` to `app_dashboard`, backfill of tenants already live) + Drizzle table; name in `TENANT_SCOPED_TABLES`; RLS suite case; dev seed row for both dev tenants (design §4; D4; AC-8)
      Done when: `drizzle-kit generate` reports no drift after 0039; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with: tenant B reads and updates none of A's rows; inserting A's tenant ID in B's context fails; `app_dashboard` delete is refused; a tenant with a live widget before 0039 has `first_live_at` set.
- [ ] T2 — Domain: identity `termsAccepted`; tenancy `onboarding.ts` (`ONBOARDING_STEPS`, `getProgress`, `recordStep`, `NotSkippableError`) and `readiness.ts` (`profileComplete`, `goLiveReadiness`, `goLive`, `goLiveOne`, `NotReadyError`, `WarningsUnacknowledgedError`, the `onboarding.first_live` audit); exports; package deps (design §5.1, §5.2; D1–D6; AC-1–AC-7)
      Done when: `pnpm --filter @kaki/tenancy test` (unit: `profileComplete` per missing field, step order and next-step) and `scripts/test-env.sh pnpm --filter @kaki/tenancy test:integration` pass with: no row reads as profile/never live; skip of profile refused; each readiness item flips on its own input; `goLive` blocked lists exactly the failing keys and writes nothing; warnings need the acknowledgement; success sets channels live, `first_live_at` and one audit with `minutesToLive`; a second call doesn't re-audit; `goLiveOne` after first live skips the gate; `pnpm lint` dependency-cruiser shows no cycle.
- [ ] T3 — Contracts and API: contract section (§3) + unit test; `apps/api/src/onboarding.ts` (four routes, error mapping); `channels.ts` `live` through `goLiveOne` with 409 `not_ready`; `apps/api/test/onboarding.int.test.ts` (design §5.3; AC-1–AC-8)
      Done when: `pnpm --filter @kaki/contracts test` and `scripts/test-env.sh pnpm --filter @kaki/api test:integration` pass with the cases in design §5.3 and the existing channels suite still green (dev-seeded tenants are already live); `pnpm --filter @kaki/api typecheck` is clean.

## Build session 2 (UI)

- [ ] T4 — Dashboard data: `api.getProgress`/`recordStep`/`getReadiness`/`goLive`, `lib/onboarding.ts` (`STEPS`, `stepOf`, `nextStep`, `prevStep`, `useProgress`, `useRecordStep`, `useReadiness`, `useGoLive`, `missingItems`), `lib/onboarding.test.ts` (design §5.4)
      Done when: `pnpm --filter @kaki/dashboard test` passes with `stepOf` (each path, unknown path), next/prev at the ends, `missingItems` order and fix paths; dashboard typecheck clean.
- [ ] T5 — Wizard frame: `/setup` layout route with `AppShell focused`, `shell/wizard-header.tsx` (step N of 7, title, progress, step list, Save and exit, `visited` on step change), `WizardFooter` (Back, Skip for now, Continue) on steps 1–6 replacing their Continue links and "Step N of the setup" ledes; profile save → `/setup/sources`; existing E2E text asserts updated (ui-design "Wizard frame"; AC-1, AC-2, AC-9)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run at 1280 and 375 shows the header, the step list states, Skip and Save and exit recording outcomes (logged request bodies only), focus on the step title after navigation, axe clean.
      Note: renders against the real stack and full axe run in the verify stage's GitHub CI.
- [ ] T6 — SCR-APP-009: extract `AssistantBlock` from `pages/assistant.tsx` (Settings page unchanged), add it to `setup-rules.tsx` as the "Assistant" section with `id="assistant"`; the ready caption also needs saved assistant settings (ui-design SCR-APP-009; AC-10)
      Done when: dashboard typecheck and build pass; Settings → Assistant behaves as before (its E2E spec unchanged and green in CI); the step shows the block.
- [ ] T7 — SCR-APP-012 `pages/go-live.tsx` (`/setup/go-live`): checklist, warnings, pre-live form line, channel choice, "I understand", confirm dialog, live state, 409 handling; Website step's Continue → go-live; Home "Continue setup" card; Channels page `not_ready` alert (ui-design SCR-APP-012, Home, Channels; AC-4–AC-6, AC-9)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run covers blocked, warnings (Go live disabled until "I understand"), ready → confirm → live, 409 `not_ready` refresh, at 1280 and 375 with axe clean.
- [ ] T8 — E2E `e2e/tests/onboarding.e2e.ts` (design §5.5; AC-1, AC-2, AC-4, AC-9)
      Done when: the spec typechecks and lints; it runs in the verify stage's GitHub CI (all three browsers).
- [ ] T9 — Verify: full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, this feature's tests; `code-map.md` updated (tenancy readiness and onboarding, the focused shell and wizard parts, migration 0039); tasks status `developer-done`
      Done when: all pass, evidence below, draft PR open.

## Verification evidence

- AC-1 — 
- AC-2 — 
- AC-3 — 
- AC-4 — 
- AC-5 — 
- AC-6 — 
- AC-7 — 
- AC-8 — 
- AC-9 — 
- AC-10 — 
