# Acceptance report: FEAT-035 — Onboarding wizard frame and go-live readiness check

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-10-30 by an independent verify session · Branch `feat/FEAT-035-onboarding-wizard` · PR #41

## Verdict summary

**Accepted.** ONB-02 and ONB-09 are met; ONB-08 is instrumented only, as the plan says (partial). ONB-10 gains the readiness gate FEAT-034 left to this feature (pre-live lead capture stays with FEAT-049). AGT-08 and AGT-11 gain the setup-step assistant block. Every criterion below has a test that asserts what it says, and every local result was produced in this session. E2E (the new `onboarding.e2e.ts` and the four specs updated for the frame) run in GitHub CI (section CI).

## Audit standard

Re-derived from SRS v0.4 ONB-02, ONB-08, ONB-09, ONB-10, AGT-08, AGT-11; UC-03 (1a, 7a, 9–11, 10a); technical-design §6 AC-1..AC-10, D1–D9. Every FR maps to at least one AC; criteria are faithful to the SRS statements ("before the first go-live" → D4 gate only until the first go-live; "can go live with warnings" → D5).

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 | ONB-02 saved at every step; UC-03 1a | tenancy `readiness.int` "visited moves the step…", api `onboarding.int` "round-trips…", dashboard `lib/onboarding.test`, `onboarding.e2e` (Save and exit, Home card after reload) | Yes: a new transaction/request reads the same step | Pass (E2E in CI) |
| AC-2 | ONB-02 skip after the profile | both int suites "refuses skipping the profile or go-live…" (400 `not_skippable`), skipped then done; unit `STEPS.skippable` = steps 2–6; E2E Skipped chip | Yes | Pass |
| AC-3 | ONB-09 required items; D2, D3 | `readiness.int` "each item flips on its own input and only that one", "a UEN is optional…"; unit `profileComplete` per field; api "lists all seven items in order" | Yes: one input changed at a time, only its key flips | Pass |
| AC-4 | ONB-09 block; UC-03 10a | `readiness.int` "blocked: lists exactly the failing keys and changes nothing"; api "409 not_ready … on both routes" (channel offline, no `channel.live`/`onboarding.first_live` audit, `firstLiveAt` null); E2E fix links and Channels not-ready alert | Yes | Pass (E2E in CI) |
| AC-5 | ONB-09 warnings; UC-03 7a | api "warnings need the acknowledgement on the check" (409 `warnings_unacknowledged`, then live; `visitor_facts` holds only the approved fact); `readiness.int` Channels route never blocks on warnings | Yes | Pass |
| AC-6 | UC-03 10–11; ONB-10 | api "ready: goes live … later the gate is gone", "a stale version is 409 … nothing changes"; `readiness.int` "ready: … audits it once" | Yes: one `first_live`, one `channel.live`, no re-audit; rollback on stale version | Pass |
| AC-7 | ONB-08 (p) | `readiness.int` payload `{ minutesToLive: 95, channels: [id] }` for a tenant created 95 min earlier, actor the user | Yes; payload is IDs and a number only (ADR-014) | Pass |
| AC-8 | ADR-005; RBAC | RLS suite (B reads/updates/inserts none of A's, no delete, visitor no access, backfill); api Agent 403 on all four routes, B with A's channel 404 | Yes | Pass |
| AC-9 | SCR-APP-006..012 frame; NFR-19, NFR-09 | `onboarding.e2e` (header, step list states, Back/Skip/Continue, blocked check, axe 1280/375 tall, light and dark); builder's stubbed-API run for ready → confirm → live | Yes for the frame and blocked state; ready/live/error states rest on the stub run plus code read (finding O1) | Pass (E2E in CI) |
| AC-10 | SCR-APP-009; AGT-08, AGT-11 | `privacy.e2e` caption (needs saved assistant settings); `AssistantBlock` shared with Settings → Assistant (same query key and save), `assistant.e2e` unchanged | Yes | Pass (E2E in CI) |

## Corrected tests

None. Test diff reviewed (`git diff origin/main...HEAD -- '*test*' e2e/`): no skips, `.only` or deleted cases. The four updated specs change only what the frame changed (Continue is a button, "Step N of 7 · title", profile continues to `/setup/sources`, caption names assistant settings). `coach.e2e` now asserts Continue is visible rather than its `href`; navigation by the frame is covered by `onboarding.e2e`.

## Independent execution

Fresh `pnpm install`, `pnpm tokens`, then: `pnpm format:check` clean; `pnpm lint` (ESLint + dependency-cruiser, 591 modules, no violations, no cycle from tenancy's new deps); `pnpm typecheck` 26/26; `pnpm test` 24/24 tasks. Through `scripts/test-env.sh`, `test:coverage` with thresholds: db 155 passed; tenancy 59; identity 52; contracts 19; api 304 passed, 1 skipped, and `uploads.int.test.ts` "the S3 presigner" failed only for want of a container runtime (no `KAKI_TEST_S3_ENDPOINT` here; file untouched by this feature; green in CI), api re-run without it: 27 files passed with thresholds met.

## Direct verification

- Gate code read (`tenancy/src/readiness.ts`): the progress row is locked `for update` before the first-live check, the gate runs only while `first_live_at` is null, channels go live through `setChannelState` in the caller's transaction, and the audit is written once. `channels.ts` routes only `live` through `goLiveOne`; offline is unchanged.
- Tenant ID only from the session (`apps/api/src/onboarding.ts`); `withTenant(dashboardDb, …)`.
- Migration 0039: forced RLS, policy and grants (no delete) in the same file; `TENANT_SCOPED_TABLES` and RLS case present; backfill marks already-live tenants live (D4).
- ONB-08 median query is recorded in technical-design §8; measurement on pilot tenants is pending environment.

## Findings

- O1 (observation, not blocking): SCR-APP-012's ready → confirm → live, error and conflict states are asserted by the builder's stubbed-API run, not by a committed spec; the backend behaviour behind them is covered by both int suites. Worth a committed E2E case when FEAT-036 extends the channel choice.

## RTM

Test ref appended for ONB-02, ONB-08 (partial: instrumented), ONB-09, ONB-10 (readiness gate), AGT-08 and AGT-11 (setup-step block).

## CI

Pending: recorded here once the GitHub CI run on the PR branch is green.
