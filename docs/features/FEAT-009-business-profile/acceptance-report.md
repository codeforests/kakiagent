# Acceptance Report: FEAT-009 — Business profile, hours, SG holidays, F&B industry template

> Verdict: **Accepted** (first verification; ONB-03 is complete; ONB-06 is partial by plan: the F&B template's suggested FAQs only, with its boundary rules in FEAT-054, its lead fields in FEAT-049 and the other industries in M7) · Date: 2026-10-21
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-12) @ `ab60179` · Sources: SRS v0.4 (ONB-03, ONB-06; AGT-09 p, KB-15 p, NFR-09, NFR-10, NFR-11, NFR-19), use-cases v0.4 (UC-03 1–3, UC-20 5b), ADR-005, ADR-008, ADR-010, ADR-013, ADR-014
> Repo state audited: `ab60179`

## Sequencing note

Plan §5 has the M1.5 real-model gate before M2. The owner decided on 2026-10-21 to build FEAT-009 first because it has no model dependency (design §0). This verification confirms that: no criterion depends on a model, and nothing here is marked "real-model check pending". **M1.5 must run before FEAT-012**, the first M2 feature that calls a model.

## Verdict summary

FEAT-009 is accepted. Each of AC-1..AC-12 has tests that assert what the criterion says, and every suite was re-run green from the audited tree. The feature's test diff adds lines; four existing tests were touched, none weakened (see "Test diff review"). There are no rework or design-defect findings. Two notes for the owner are listed under Findings.

This verification ran in the same session as the implementation, as for earlier features. Its standard was re-derived from the SRS, the use cases and design §6, not from tasks.md.

## Audit standard

- **ONB-03 (M):** "Business profile: name, UEN (format-validated), industry (picklist), operating hours and public holidays (SG calendar preloaded), contact email/phone, default languages, GST-registered (yes/no)." Acceptance: "Invalid UEN format is rejected. Hours drive the 'after-hours' behaviour. The GST flag drives price display (KB-15)." Encoded by AC-1 (every field saved and read), AC-2 (UEN, phone, email, languages, name validation), AC-3 (hours), AC-4 (calendar preloaded), AC-5/AC-6 (holidays and closures drive the after-hours behaviour), AC-10/AC-11 (the screen and end to end). The GST clause: the saved flag reaches the visitor zone (`tenancy/test/profile.int.test.ts` reads `gstRegistered: true` from `visitorTenantState` after a save), and KB-15's price display from that flag is FEAT-011's and FEAT-022's verified behaviour. Faithful.
- **ONB-06 (S, partial):** "Industry templates … that preload suggested boundary rules, lead fields and FAQs." Acceptance: "Choosing an industry pre-fills rules and lead form fields, which can be edited." The plan scopes FEAT-009 to the F&B template's suggested FAQs. Encoded by AC-7 (suggestions for F&B, none for others, nothing written to the KB, "Add answer" prefills an editable question) and AC-11. The design offers suggestions rather than writing unanswered FAQs (D5, ADR-010); see Findings, note 1.
- **UC-03** steps 1–3: AC-1, AC-2, AC-4, AC-7, AC-11. **UC-20 5b** (after hours from the profile): AC-6, AC-11.
- Binding NFRs: NFR-10 (SG formats, holidays, SGT) AC-2, AC-4, AC-5; NFR-11 (audit without values) AC-8; NFR-09/NFR-19 AC-10. Tenant isolation (GOV-03, ADR-005): AC-9.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | ONB-03, UC-03 1 | `apps/api/test/profile.int.test.ts` (whole profile, normalised, version + 1, tenant renamed, 403 for an Agent on GET and PUT, 401, 409 on a stale version with nothing changed); `packages/tenancy/test/profile.int.test.ts` | faithful | green |
| AC-2 | ONB-03, UC-03 2, NFR-10 | `profile.int.test.ts` (12 rejected values incl. each listed UEN and phone; 4 accepted UENs normalised; phones stored as `+65…`, blank as null); `packages/db/test/rls.int.test.ts` "the checks reject bad UENs, phones, …" (direct writes); `e2e/tests/business-profile.e2e.ts` (inline error on blur, linked summary) | faithful | green |
| AC-3 | ONB-03, AGT-09 | `profile.int.test.ts` (open after close, overlap, five ranges, malformed time → 400; `24:00` and `hours: null` accepted); `business-profile.e2e.ts` (summary names Monday, link focuses its time input; overlap) | faithful | green |
| AC-4 | ONB-03, NFR-10 | `packages/tenancy/src/hours.test.ts` (26 named days in order, days in lieu, range inclusive, nothing after the cover year); `profile.int.test.ts` (calendar within a year, only holidays, names, `coverThrough` 2027); E2E shows the cover-year line | faithful | green |
| AC-5 | SRS §1.4, AGT-09 | `hours.test.ts` "holiday exceptions" (closure with `closedReason`, `open` on a holiday, `closed` holiday under the open rule, no change without exceptions); `tenancy/test/profile.int.test.ts` (redundant dropped, non-holiday `open` and past days refused); `profile.int.test.ts` (the contract refuses the same) | faithful | green |
| AC-6 | AGT-09, UC-20 5b | `packages/agent/test/language-hours.int.test.ts` "holiday exceptions through the turn" (notice with the next opening, "closed today"/"今天休息", no label leaked, `system` identical before and after); eval `feat-009-holidays.json` (closure notice and price still cited; holiday marked open → no notice; holiday under the rule → notice) | faithful; the `open` case is shown in evals and unit tests because the visitor function windows exceptions around the database's real date | green |
| AC-7 | ONB-06 p, UC-03 3 | `profile.int.test.ts` "the F&B template" (suggestions; `added` after a FAQ with different case and spacing; none for retail; fact count rises only by the owner's FAQ); `tenancy/test/profile.int.test.ts` (ids, `questionKey`); `business-profile.e2e.ts` (Add answer prefills the question, Added badge after saving) | faithful | green |
| AC-8 | GOV-01, ADR-014, NFR-11 | `tenancy/test/profile.int.test.ts` and `profile.int.test.ts` (one `settings.profile_updated` per save, version and field codes, no phone, name, UEN, email or label) | faithful | green |
| AC-9 | GOV-03, ADR-005 | `rls.int.test.ts` "business profile and holidays (FEAT-009)" (forced RLS, B can't read, write or delete A's holidays or rename A; the dashboard can't update other tenant columns; the visitor role can't select `holidays`; the function returns only the current tenant's exceptions within ±15 days) | faithful | green |
| AC-10 | SCR-APP-044, SCR-APP-006 p, NFR-09, NFR-19 | `business-profile.e2e.ts` (load, validation and summary, hours editor, holiday rule and per-holiday choice, closures, toast, Cancel, conflict with Reload, Agent no-permission, setup mode; axe twice) | faithful; no component tests (as FEAT-024), states covered in E2E | green |
| AC-11 | UC-03 1–3, UC-20 5b | `business-profile.e2e.ts` "the owner sets a closure for today, answers a suggested question, and the widget says it is closed" | faithful | green |
| AC-12 | AGT-14 | `pnpm eval` 248 cases and `--fast` 137, every subset 1.000; a planted wrong expectation was reported FAIL | faithful | green |

## Fresh run (this verification)

format, lint and boundaries, typecheck, unit (22 tasks), unit + integration with coverage (15 tasks, thresholds met), build and size (loader 1.75 KB gz), E2E on Chromium (31 passed), evals full and fast, `pnpm audit --prod` — all green at `ab60179` (details in tasks.md T9).

## Test diff review

- `packages/db/test/rls.int.test.ts`: the FEAT-022 `visitor_tenant_state` exact-row assertion gains `holidays: {}` (the function's new column). Stricter, not looser.
- `packages/agent/src/compose.test.ts`: a hand-built `OpenStatus` gains `closedReason: null` (the type's new field). No assertion changed.
- `packages/agent/test/language-hours.int.test.ts`: the `ask` helper also records the reply requests' `system` strings. Existing assertions unchanged.
- `e2e/tests/auth.e2e.ts`: the sign-up test's expected `/setup` heading changes from the placeholder's "Set up your assistant" to the setup step's "Tell us about your business". The test still proves the new owner reaches setup.

No test was skipped, deleted or loosened; no eval threshold changed.

## Findings

- **Note 1 (owner, ONB-06 reading).** ONB-06 says templates "preload" suggested FAQs. They are offered on the profile screen with "Add answer", not written into the knowledge base, because a FAQ without the owner's answer would be an invented claim (D5, ADR-010). If you'd rather have them appear in the Review queue as drafts, that's a change to D5 for FEAT-013.
- **Note 2 (owner).** UEN is optional on the profile (D2). Whether it is required to go live is FEAT-035's readiness rule.

## RTM

- ONB-03: Test ref appended `features/FEAT-009-business-profile/acceptance-report.md`.
- ONB-06: Test ref appended `features/FEAT-009-business-profile/acceptance-report.md (partial)`.
