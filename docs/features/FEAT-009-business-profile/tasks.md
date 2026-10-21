# Tasks: FEAT-009 — Business profile, hours, SG holidays, F&B industry template

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: done · Last updated: 2026-10-21

- [x] T1 — Schema: the profile columns and checks, `version`, the `holidays` table (drizzle schema + `0018`), `0019` with forced RLS, policy, grants (column-level `UPDATE` on `business_profiles` and `tenants.name`) and `visitor_tenant_state()` recreated with `holidays`; `TENANT_SCOPED_TABLES` (design §4)
      Done when: `pnpm db:setup` applies 0018–0019 on the running stack; the RLS suite passes with new cases: tenant B can't read or write tenant A's `holidays`, the dashboard role can't update other `tenants` columns, the visitor role can't select `holidays`, the function returns only the current tenant's exceptions within the window, and the checks reject a bad UEN, phone, industry, language, kind and blank label.
- [x] T2 — Tenancy hours and calendar: holiday names and `sgHolidaysBetween`, exceptions in `hoursOn`/`openStatus`, `closedReason`, `visitorTenantState().holidays` (design §5.1; AC-4, AC-5)
      Done when: unit tests pass for the names and range (2026 and 2027, days in lieu), closures, `open` exceptions on a public holiday, a `closed` public holiday under the "open" rule, and every FEAT-023 `openStatus` case unchanged without exceptions.
- [x] T3 — Tenancy profile and template: `getBusinessProfile`, `saveBusinessProfile` with version, name, exceptions (redundant dropped, non-holiday `open` rejected) and audit; `INDUSTRY_TEMPLATES` with the F&B suggestions and `questionKey` (design §5.1; AC-1, AC-5, AC-7, AC-8)
      Done when: tenancy integration tests pass: read; save bumps the version and renames the tenant; a stale version raises `SettingsConflictError` and changes nothing; exceptions from today are replaced and past rows kept; the audit entry has field codes and no values.
- [x] T4 — Agent and evals: exceptions through the turn, `hours.today` for a closure, the eval `holidays` field and `feat-009-holidays.json` (design §5.2; AC-6, AC-12)
      Note (2026-10-21): four eval cases rather than two (a closure with the notice, the closure's "closed today", a public holiday marked open, and the same holiday closed by the rule); the set is 0.8.0 and the agreement sample names it. A planted wrong expectation was reported as FAIL, then restored. The `open`-on-a-holiday case is shown in the evals and unit tests, not the agent integration test, because `visitor_tenant_state()` windows exceptions around the database's real date.
      Done when: agent tests pass for a closure-day notice with the next opening and "closed today"/"今天休息", an `open` holiday with no notice, `system` unchanged by an exception; `pnpm eval` and `--fast` pass with the new cases.
- [x] T5 — Contracts and api: the §3.1 shapes with the screen's messages, `GET`/`PUT /api/v1/settings/business-profile`, `InvalidProfileError` → 400, the template's `added` from the KB (design §3, §5.3; AC-1, AC-2, AC-3, AC-7, AC-8)
      Done when: api integration tests pass for GET, PUT success and version bump, each AC-2/AC-3 invalid value (400), the refinements, 403 for an Agent, 409 on a stale version, the calendar range, and `template` for `fnb` with `added` after a FAQ fact exists and null otherwise.
- [x] T6 — Dashboard: `BusinessProfileForm` with the hours editor, holiday list and closures; SCR-APP-044 at `/settings/business-profile`, the `/setup` wizard mode, the suggested-FAQs card, the FAQ prefill in `fact.tsx`, the Settings index link (design §5.4; ui-design.md; AC-10)
      Note (2026-10-21): checked on the local stack at 375 and 1280 px (default, validation with the summary, closures, holiday list, suggestions). axe found the "Add answer" links' accessible names didn't contain their visible text (WCAG 2.5.3); they are now "Add answer: {question}". As in FEAT-024, the dashboard has no component-test framework, so the states are asserted in T8's E2E spec.
      Done when: the screen renders and conforms to ui-design.md on the local stack at 375 px and desktop (default, loading, validation, saving, saved, conflict, error, permission; wizard mode), checked in the browser.
- [x] T7 — Dev seed: the bakery's profile values (design §5.5)
      Done when: `pnpm db:setup` is idempotent and the bakery shows industry F&B with its UEN, contacts and languages; existing E2E specs still pass.
- [x] T8 — E2E: `e2e/tests/business-profile.e2e.ts` (AC-10, AC-11, with axe)
      Note (2026-10-21): `auth.e2e.ts` asserted the old `/setup` placeholder heading ("Set up your assistant"); the sign-up flow now lands on the setup step, so it asserts "Tell us about your business". The test still checks the same thing (the new owner reaches setup); only the expected heading changed with the screen.
      Done when: the new spec and the existing Chromium suite pass against the local stack.
- [x] T9 — Verify: every AC in design §6 demonstrably passes; format, lint and boundaries, typecheck, unit, integration with coverage, build and size, E2E, evals and audit green; scaffold notes, RTM design ref and the manifest updated
      Done when: all of the above pass in one fresh run, with the evidence recorded here.

## T9 evidence (2026-10-21, one run from the committed tree, local stack up)

| Check | Result |
|---|---|
| `pnpm format:check` | pass |
| `pnpm lint` (ESLint, then dependency-cruiser) | pass; no dependency violations (284 modules, 787 dependencies) |
| `pnpm typecheck` | pass (26 tasks) |
| `pnpm test` | pass (22 tasks) |
| `pnpm test:coverage` (unit + integration, Testcontainers) | pass (15 tasks, every threshold met); db 89 tests, tenancy 37, agent 345, api 96, governance 93, platform 265, kb 30, identity 30 |
| `pnpm build && pnpm size` | pass: loader 1.75 KB gz (≤ 14); widget unchanged |
| `pnpm test:e2e --project=chromium` | pass: 31 tests, including the 5 in `business-profile.e2e.ts` |
| `pnpm eval` / `pnpm eval --fast` | pass: 248 / 137 cases, every subset at 1.000; eval set 0.8.0 |
| `pnpm audit --prod --audit-level=high` | no known vulnerabilities |

| Criterion | Where it is shown |
|---|---|
| AC-1 | `apps/api/test/profile.int.test.ts` (save, version + 1, rename, 403 for an Agent, 401, 409 and nothing changed); `tenancy/test/profile.int.test.ts` |
| AC-2 | `profile.int.test.ts` (12 rejected values, 4 accepted UENs, phone normalisation); `db/test/rls.int.test.ts` "business profile and holidays (FEAT-009)" (database checks); `business-profile.e2e.ts` (inline and summary UEN error) |
| AC-3 | `profile.int.test.ts` (open after close, overlap, five ranges, bad time; 24:00 and null accepted); `business-profile.e2e.ts` (the day named in the summary) |
| AC-4 | `tenancy/src/hours.test.ts` (names, days in lieu, range); `profile.int.test.ts` (calendar within a year, cover year 2027) |
| AC-5 | `hours.test.ts` "holiday exceptions"; `tenancy/test/profile.int.test.ts` (redundant dropped, non-holiday `open` and past days refused); `profile.int.test.ts` (the contract refusals) |
| AC-6 | `agent/test/language-hours.int.test.ts` "holiday exceptions through the turn" (notice, "closed today"/"今天休息", `system` unchanged); eval `feat-009-holidays.json` |
| AC-7 | `profile.int.test.ts` "the F&B template" (suggestions, `added` ignoring case and spaces, none for retail, no KB write); `tenancy/test/profile.int.test.ts` (template ids); `business-profile.e2e.ts` (Add answer prefills, Added badge) |
| AC-8 | `tenancy/test/profile.int.test.ts` and `profile.int.test.ts` (one `settings.profile_updated` with field codes, no values) |
| AC-9 | `rls.int.test.ts` "business profile and holidays (FEAT-009)" |
| AC-10 | `business-profile.e2e.ts` (all five tests, axe on the screen); screenshots at 375 and 1280 px during T6 |
| AC-11 | `business-profile.e2e.ts` "the owner sets a closure for today, answers a suggested question, and the widget says it is closed" |
| AC-12 | `pnpm eval` and `--fast` above |
