# Acceptance report: FEAT-050 — Leads list, pipeline, scoring and CSV export (verified)

> Feature: FEAT-050 · Implements: LED-03, LED-05 (partial), LED-08, LED-04 (partial), AUTH-03 (partial) · Also verified: LED-02 (display on the lead) · Realizes: UC-21 5, 6, 6a; UC-24 (leads CSV, D1) · Screens: SCR-APP-032, SCR-APP-033, SCR-APP-043 (qualification), SCR-APP-014 (score in the sidebar) · Verifier: independent verify session, 2026-11-06 · Branch: `feat/FEAT-050-leads-pipeline` · PR #56

## Verdict summary

**Accepted** (2026-11-06). Every criterion AC-1..AC-9 has a test that asserts what it says, re-run here. Two clauses had no test and now do (Corrected tests): AC-3's "quiet hours hold it" and "a reopen doesn't alert again", and AC-7's "above 10,000 rows → 413 and no audit entry". Full local checks are green apart from the container-only `uploads.int` (LocalStack), which CI runs. E2E (`leads.e2e.ts`, axe at 1280 and 375 × 5000) ran in GitHub CI (CI section).

## Audit standard

Re-derived from SRS v0.4: LED-03 (score hot/warm/cold from tenant-configurable criteria plus intent signals; score and reasons visible on the lead), LED-04 (hot-lead alert), LED-05 (leads list with the New → Contacted → Won / Lost pipeline; CSV export recorded in the audit log; withdrawn consent excluded, which is FEAT-051's per design §8), LED-08 (marketing flag and its time on the lead and the CSV; Do Not Call reminder in the export), AUTH-03 (export leads is a re-auth action), LED-02 (consent with time and wording, shown on the lead). UC-21 5, 6, 6a; UC-24 1, 2, 4 (step 3's background build replaced by a direct download, Ken's D1). ADR-005, ADR-008, ADR-012, ADR-014, ADR-015, ADR-025. Design §6 encodes these faithfully (§9 maps each); the partial clauses are named in §8. No misencodings found.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | LED-03 criteria + intent signals | leads `score.test` (each code, bands at 2/3/4/5, `parseBudget` EN/Singlish/ZH, word-boundary and CJK keywords); leads `pipeline.int` "wants_to_order and returning…", "rescores open leads only, audits the count…" (won lead keeps its score); api `leads-pipeline.int` qualification PUT returns `rescored`; E2E "saving a new keyword rescores an open lead" | Yes | Pass |
| AC-2 | LED-03 visible; UC-21 5 | leads `pipeline.int` "scores at once…" (sidebar `scoring`); api `leads.int` sidebar `scoring`; E2E lead page "Score: Hot · 7 points" and reasons in words, list chips | Yes | Pass (E2E in CI) |
| AC-3 | LED-04; UC-21 6, 6a | leads `pipeline.int` "a hot capture alerts every active member once, never again" (one per member, `hot_alerted_at`, second capture and criteria save add none; **added**: won → new adds none); **added** "the hot-lead alert is not urgent, so quiet hours hold it" (`sendDueNotifications` at 23:00 SGT → `held`, nothing sent) | Yes, after correction | Pass |
| AC-4 | LED-05 list and pipeline | leads `pipeline.int` keyset, filters, counts, contact-form lead; status compare-and-set, stale with the row, `open_lead_exists`, audit `lead.status_changed` from/to; api `leads-pipeline.int` Agent 403, Owner 200, stale 409 with the row; E2E tabs, counts, move to Contacted, Agent has no status menu | Yes | Pass |
| AC-5 | LED-05 export audited; AUTH-03 | api `leads-pipeline.int` Agent 403, stale re-auth 403 `reauth_required` with no audit, fresh 200 `text/csv` attachment `no-store`, one `lead.exported` `{ count, status }`; E2E export through the re-auth dialog and emailed link, Agent has no Export | Yes | Pass (E2E in CI) |
| AC-6 | LED-08 flag, time, DNC reminder | leads `export.test` BOM, reminder line, header, Yes/No/Not asked with SGT time; api first two lines; E2E downloaded CSV's reminder, header and Rachel's `,Yes,`; lead page "Yes · <date>" | Yes | Pass (E2E in CI) |
| AC-7 | CSV safety, cap | leads `export.test` formula prefixes, quotes/commas/newlines/Chinese round-trip through a parser; api `=HYPERLINK` prefixed; **added** api "above 10,000 rows is 413 too_many and writes no audit entry" | Yes, after correction | Pass |
| AC-8 | LED-02 on the lead | leads `pipeline.int` "the detail lists every consent with its exact wording and the conversations"; E2E consent card with wording text | Yes | Pass |
| AC-9 | GOV-03, ADR-005 | db `rls.int` FEAT-050 cases (visitor can set score columns, not `status`; dashboard can set `status`/`version`, not `need`/`contact_id`; half-set score refused; tenant B can't update tenant A's lead); leads `pipeline.int` tenant B sees none and gets `LeadNotFound`; api tenant B 404 on status, empty export | Yes | Pass |

## Changed existing tests (reviewed, not weakened)

- `apps/api/test/leads.int.test.ts` (+2 lines) asserts the sidebar's new `scoring`; `apps/dashboard/src/lib/inbox.test.ts` (+1) adds the new required field to a fixture; `rls.int.test.ts`, `identity.test.ts` only gain cases. The feature's test diff has no removed lines, no `.skip` or `.only`.

## Corrected tests

- `packages/leads/test/pipeline.int.test.ts` (commits `28b9af6`, `6b20d29`, "FEAT-050 acceptance: add tests for AC-3…"): the reopen check (won → new writes no further `hot_lead`) and a new case driving FEAT-052's sender at 23:00 SGT, which holds the non-urgent hot-lead alert.
- `apps/api/test/leads-pipeline.int.test.ts` (`28b9af6`): a new case with 10,001 leads: 413 `too_many`, no `lead.exported` entry; the filler rows are deleted after.

## Independent execution

Run here through `scripts/test-env.sh scripts/check-summary.sh`, 2026-11-06:

- `pnpm format:check`, `pnpm lint` (incl. dependency-cruiser and `check-rtm`), `pnpm typecheck`: PASS. `pnpm test`: PASS, 140 files, 1643 tests.
- `@kaki/leads` test 29, test:integration 19 (with the added cases), coverage: PASS. `@kaki/contracts` 75, `@kaki/identity` 42, `@kaki/dashboard` 241: PASS. `@kaki/db` test:integration 211 (RLS, seed twice): PASS.
- `@kaki/api` test:integration: 36 of 37 files (incl. `leads-pipeline.int`, `leads.int`); `uploads.int` fails here with "Could not find a working container runtime strategy" (LocalStack). CI runs it.
- E2E: in CI only (no Docker here).

## Direct verification

- Migration 0051: score columns with the all-or-none check, `version >= 1`, the list index; column-level `UPDATE` grants only (visitor: score columns and `hot_alerted_at`; dashboard: status, version, timestamps, score columns; `lead_settings.qualification`); no delete granted; no new table, so `TENANT_SCOPED_TABLES` is unchanged.
- Export route: capability → `requireReauth` → one dashboard transaction that reads, audits and returns the body; `TooManyLeads` is thrown before the audit; the CSV is never stored (ADR-015). Audit payloads carry IDs, codes and counts (leads `pipeline.int` "no audit entry carries a name, email, phone or need").
- Scoring is pure code (`score.ts`); no model call in this feature (ADR-008, ADR-025). The alert is written with `notify` in the capture's transaction (ADR-012). The tenant comes only from the session or widget token.

## Findings

- None blocking. F1 (test only, fixed): AC-3's quiet-hours and reopen clauses and AC-7's cap had no test (Corrected tests).
- F2 (pre-existing test defect, fixed, `5df1f26`): `approval-link.e2e` depended on the time of day: FEAT-052 holds non-urgent alerts from 22:00 to 08:00 SGT. The spec now sets the owner's alert settings with quiet hours off and restores the seeded default after, as `escalation.e2e` does. No assertion changed.
- Note: GOV-03's Test ref is left as it is, as earlier features did; AC-9 is recorded here.

## RTM

Test ref appended 2026-11-06: LED-03, LED-04 (partial), LED-05 (partial), LED-08, AUTH-03 (partial), LED-02 (partial). `node scripts/check-rtm.mjs FEAT-050 --stage verify`: `RTM check passed (FEAT-050).`

## CI

GitHub CI run 113 (`workflow_dispatch`, https://github.com/codeforests/kakiagent/actions/runs/42239375588) at `5df1f26`: all 11 jobs green on attempt 2, including E2E on Chromium, Firefox and WebKit (`leads.e2e` 3 tests per browser; WebKit 86 passed) and integration with coverage (`uploads.int`). Attempt 1's WebKit job hit the 30-minute job timeout while installing browsers, before any test ran. Earlier: run 112 at `6b20d29` (cancelled for the fix below): `leads.e2e` passed on WebKit, but `approval-link.e2e` (FEAT-056) failed because it ran at 22:53 SGT, inside the owner's default quiet hours, so the non-urgent `approval_pending` email it waits for was held (F2).
