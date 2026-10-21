# Tasks: FEAT-009 — Business profile, hours, SG holidays, F&B industry template

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: pending · Last updated: 2026-10-21

- [ ] T1 — Schema: the profile columns and checks, `version`, the `holidays` table (drizzle schema + `0018`), `0019` with forced RLS, policy, grants (column-level `UPDATE` on `business_profiles` and `tenants.name`) and `visitor_tenant_state()` recreated with `holidays`; `TENANT_SCOPED_TABLES` (design §4)
      Done when: `pnpm db:setup` applies 0018–0019 on the running stack; the RLS suite passes with new cases: tenant B can't read or write tenant A's `holidays`, the dashboard role can't update other `tenants` columns, the visitor role can't select `holidays`, the function returns only the current tenant's exceptions within the window, and the checks reject a bad UEN, phone, industry, language, kind and blank label.
- [ ] T2 — Tenancy hours and calendar: holiday names and `sgHolidaysBetween`, exceptions in `hoursOn`/`openStatus`, `closedReason`, `visitorTenantState().holidays` (design §5.1; AC-4, AC-5)
      Done when: unit tests pass for the names and range (2026 and 2027, days in lieu), closures, `open` exceptions on a public holiday, a `closed` public holiday under the "open" rule, and every FEAT-023 `openStatus` case unchanged without exceptions.
- [ ] T3 — Tenancy profile and template: `getBusinessProfile`, `saveBusinessProfile` with version, name, exceptions (redundant dropped, non-holiday `open` rejected) and audit; `INDUSTRY_TEMPLATES` with the F&B suggestions and `questionKey` (design §5.1; AC-1, AC-5, AC-7, AC-8)
      Done when: tenancy integration tests pass: read; save bumps the version and renames the tenant; a stale version raises `SettingsConflictError` and changes nothing; exceptions from today are replaced and past rows kept; the audit entry has field codes and no values.
- [ ] T4 — Agent and evals: exceptions through the turn, `hours.today` for a closure, the eval `holidays` field and `feat-009-holidays.json` (design §5.2; AC-6, AC-12)
      Done when: agent tests pass for a closure-day notice with the next opening and "closed today"/"今天休息", an `open` holiday with no notice, `system` unchanged by an exception; `pnpm eval` and `--fast` pass with the new cases.
- [ ] T5 — Contracts and api: the §3.1 shapes with the screen's messages, `GET`/`PUT /api/v1/settings/business-profile`, `InvalidProfileError` → 400, the template's `added` from the KB (design §3, §5.3; AC-1, AC-2, AC-3, AC-7, AC-8)
      Done when: api integration tests pass for GET, PUT success and version bump, each AC-2/AC-3 invalid value (400), the refinements, 403 for an Agent, 409 on a stale version, the calendar range, and `template` for `fnb` with `added` after a FAQ fact exists and null otherwise.
- [ ] T6 — Dashboard: `BusinessProfileForm` with the hours editor, holiday list and closures; SCR-APP-044 at `/settings/business-profile`, the `/setup` wizard mode, the suggested-FAQs card, the FAQ prefill in `fact.tsx`, the Settings index link (design §5.4; ui-design.md; AC-10)
      Done when: the screen renders and conforms to ui-design.md on the local stack at 375 px and desktop (default, loading, validation, saving, saved, conflict, error, permission; wizard mode), checked in the browser.
- [ ] T7 — Dev seed: the bakery's profile values (design §5.5)
      Done when: `pnpm db:setup` is idempotent and the bakery shows industry F&B with its UEN, contacts and languages; existing E2E specs still pass.
- [ ] T8 — E2E: `e2e/tests/business-profile.e2e.ts` (AC-10, AC-11, with axe)
      Done when: the new spec and the existing Chromium suite pass against the local stack.
- [ ] T9 — Verify: every AC in design §6 demonstrably passes; format, lint and boundaries, typecheck, unit, integration with coverage, build and size, E2E, evals and audit green; scaffold notes, RTM design ref and the manifest updated
      Done when: all of the above pass in one fresh run, with the evidence recorded here.
