# Acceptance Report: FEAT-058 — Privacy notice and template, consent wording, data-processing documents

> Verdict: **Accepted** (E2E `privacy.e2e.ts` and axe green in Ken's local CI at `cbea038`, 2026-10-27) · Date: 2026-10-27
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-10) · Sources: SRS v0.4 (GOV-14, GOV-07, GOV-11, LED-02 (p), ONB-09), use-cases v0.4 (UC-03 steps 8, 10a), ADR-005, ADR-006, ADR-014, ADR-019
> Repo state audited: `9948934` (implementation head); one test strengthened in `a998c4c`

## Verdict summary

FEAT-058 is accepted. Each of AC-1..AC-10 has tests that assert what the criterion says, and the criteria encode GOV-14 (link or filled template, versioned wordings), GOV-07 (in-app documentation, downloadable DPA and data-flow PDF), GOV-11 (each transfer with location, purpose and safeguard; nothing at rest outside Singapore) and LED-02's wording half faithfully. Out of scope by design and not claimed: GOV-07's 30-day sub-processor notice (FEAT-073), LED-02's consent recording (FEAT-049), ONB-09's go-live block (FEAT-035 calls `privacyReadiness`).

The test diff adds files and cases only (RLS suite: additions only); nothing loosened, skipped or deleted.

## Audit standard

GOV-14 (M): widget links to the notice; a fillable template; consent and notice wordings versioned; acceptance: no go-live without a link or completed template (ONB-09). GOV-07 (M): data flows, complete sub-processor list, zero-retention terms, locations; DPA and data-flow PDF. GOV-11 (M): each transfer with location, purpose, safeguard; data-flow PDF shows each; nothing stored at rest outside Singapore. LED-02 (M, partial): the purpose statement and "the wording used". Design §9's trace was checked against these rows.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 link save, https only, config URL, widget link | GOV-14 | api `privacy.int.test.ts` "saves a link", "rejects http and javascript:"; contracts `privacy.test.ts`; dashboard `validateNotice`; FEAT-033 panel tests; E2E test 1 | Yes | Green (E2E pending CI) |
| AC-2 template, hosted page content, escaping, CSP, noindex, 404s | GOV-14, GOV-11 | api hosted-page and 404 cases; governance `notice-template.test.ts` (order, UEN set/omitted, purpose, transfers, SGT date, escaping, one h1) | Yes, after correction (below) | Green |
| AC-3 immutable numbered wordings, no-op on identical, both languages | GOV-14, LED-02 | governance `privacy.int.test.ts` numbering, purpose content; db RLS cases (UPDATE/DELETE denied) | Yes | Green |
| AC-4 stale version 409, no wording; audit payload version/seq/mode only | ADR-014 | governance conflict and audit cases; api 409 case | Yes | Green |
| AC-5 readiness needs explicit save | ONB-09, UC-03 10a, D6 | governance "readiness needs an explicit save of each"; api GET defaults | Yes | Green |
| AC-6 sub-processors and transfers listed, non-SG location ⇒ transfer row | GOV-07, GOV-11 | governance `registry.test.ts`; api GET `documents`; E2E test 3 | Yes | Green (page render pending CI) |
| AC-7 PDFs: `%PDF-`, names and destinations in text, byte-identical, 404, 403 | GOV-07, GOV-11 | governance `documents.test.ts` (pdfjs text extraction, two calls equal); api PDF, unknown doc, Agent 403 | Yes | Green |
| AC-8 tenant isolation | ADR-005 | db `rls.int.test.ts` two cases + composite FK; governance visitor-zone case; api tenant-B case | Yes | Green |
| AC-9 page and setup-step states, renumbered flow, terms read-only | SCR-APP-047, SCR-APP-009, UC-03 8 | dashboard `privacy.test.ts` (14); E2E tests 1, 2, 4, 5; builder's stubbed Chromium renders | Yes | Unit green; E2E pending CI |
| AC-10 validation convention, keyboard, axe | WCAG 2.1 AA | E2E axe (tests 1, 5); code review of error summary focus | Yes | Pending CI |

## Corrected tests

- AC-2: the api hosted-page case checked the contact, escaping, transfers and date but not the business name or the purpose statement the criterion names on the served page (they were covered only by the unit test of `noticeSections`). Added both assertions against the real route (`a998c4c`).

## Independent execution

All in this session through `scripts/test-env.sh` (no Docker):
- `pnpm format:check`, `pnpm lint` (ESLint + depcruise, 0 violations), `pnpm typecheck` (26/26), `pnpm test` (24/24): green.
- Unit: `@kaki/governance` 84/84, `@kaki/contracts` 9/9, `@kaki/dashboard` 79/79.
- `test:coverage`: `@kaki/db` 133/133; `@kaki/governance` 107 passed, `anchors.int.test.ts` can't start (LocalStack needs Docker); `@kaki/api` 263 passed, `uploads.int.test.ts` S3 presigner can't start (same cause; fails on `main` the same way). No threshold failures. Dashboard and contracts have no coverage script.
- api `privacy.int.test.ts` 9/9 after the correction.

## Direct verification

- Migration `0033_privacy.sql`: forced RLS and policy on both tables, both in `TENANT_SCOPED_TABLES`; `app_dashboard` has SELECT/INSERT only on `wording_versions`; `visitor_privacy()` is SECURITY DEFINER, owner `kaki_tenant_state`, `search_path` pinned, EXECUTE revoked from PUBLIC and granted to `app_agent_visitor` only.
- Tenant ID comes from the session (dashboard routes) or the resolved widget key (public notice, config); never the body.
- Audit payload uses `auditCode(mode)`, no URL, names or text (ADR-014). Hosted notice sends CSP `default-src 'none'`, `x-robots-tag: noindex`, `nosniff`, and no CORS header.
- Dashboard CSS additions use `var(--…)` tokens only.

## Findings

- Observation (not blocking): two concurrent saves of the same kind at the same `version` both compute the same next `seq`; the second hits the `(tenant_id, kind, seq)` unique index and returns 500 instead of 409. No data is wrong. Mapping that unique violation to `PrivacyConflictError` would fix it; worth doing when FEAT-049 adds the consent writes.
- Observation: GOV-07 names OCR in the sub-processor list; per ADR-019 OCR is self-hosted Tesseract in Singapore, so it is correctly absent as a sub-processor, but neither the page nor the PDFs say so. A one-line "Done in-house in Singapore: OCR" note would answer the question before a reviewer asks; fits FEAT-073's published list.

## Rework after Ken's local CI (2026-10-27)

Ken's local CI failed `privacy.e2e.ts` test 1 in all three browsers: the hosted notice had no `mailto:` link for the contact email. The E2E was right and the code was wrong: ui-design ("Hosted privacy notice") asks for the contact email as a `mailto:` link, `h1` "Privacy notice" with the business and UEN under it, `<title>` "Privacy notice · {business}" and the footer "Hosted by KakiAgent for {business}."; the build rendered "{name}, {email}" as plain text and none of the others. This audit missed it because the unit and api tests asserted the plain-text form. Fixed in `notice-template.ts` (a `{ mailto }` paragraph, `heading`, `subtitle`, `footer`; link and focus colours from tokens), with the unit test asserting the ui-design output and exactly one link, and the api test asserting the rendered `mailto:` anchor. Governance unit 85/85, api `privacy.int.test.ts` 9/9, lint, typecheck and format green. E2E to re-run in Ken's local CI.

## RTM

Test ref appended: GOV-14 (partial: go-live block with FEAT-035), GOV-07 (partial: 30-day notice with FEAT-073), GOV-11, LED-02 (partial: purpose and wording versions; consent record with FEAT-049).

## CI

The lockfile changed (pdf-lib, pdfjs-dist in governance), so Ken's local CI is due before merge (STATE.md cadence). E2E `privacy.e2e.ts` (5 tests) and its axe checks are judged from that run; a red result goes back to a build fix before merge.

Ken's local CI (WSL) at `cbea038`, 2026-10-27: passed (E2E incl. `privacy.e2e.ts` in Chromium, Firefox and WebKit). Merged on Ken's go.
