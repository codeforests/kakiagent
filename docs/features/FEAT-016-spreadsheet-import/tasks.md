# Tasks: FEAT-016 — Spreadsheet import with column mapping and preview

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: pending · Last updated: 2026-10-23

- [x] T1 — Schema: `kb_sources` kind `spreadsheet`, stages `map`/`import`, failures `no_rows`/`no_valid_rows`, file types `xlsx`/`csv` with `kb_sources_sheet_type_ck`, the widened `kb_sources_file_ck`, `sheet` and `mapping` with `kb_sources_mapping_ck`; `kb_source_pages.cells` and the row reasons (drizzle schema + `0024`); RLS suite case for spreadsheet sources and rows (design §4; AC-9 schema half)
      Done when: `pnpm db:setup` applies 0024 on a database at 0023 and is idempotent; `drizzle-kit generate` reports no drift; the RLS suite passes with the spreadsheet case.
- [x] T2 — Contracts: §3.1 shapes, `UPLOAD_EXTENSIONS`/`SHEET_EXTENSIONS`, the spreadsheet body, `ImportBody`, `ConfirmImportBody`, `ImportPreview`, the product value's `sku`/`stock`/`stockAsOf`, `FileLocation` unit `row`, `IngestJob` stage `import` (design §3.1, §5.9)
      Done when: typecheck passes across the workspace with the new enum values handled (dashboard records included).
- [x] T3 — Sheet readers: `csv.ts`, `xlsx.ts`, `table.ts` (design §5.3 steps 2–4; D2, D9, D10)
      Done when: unit tests pass for quoted fields with commas, `""` and line breaks, BOM, CRLF, delimiter choice; shared strings, rich text, inline strings, booleans, errors, cached formula values, float noise, sparse cell references, the first visible sheet, the unzip cap and malformed XML as `unreadable`; header detection below a title row, "Column C" for an empty header, the row and column limits, cell cut at 1,000 chars.
- [x] T4 — Mapping logic: `money.ts`, `suggest.ts`, `rows.ts` (`mapRows`, `checkMapping`) (design §5.4, §5.5; D7; AC-3 and AC-4 logic)
      Done when: unit tests pass for every rule of §5.5 in order, every accepted and refused price form, stock forms, the suggestion table (EN and 中文 headers, "cost" refused, content fallback for price and name, GST from the header) and every `bad_mapping` message.
- [x] T5 — Scan and parse stages: `sniffType` by kind, `parseSheetSource`, the job's `parse` branch and `map` wait with no job, the `import` stage and its staging, `promoteSource`'s spreadsheet rules (approved, confirmer, per-fact audit, `source 'spreadsheet'`), retry and delete rules, `countFileSources` (design §5.2, §5.3, §5.7, §5.8; D1, D3, D5, D6; AC-2, AC-3, AC-5, AC-7, AC-8 pipeline halves)
      Done when: sniff unit tests pass for xlsx, csv, encrypted and legacy containers, and kind mismatches; kb integration tests with the in-memory file store pass: an XLSX and a CSV parse to `map` with rows, cells, layout and suggestion; a header-only sheet fails `no_rows`; an import job writes row results and staging, then promote writes approved facts with versions, chunks, provenance and audit; a conflicting row is `conflicted` and the live fact flagged; a duplicate row is dropped; embeddings failing then retry with the kept mapping ends `ready`; `no_valid_rows` retry returns to `map` without the mapping; `no_rows` isn't retryable; a stale import job changes nothing; delete purges.
- [ ] T6 — kb dashboard functions: `previewImport`, `confirmImport`, the fact update keeping `sku`/`stock`/`stockAsOf` (design §5.6; D4, D8; AC-4, AC-6, AC-8 confirm half)
      Done when: kb integration tests pass: the preview's counts, samples, rejects, `existing`, `conflicts` and `gstReview` (GST-registered and not); nothing written by preview; confirm stores the mapping with an audit entry and one outbox job; confirm with no importable row fails `no_valid_rows`; wrong state and stale version refused; editing an imported product keeps its SKU and stock.
- [ ] T7 — Fixtures: `generate.ts` gains the §5.10 files; committed (design §5.10)
      Done when: `pnpm --filter @kaki/ingest-worker fixtures:files` regenerates every file and the committed files match what T3–T5 and T8 tests expect.
- [ ] T8 — Worker wiring: `SHEET_ROW_LIMIT` config and `.env.example`, logs; integration test running the real fixtures through scan (ClamAV) and parse (design §5.9; AC-2, AC-3)
      Done when: ingest-worker integration tests pass: `price-list.xlsx` and `services.csv` scan clean and parse to their expected layout; `protected.xlsx`, `legacy.xls` and `latin1.csv` are refused with their reasons; EICAR as `prices.csv` fails `malware`.
- [ ] T9 — API: the spreadsheet body of `POST /kb/sources`, `POST /:id/preview`, `POST /:id/import`, `bad_mapping`, `toSource` with `sheet`, pages with `cells`, the extension lists (design §3.2; AC-1, AC-4, AC-6, AC-8, AC-9)
      Done when: api integration tests pass for every designed success and error, including tenant B's 404 on tenant A's source.
- [ ] T10 — Dashboard: spreadsheets on SCR-APP-007 (the files part takes `.csv`/`.xlsx`), spreadsheet rows on SCR-APP-023, SCR-APP-025 at `/knowledge/sources/:id` for a spreadsheet (mapping, preview, importing, done with rejects, failed), row provenance with SKU and stock on SCR-APP-028 (ui-design.md)
      Done when: `pnpm --filter @kaki/dashboard build` passes and every state in ui-design.md renders against the running stack at 1280 px and 390 px.
- [ ] T11 — NFR-16 timing: `price-list-500.csv` from confirm to `ready` on the local stack (AC-10)
      Done when: the measured time is under 1 minute and recorded below.
- [ ] T12 — E2E: `e2e/tests/spreadsheets.e2e.ts`: upload `price-list.xlsx`, map with the suggestion, see rejects with reasons, change a column, choose GST, import, done state, a fact's "From row … of price-list.xlsx" with SKU and stock, axe on SCR-APP-025 (AC-11; UC-10)
      Done when: the spec passes in Chromium against the local stack with `pnpm test:e2e --project=chromium`.
- [ ] T13 — Verify: every AC in design §6 demonstrated; format, lint, boundaries, typecheck, unit, integration, coverage and E2E green; scaffold notes updated (design §6)
      Done when: the evidence for each AC is recorded at the end of this file and every command above is green.

## Implementation notes

## Acceptance evidence (T13)
