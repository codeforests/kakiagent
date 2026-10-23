# Acceptance Report: FEAT-016 — Spreadsheet import with column mapping and preview

> Verdict: **Accepted** (first verification; KB-03 gets its Test ref) · Date: 2026-10-23
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-11) · Sources: SRS v0.4 (KB-03; KB-11, KB-12, KB-15, KB-16 and KB-06 in the parts this feature extends to spreadsheets; NFR-16, NFR-17), use-cases v0.4 (UC-10 1–6, 2a, 4a, 5a; UC-03 6), ADR-005, ADR-008, ADR-010, ADR-018
> Repo state audited: `55f529e`

## Verdict summary

FEAT-016 is accepted. Every criterion from AC-1 to AC-11 has a test that asserts what the criterion says, and every suite was observed green in this run, from a reset local stack.

No test needed correcting. Two mutation checks turned the relevant tests red: dropping the `bad_stock` rule from `mapRows`, and adding the SKU to the prompt's product line.

There are no rework or design-defect findings. Three minor findings are recorded below; none blocks acceptance.

This verification ran in the same session as the implementation. Its standard was re-derived from KB-03, UC-10 and NFR-16 and from design §6, not from tasks.md. The dev servers the implementation had started were stopped, the local stack was reset (`docker compose down -v`) and migrated fresh, and the E2E suite started its own servers.

## Audit standard

- **KB-03 (M):** "Spreadsheet upload (CSV/XLSX) with column mapping to Product, Service, Price, Stock and SKU fields; mappings are auto-suggested." Acceptance: "A 500-row price list imports into structured records. The owner confirms or edits the mapping. Rows that fail validation are listed with the reason and are not imported. Confirming the import preview approves the imported rows (KB-16)."
  - Upload of both formats: AC-1. The five fields and the suggestion: AC-3. Confirm or edit: AC-4, AC-11.
  - Rejected rows listed with reasons and not imported: AC-4, AC-5. Confirming approves: AC-5.
  - 500 rows: AC-10. Faithful.
- **UC-10:** step 2 and 2a (scan, refuse unsafe, encrypted or non-spreadsheet files) → AC-2; 3 → AC-3; 4 and 4a (GST choice; held back when unknown at a registered business) → AC-4, AC-6; 5 → AC-4, AC-5; 5a (every row fails → failed with retry) → AC-8; 6 (conflict detection) → AC-7. Every path is represented.
- **NFR-16:** "a 500-row spreadsheet within 1 minute after mapping is confirmed" → AC-10, measured from the confirm. Faithful.
- **NFR-17 (retry)** → AC-8. **ADR-005 (isolation)** → AC-9. **ADR-008 (the model never writes protected values; D8 stock never quoted)** → AC-5's prompt clause.

One wording change in §6 during implementation was checked: AC-11's done figure went from "8 imported" to "6 rows imported · 4 not imported". The fixture has 6 importable rows (tasks.md implementation notes explain the empty row), so the change corrects a counting slip and doesn't narrow the criterion.

## Audit table

| AC | Tests | Faithful? |
|---|---|---|
| AC-1 | `apps/api/test/spreadsheets.int.test.ts` "a spreadsheet source" (201 at `scan`, audit without the name, one job; `.xls`, `.pdf` as a spreadsheet and `.csv` as a file refused; file limit counts spreadsheets); 403 in "isolation and roles" | Yes |
| AC-2 | `apps/ingest-worker/test/files.int.test.ts` "spreadsheet fixtures" (real S3 and ClamAV: EICAR as `prices.csv`, `protected.xlsx`, `legacy.xls`, `latin1.csv`); `sniff.test.ts` (a DOCX named `.xlsx`, an ELF, PNG and PDF named `.csv`, non-UTF-8; XLSX and CSV still refused as file sources) | Yes |
| AC-3 | `packages/kb/test/sheets.int.test.ts` "parses an XLSX to `map`…" (no pending job, header row 3, cells, suggestion and GST), "reads a CSV…", "fails no_rows…"; worker test on the committed fixtures; `xlsx.test.ts` hidden sheets | Yes |
| AC-4 | API "POST /:id/preview" (counts, reasons, samples, writes nothing; `bad_mapping` messages; `bad_request`; `invalid_state`); kb "previews the rows…" (unmapping stock changes the result); `rows.test.ts` per rule | Yes |
| AC-5 | kb "imports the confirmed rows as approved facts…" (approved, confidence 1, row provenance and quote, SKU, stock, `stockAsOf`, version row, chunk, `fact.approved { mode: 'import' }` by the confirmer, `visitor_facts`); API import test; `prompt.test.ts` SKU and stock never in the prompt | Yes |
| AC-6 | kb "holds back GST-unknown prices of a GST-registered business, not of others"; API preview `gstReview` | Yes |
| AC-7 | kb "writes a row that disagrees… conflicted…; drops one that agrees" (two rows of one product both conflicted), "counts rows the KB already has…" | Yes |
| AC-8 | kb "fails extraction_unavailable… retry keeps the mapping", "fails no_valid_rows… retry returns to the mapping", "ignores a stale or duplicate import job", "deletes a spreadsheet waiting at map…", no_rows not retryable; API no_valid_rows → retry → `map`, `version_conflict`, delete at `map` | Yes |
| AC-9 | `packages/db/test/rls.int.test.ts` spreadsheet case in every zone; API tenant B 404 on detail, preview and import | Yes |
| AC-10 | Timed run (below) | Yes |
| AC-11 | `e2e/tests/spreadsheets.e2e.ts` | Yes |

## Anti-fake-green review

The test diff from the FEAT-015 merge (`3d15ebe`) to `55f529e` adds 2,149 lines and removes 3. The three removed lines:

- `apps/api/test/uploads.int.test.ts`: the refused-names list swaps `menu.xlsx` for `menu.xls`, and the `unsupported_type` message names Excel and CSV. Both follow from design §3.2 (`.xlsx` becomes an upload) and are declared in the T9 commit and tasks.md. The case still asserts a refusal.
- `packages/agent/src/prompt.test.ts`: an import line gains `factLine` for the new test.

No skips, todos, widened tolerances or new mocks of the behaviour under test. The coverage configuration is unchanged over the range. One test was made faster rather than looser: the zip-bomb fixture is stored instead of deflated (the cap counts unzipped bytes either way), and it still fails `unreadable`.

## Independent execution

All on `55f529e`, after `docker compose down -v`, `stack:up` and `db:setup` (roles, migrations 0000–0024, dev tenants) on a fresh database:

- `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser: no violations), `pnpm typecheck`: pass.
- `pnpm test` (every unit suite): pass.
- `pnpm test:coverage` for kb, api, ingest-worker and dashboard at their thresholds: pass (kb 311, api 196, ingest-worker 54 tests); the earlier whole-repo coverage run passed every other package (db 97, agent 345, platform 266, governance 93 and the rest).
- `pnpm test:e2e --project=chromium`, servers started by Playwright: **38 passed**, none flaky, including `spreadsheets.e2e.ts` and FEAT-015's `files.e2e.ts`.

Firefox and WebKit aren't installed in this environment; CI runs all three engines.

## Direct verification

- **Audit trail (KB-16, GOV):** the kb test reads `audit_entries` directly: `kb_source.parsed { rows, columns }`, `kb_source.import_confirmed { rows, importable, rejected, gst }` and one `fact.approved { version: 1, mode: 'import', source }` per fact, by the confirming user, with no file name or cell text.
- **NFR-16, indicative:** three runs on the local stack (fake embeddings, one ingest worker) from the confirm on SCR-APP-025 to `ready` with 500 approved facts: 3.06 s, 3.02 s, 2.92 s. **Pending environment:** the same run with Cohere embeddings in AWS at MD (in scaffold-notes §5 and the project's pending actions).
- **Screens:** the mapping, preview and done states were inspected in Chromium at 1280 and 390 px. The manifest's SCR-APP-025 states render; the preview and rows tables stack on a phone; colours come from token variables (one new rule, `.alert--success`, uses `--color-success-soft`, design.md §4.3's success variant). axe found no serious violations on SCR-APP-007, SCR-APP-025 and SCR-APP-028.
- **Contracts:** the endpoints, bodies and error codes match §3.2. `toFact` now carries a product's `sku`, `stock` and `stockAsOf`, as §3.1 specifies.

## Findings

- **Minor (screen copy):** the mapping's help text says "Suggested from your sheet." where ui-design.md has two texts ("from the column name", "from its values"); the suggestion doesn't record which rule matched. Declared in tasks.md. Not blocking.
- **Minor (screen copy):** a role without `kb.manage` sees SCR-APP-024's shared permission state, not "Only the Owner or an Admin can import spreadsheets." Declared in tasks.md. Not blocking.
- **Minor (pending environment):** NFR-16's 500-row figure is from fake embeddings; re-measure at MD.

## RTM

Test ref appended for KB-03: `features/FEAT-016-spreadsheet-import/acceptance-report.md`. NFR-16 stays open until its re-measurement at MD and M6, as for FEAT-015.
