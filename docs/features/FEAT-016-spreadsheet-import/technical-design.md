# Technical Design: FEAT-016 — Spreadsheet import with column mapping and preview

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) and §5 (M2, after FEAT-015) · Epic: E2 Knowledge base
> Implements: KB-03 · Also serves: KB-11 (spreadsheets take FEAT-015's safety path), KB-12 (p: spreadsheet sources), KB-15 (p: the import's GST choice), KB-16 (confirming the preview approves the rows, D11), KB-06 (p: imported rows join conflict detection, UC-10 step 6), KB-07 (p: delete a spreadsheet and its facts) · Binding NFRs: NFR-16 (a 500-row spreadsheet within 1 minute after the mapping is confirmed), NFR-06, NFR-07, NFR-11, NFR-17, NFR-19, NFR-09
> Realizes: UC-10 (all steps, alternate 4a, exceptions 2a and 5a); UC-03 step 6 (spreadsheets)
> Screens: SCR-APP-025 (new), SCR-APP-007 and SCR-APP-023 (p: spreadsheet rows), SCR-APP-028 (p: a row's provenance, SKU and stock), designed in [ui-design.md](ui-design.md)
> Status: Verified (self-check §9) · Date: 2026-10-23

## 1. Intent

Many SMEs keep their prices in Excel or a CSV export from their POS. FEAT-016 lets the owner upload that sheet, map its columns to product or service name, price, unit, SKU and stock (the mapping is suggested), see a preview with every row that can't be imported and why, and confirm. Confirming the preview approves the imported rows (KB-03, D11), so they reach visitors without a second review, except prices whose GST treatment the owner left unknown at a GST-registered business (KB-15, UC-10 4a). Imported rows are checked against the KB like any other source's facts (KB-06, UC-10 step 6). The path is deterministic: no model reads the sheet (ADR-018 d5). It follows FEAT-015 because it reuses the upload, quarantine and malware scan that feature built.

## 2. Codebase context

Surveyed on `main` at `3d15ebe` (after FEAT-015, PR #21).

- **Schema:** migrations 0000–0023. `kb_sources` has kinds `website` and `file`, stages `scan`, `parse`, `crawl`, `extract`, `promote`, the file columns (`upload_key`, `file_key`, `file_size`, `file_type`, `scanned_at`, `ocr_pages`) and `kb_sources_file_ck`. `kb_source_pages` keeps a file's pages with locators (`page/3`) as `url`. `kb_staged_facts` holds findings between extract and promote. `facts.value` for a product is `{ name, priceCents, currency: 'SGD', unit? }`; `gst_treatment` is required for products; the `visitor_facts` view (0003) already leaves out `unknown` GST products at a GST-registered tenant (KB-15).
- **Upload and safety path (FEAT-015):** `POST /api/v1/kb/uploads` presigns a PUT to `uploads/<tenant>/<uploadId>` (extension list `FILE_EXTENSIONS`); `POST /api/v1/kb/sources { kind: 'file' }` creates the source at stage `scan`; `scanFile` checks size, malware, `sniffType` (bytes decide; XLSX is refused as `unsupported_type` today), and copies a clean file to `files/<tenant>/<source>` in the `sources` bucket. Purge on delete, retry rules (`NOT_RETRYABLE`, `retryable()`), the file limit (`FILE_LIMIT`, `countFileSources`).
- **Pipeline:** `runIngestJob` (`packages/kb/src/ingest/job.ts`) switches on stage; `next()` moves stage and enqueues in one transaction; `fail()` clears staging. `promoteSource` plans staged findings with `planPromotion` (FEAT-014), embeds new facts (`EMBED_BATCH` 96) and writes them, their versions and chunks in one transaction with `needs_review` or `conflicted`.
- **Facts API:** `apps/api/src/facts.ts` builds a product's stored value from `ProductValueInput` (`name`, `price`, `unit`) and replaces the value on edit.
- **Agent:** `packages/agent/src/prompt.ts` gives the model only a product's name, unit and price; nothing else in `value` reaches a prompt. So SKU and stock stored on a fact are never quoted (architecture Q6, OI-2).
- **Dashboard:** `pages/add-files.tsx` (`AddFilesForm`, SCR-APP-007's files part), `pages/sources.tsx` (SCR-APP-023), `pages/source.tsx` (SCR-APP-024), `lib/sources.ts` (labels, polling).
- **Divergence (reality wins):** ADR-018 d3 names SheetJS for XLSX and CSV. The npm release of SheetJS (`xlsx` 0.18.5) is the last one published to npm and carries unfixed advisories (prototype pollution, ReDoS); fixed builds are only on the vendor's CDN, outside the pinned-registry rule. FEAT-015 already reads DOCX and PPTX XML through `fflate`, so XLSX is read the same way (§7 D2).

## 3. API contracts

Shapes live in `packages/contracts` ("knowledge sources" section, extended). Auth (session), capability `kb.manage`, tenant from the session, `{ error, message }` and the `version` precondition as in FEAT-012 §3.

### 3.1 Shapes

```ts
SourceKind   += 'spreadsheet'
SourceStage  += 'map'      // waiting for the owner's mapping: status 'queued', no job (D3)
              | 'import'   // the confirmed mapping applied to the rows
SourceFailure += 'no_rows'        // a header but no data rows, or no header at all
               | 'no_valid_rows'  // every row failed validation (UC-10 5a)
FileType     += 'xlsx' | 'csv'
PageReason   += 'empty_row'                                  // excluded: nothing in the mapped columns
              | 'no_name' | 'no_price' | 'bad_price' | 'not_sgd' | 'bad_stock' | 'too_long'  // failed: rejected rows
              // 'duplicate' (FEAT-012) is reused: the same row earlier in the sheet
FileLocation.unit += 'row'      // provenance of an imported row: { unit: 'row', number: 12 } (the sheet's row number)
SourcePage   += { cells: string[] | null }                   // a spreadsheet row's cells (masked); null otherwise

SheetField    = 'product' | 'service' | 'price' | 'unit' | 'sku' | 'stock'
ColumnMapping = Partial<Record<SheetField, int>>             // column index, 0-based; each column used once
SheetGst      = 'inclusive' | 'exclusive' | 'unknown'
Source += {
  sheet: {
    name: string | null,          // the worksheet's name (XLSX), null for CSV
    headerRow: int,               // 1-based row number of the header
    rows: int,                    // data rows read (≤ SHEET_ROW_LIMIT)
    rowsSkipped: int,             // data rows after the limit, not read
    columns: { index: int, header: string, samples: string[] }[],   // ≤ 3 samples, masked
    suggested: { columns: ColumnMapping, gst: SheetGst | null },
    mapping: { columns: ColumnMapping, gst: SheetGst, confirmedAt: string } | null,
  } | null                        // null for websites and files, and for a spreadsheet before its parse
}
Fact (product).value += { sku?: string, stock?: int, stockAsOf?: SgDate }   // imported only; read-only in the UI (D8)

ImportBody    = { mapping: ColumnMapping, gst: SheetGst }    // preview
ConfirmBody   = ImportBody & { version: int }                // import
PreviewRow    = { row: int, cells: string[], reason: PageReason | null,
                  fact: { name, price: Money, unit: string | null, sku: string | null, stock: int | null } | null,
                  conflict: boolean }                         // conflict: disagrees with a fact or another row
ImportPreview = {
  rows: int, importable: int, rejected: int, empty: int, duplicates: int,
  existing: int,      // rows the KB already has with the same value (dropped, FEAT-014 D3)
  conflicts: int,     // importable rows that will be written `conflicted` (KB-06)
  gstReview: int,     // importable rows held back from visitors for GST review (KB-15, UC-10 4a)
  sample: PreviewRow[],    // the first 20 importable rows
  rejects: PreviewRow[],   // every rejected row (status failed), up to 500
}
```

`SHEET_FIELD`s: `product` and `service` both name the fact (a product fact is KB-05's Product/Service entity); a row takes the product cell, or the service cell when that is empty. `price` and one of `product`/`service` are required.

### 3.2 Endpoints

| Method, path | Request | Success | Errors |
|---|---|---|---|
| `POST /api/v1/kb/uploads` | unchanged body; the extension list becomes files' plus `.csv`, `.xlsx` (`UPLOAD_EXTENSIONS`) | unchanged | unchanged |
| `POST /api/v1/kb/sources` | gains `{ kind: 'spreadsheet', uploadId, fileName, sizeBytes }` (the file body with another kind) | 201 `{ source }`: `queued` at `scan`; audit `kb_source.created { kind: 'spreadsheet', ext, sizeBytes }`; outbox `ingest` job | 400 `unsupported_type` (not `.csv` or `.xlsx`; UC-10 2a); 400 `file_too_large`; 409 `source_exists`; 409 `file_limit_reached` (spreadsheets count as files, UC-10 precondition); 401, 403 |
| `GET /api/v1/kb/sources`, `GET /:id` | — | a spreadsheet carries `file` and `sheet`; its pages are its rows, with `cells`, in row order | unchanged |
| `POST /api/v1/kb/sources/:id/preview` (new) | `ImportBody` | 200 `ImportPreview`, computed from the stored rows and the tenant's current facts; writes nothing | 400 `bad_request`; 400 `bad_mapping` (no name or price column, an index out of range, one column for two fields; message names the problem); 404; 409 `invalid_state` (not waiting at `map`); 401, 403 |
| `POST /api/v1/kb/sources/:id/import` (new) | `ConfirmBody` | 200 `{ source }`. With importable rows: the mapping stored, `queued` at stage `import`, one outbox job, audit `kb_source.import_confirmed { rows, importable, rejected, gst }`. With none: `failed: no_valid_rows` (UC-10 5a), audit the same with `importable: 0` | as preview, plus 409 `version_conflict` |
| `POST /api/v1/kb/sources/:id/retry` | `{ version }` | a spreadsheet restarts at `parse` with its stored file; after `no_valid_rows` the mapping is cleared, so it comes back to `map` (D6) | `not_retryable` for the safety failures as for files, and for `no_rows` |
| `DELETE /api/v1/kb/sources/:id` | `version` | 204; facts, rows and (purge job) the stored file, as for files; a source waiting at `map` can be deleted | unchanged |
| `PATCH /api/v1/kb/facts/:id` | unchanged | a product's `sku`, `stock` and `stockAsOf` are kept when its name, price or unit is edited (D8) | unchanged |

The preview is a `POST` because its input is a body; it is safe and idempotent. The confirm re-runs the same validation over the same stored rows, so what is imported is what the preview showed, except for `existing` and `conflicts`, which the promote stage decides under its lock against the KB as it is then (FEAT-014 D9).

## 4. Schema changes

Migration `0024_spreadsheet_sources` (drizzle-kit DDL from `schema.ts`), against 0000–0023. No grants change: `app_dashboard` already has DML on `kb_sources` and SELECT on `kb_source_pages`; `app_ingest` has UPDATE on `kb_sources`, DML on pages and staging, INSERT on facts, versions and chunks.

| Change | Conceptual entity | Definition |
|---|---|---|
| `kb_sources.kind` | KB_SOURCE (ADR-018 d1: spreadsheets are sources) | check gains `'spreadsheet'` |
| `kb_sources.stage` | KB_SOURCE | check gains `map`, `import` |
| `kb_sources.failure` | KB_SOURCE | check gains `no_rows`, `no_valid_rows` |
| `kb_sources.file_type` | KB_SOURCE | check gains `xlsx`, `csv`; new check `kb_sources_sheet_type_ck`: `file_type is null or (kind = 'spreadsheet') = (file_type in ('xlsx', 'csv'))` |
| `kb_sources_file_ck` | KB_SOURCE | becomes `kind not in ('file', 'spreadsheet') or (upload_key is not null and file_size > 0)` |
| `kb_sources.sheet jsonb null` | KB_SOURCE (its parsed layout) | written by the parse stage: `{ name, headerRow, rows, rowsSkipped, columns: [{ header, samples }], suggested: { columns, gst } }` |
| `kb_sources.mapping jsonb null` | KB_SOURCE (the owner's confirmation) | written by the confirm: `{ columns, gst, confirmedBy, confirmedAt }`; check `kb_sources_mapping_ck`: `mapping is null or kind = 'spreadsheet'` |
| `kb_source_pages.cells text[] null` | KB_SOURCE (its rows) | a row's cells, masked with `piiMask`, each ≤ 1,000 chars; check `cardinality(cells) <= 50` |
| `kb_source_pages.reason` | KB_SOURCE | check gains the seven row reasons of §3.1 |
| `facts.value` | FACT | products may carry `sku` (≤ 64 chars), `stock` (integer ≥ 0) and `stockAsOf` (`YYYY-MM-DD`); jsonb, no DDL. `facts.source` takes `'spreadsheet'` |
| RLS | ADR-005 | no new table; `rls.int.test.ts` gains a spreadsheet case (tenant B can't see tenant A's spreadsheet source or its rows) |

A row is a `kb_source_pages` row (D1): `url` = `row/<n>` (the sheet's 1-based row number), `title` null, `status` `included` after the parse, `content` = the row's cells joined with ` | ` (masked, the provenance passage), `cells` the cells. Rows after `SHEET_ROW_LIMIT` aren't stored; they are counted in `pages_skipped` and `sheet.rowsSkipped`. Rollback is forward-only, as in earlier migrations.

## 5. Component design

```mermaid
sequenceDiagram
    autonumber
    actor O as "Owner"
    participant API as "api"
    participant DB as "Postgres"
    participant IW as "ingest-worker"
    O->>API: "presign, PUT, POST /kb/sources {kind: spreadsheet}"
    API->>DB: "tx: kb_sources(queued, scan) + audit + outbox"
    IW->>IW: "scan stage (FEAT-015): malware, sniff xlsx or csv"
    IW->>IW: "parse stage: read the sheet, find the header, suggest a mapping"
    IW->>DB: "tx: rows as pages, sheet layout, stage map (no job)"
    O->>API: "GET /kb/sources/:id (columns, samples, suggestion)"
    O->>API: "POST /:id/preview {mapping, gst}"
    API-->>O: "importable, rejected with reasons, conflicts, GST review"
    O->>API: "POST /:id/import {version, mapping, gst}"
    API->>DB: "tx: mapping, stage import + audit + outbox"
    IW->>DB: "import stage: row results on pages, staged facts; stage promote"
    IW->>DB: "promote (FEAT-012/014): embed, write approved or conflicted facts"
```

### 5.1 Where the code lives

- `packages/kb/src/ingest/sheets/` (pure, unit-tested): `csv.ts` (RFC 4180 reader), `xlsx.ts` (workbook reader over `fflate`), `table.ts` (header detection, column layout, samples), `suggest.ts` (the suggested mapping), `rows.ts` (`mapRows`: validation and the fact each row becomes), `money.ts` (price and stock parsing).
- `packages/kb/src/ingest/sheets/parse-stage.ts` and `import-stage.ts`: the two stages' database work.
- `packages/kb/src/sheets.ts` (dashboard scope): `previewImport`, `confirmImport`.
- `apps/api/src/sources.ts`: the two new routes and the spreadsheet body; `toSource` maps `sheet`.

### 5.2 Scan stage for spreadsheets (KB-11)

`scanFile` is unchanged except that `sniffType(bytes, name, kind)` takes the source's kind:

- `spreadsheet`: a ZIP whose entries include `xl/workbook.xml` → `xlsx`; an encrypted ZIP entry → `encrypted`; an OLE container named `.xlsx` → `encrypted` (Office's protected workbook), `.xls` → `unsupported_type` (legacy Excel); a `.csv` name whose bytes are strict UTF-8 without NUL → `csv`; executables and anything else → `unsupported_type`. A PDF, DOCX or image uploaded as a spreadsheet is `unsupported_type`.
- `file`: unchanged (XLSX stays `unsupported_type` there, FEAT-015 AC-3).

The malware scan, quarantine deletion, copy to `sources` and audit are FEAT-015's.

### 5.3 Parse stage (KB-03)

`parseSheetSource(zdb, source, files)` for `kind = 'spreadsheet'` (the job's `parse` case branches on kind):

1. Read the clean file from `sources`.
2. **CSV** (`csv.ts`): UTF-8 (BOM dropped). Delimiter: whichever of `,` `;` tab occurs most in the first line outside quotes (comma on a tie). Quoted fields with `""` escapes and line breaks inside quotes; CRLF or LF. A file that isn't strict UTF-8 never gets here (the scan refused it).
3. **XLSX** (`xlsx.ts`): entries decompressed through `unzipSync` with the 100 MB cap (FEAT-015 §5.4) → `unreadable` when over. `xl/workbook.xml` lists sheets; the first sheet that isn't hidden and has a cell is read (`xl/_rels/workbook.xml.rels` gives its part). Cells: `t="s"` shared strings (`xl/sharedStrings.xml`, rich-text runs joined), `t="inlineStr"`, `t="str"` (a formula's cached text), `t="b"` (`TRUE`/`FALSE`), numbers (the stored value, written without float noise: `Number(v)` to at most 10 significant decimals), `t="e"` → empty. Cell references (`B12`) place each cell; a missing `r` follows the previous cell. Formulas are never evaluated; their cached value is used. Dates are left as their serial number (no mapped field is a date). Malformed XML → `unreadable`.
4. **Table** (`table.ts`): trailing empty rows and columns dropped; at most `SHEET_COLUMN_LIMIT` (50) columns. The header is the first row among the first 10 with at least two non-empty cells of which at least half aren't numbers or prices; failing that, the first non-empty row. Headers are trimmed; an empty header is "Column C" (its letter). Data rows are those after the header, at most `SHEET_ROW_LIMIT` (default 2,000; config); later ones are counted, not stored. No header or no data row → `failed: no_rows`. Each cell is cut at 1,000 chars and masked (`piiMask`, ADR-015), as page content is.
5. **Suggestion** (`suggest.ts`, §5.4).
6. One transaction (stale check as FEAT-015's parse): the attempt's old pages removed; one page per data row (`row/<n>`, `included`, `content`, `cells`, `content_hash`); `sheet`; `pages_found` = rows stored, `pages_included` = rows stored, `pages_skipped` = rows after the limit. Then, through `next()`'s transaction: if `mapping` is set (a retry after a transient failure, D6) the stage becomes `import` with its job; otherwise the stage becomes `map` and the status goes back to `queued` with **no job** (D3). Audit `kb_source.parsed { rows, columns }`.

### 5.4 Suggested mapping

Each column's header, lower-cased with punctuation and spaces collapsed, is matched against keyword lists in order; each field takes the first unused column that matches, and a column takes one field:

| Field | Header words (EN, 中文) |
|---|---|
| `sku` | sku, item code, product code, code, barcode, item no, part no, 货号, 编号, 条码 |
| `price` | price, unit price, selling price, retail price, rate, amount, sgd, s$, $, 价格, 售价, 单价, 价钱; not "cost" or "cost price" (a purchase price, D7) |
| `stock` | stock, qty, quantity, inventory, on hand, available, balance, 库存, 数量 |
| `unit` | unit, uom, size, per, pack, 单位, 规格 |
| `service` | service, treatment, package, 服务, 项目 |
| `product` | product, item, name, description, menu, dish, 产品, 品名, 名称, 商品, 菜名 |

Then by content, for fields still unmapped: `price` → the first column whose non-empty samples (up to 20 rows) all parse as SGD prices and aren't all whole numbers under 1,000 without a currency sign (which look like stock); `product` → the first column with mostly non-numeric text. GST: a price header containing "incl"/"inclusive"/"w/ gst"/"含税" suggests `inclusive`; "excl"/"before gst"/"+ gst"/"不含税" suggests `exclusive`; otherwise `null`, and the owner chooses (UC-10 step 4).

### 5.5 Row validation (`mapRows`, KB-03 "rows that fail validation are listed with the reason")

Pure: `mapRows(rows, mapping, gst, { asOf })` → per row `{ row, reason, input: FactInput | null }`, in sheet order. Per row, the first rule that applies:

1. Every mapped cell empty → `excluded: empty_row` (not a rejection; blank rows are common).
2. No name (product cell, else service cell, empty) → `failed: no_name`.
3. Price cell empty → `failed: no_price`.
4. Price cell has another currency (`RM`, `MYR`, `USD`, `US$`, `€`, `£`, `¥`, `元`, `RMB`, `HK$`, `A$`) → `failed: not_sgd`.
5. Price not an SGD amount → `failed: bad_price`. Accepted: optional `S$`/`SGD`/`$` before or after, spaces, thousands commas (`1,200.50`), up to 2 decimals (an XLSX number with float noise is rounded when within 0.000001 of a cent), 0 to 9,999,999.99. Ranges (`5-10`), text (`Free`, `TBC`) and negative numbers are rejected.
6. Stock cell (if mapped) not empty and not a whole number ≥ 0 (`12`, `12.0`, `1,200`) → `failed: bad_stock`.
7. Name over 200, unit over 60, or SKU over 64 characters → `failed: too_long`.
8. Same entity and value as an earlier importable row (`sameValue`, FEAT-014) → `excluded: duplicate`.
9. Otherwise importable: `{ type: 'product', value: { name, priceCents, currency: 'SGD', unit?, sku?, stock?, stockAsOf? }, gstTreatment: gst }`, with `stockAsOf` the confirm day in SGT when stock is set.

Two importable rows for one product with different prices stay importable; the promote stage writes both `conflicted` (KB-06), and the preview counts them in `conflicts`.

### 5.6 Preview and confirm (dashboard scope, `sheets.ts`)

- `checkMapping(sheet, mapping)` → `BadMappingError` (400 `bad_mapping`) with a message: "Choose the column with the product or service names", "Choose the column with the prices", "One column can't be used for two fields", "That column isn't in this sheet".
- `previewImport(ctx, id, body)`: the source must be `kind 'spreadsheet'`, `queued` at `map` (else `InvalidStateError`). Reads the attempt's rows, runs `mapRows`, then `planPromotion` (FEAT-014) with the importable rows against the tenant's facts of type product (the promote stage's `existingFacts`, exported) to count `existing` and `conflicts` and mark each sample row's `conflict`. `gstReview` = importable rows when `gst = 'unknown'` and the business profile says GST-registered. Reads only; no lock.
- `confirmImport(ctx, id, body)`: locks the source with its `version` (`VersionConflictError`), checks state and mapping, runs `mapRows`. With no importable row it fails the source `no_valid_rows` (UC-10 5a). Otherwise it stores `mapping = { columns, gst, confirmedBy: userId, confirmedAt: now }`, sets stage `import`, status `queued`, version + 1, and enqueues the job. Audit `kb_source.import_confirmed { rows, importable, rejected, gst }` (counts and codes only, NFR-11): this entry is the approver and time of the import's approval (KB-16).

### 5.7 Import and promote stages

- **`import`** (`importSheetRows`): reads `mapping` and the attempt's rows, runs `mapRows` with `asOf` = the confirm day, and in one transaction (stale check): updates every row's `status`/`reason` (importable stay `included`; rejections `failed`; empty and duplicate rows `excluded`); writes one `kb_staged_facts` row per importable row (`quote` = the row's `content`, `quote_start` 0, `quote_end` its length, `confidence` 1, `dedupe_key` = `entityKey`); sets `pages_included`, `pages_failed`, `pages_excluded`, `pages_extracted` = importable. Then `next('promote')`. No importable row (only possible if the rows changed under a retry) → `failed: no_valid_rows`.
- **`promote`**: `promoteSource` unchanged except, for a spreadsheet: a fact the plan writes `needs_review` is written **`approved`** (ADR-010: "confirmed spreadsheet import → approved"), with `last_confirmed_at` now and `created_by`/`updated_by` = `mapping.confirmedBy`; facts the plan writes `conflicted` stay conflicted (KB-06 outranks the import's approval); each approved fact gets an audit `fact.approved { version: 1, mode: 'import', source }` with actor the confirming user (KB-16: every approval audited with the approver). `source` = `'spreadsheet'`. The source's `kb_source.promoted` entry gains `approved: n`. Embedding and the single write transaction are FEAT-012's, so a failure leaves no fact (KB-12).
- A GST `unknown` product of a GST-registered tenant is approved but stays out of `visitor_facts` (0003) and shows in the facts list's "GST to review" filter (FEAT-011), which is UC-10 4a's "flagged for review and not quoted until reviewed".

### 5.8 Retry and delete

- `retrySource` for a spreadsheet: `NotRetryableError` for FEAT-015's safety failures and `no_rows` (the file holds no table; a new upload is needed). Otherwise it restarts at `parse` (the stored file) as a new attempt; after `no_valid_rows` it also clears `mapping`, so the source waits at `map` again for a better mapping (UC-10 5a "retry option"). After a transient failure (`extraction_unavailable` from embeddings, `internal`) the mapping is kept and the parse goes straight on to `import`.
- `deleteSource` treats a spreadsheet as a file: rows, staging and facts go, and the purge job deletes the stored object.
- `countFileSources` counts `file` and `spreadsheet` sources (UC-10 precondition: the plan's file limit).

### 5.9 Wiring and configuration

- `packages/contracts`: §3.1 shapes, `UPLOAD_EXTENSIONS`, `SHEET_EXTENSIONS`, the spreadsheet body in `CreateSourceBody`, `ImportBody`, `ConfirmImportBody`, `ImportPreview`, `IngestJob` with `import`.
- `packages/db`: schema and migration 0024 (§4).
- `apps/api`: routes; `checkFile(name, size, kind)`; config `SHEET_ROW_LIMIT` is the worker's, not the api's (the api only reads stored rows).
- `apps/ingest-worker`: config `SHEET_ROW_LIMIT` (default 2000) passed in `FileDeps.limits.sheetRows`; `.env.example`. Logs: source ID, stage, rows, columns, importable and rejected counts; never cells or headers (NFR-11).
- No Terraform change: the buckets, scanner and task policies are FEAT-015's.

### 5.10 Test fixtures

`apps/ingest-worker/fixtures/files/` gains, from `generate.ts`: `price-list.xlsx` (a title row, a header row "Item code | Product | Size | Price (incl. GST) | Stock", 12 rows with one blank row, a row without a price, a row priced "TBC", a negative stock, a duplicate row and a `RM 12` price; shared strings, a number formula with a cached value), `services.csv` (semicolon-delimited, "Service;Price", quoted names with commas and a line break, a BOM), `price-list-500.csv` (500 valid rows for NFR-16), `hidden-first.xlsx` (a hidden first sheet), `protected.xlsx` (an OLE container named `.xlsx`), `legacy.xls` (OLE), and `latin1.csv` (Windows-1252 bytes). XLSX files are written with `fflate` from XML strings, so the generator needs no spreadsheet library.

## 6. Acceptance criteria

- **AC-1 (KB-03; UC-10 1, 2a).** `POST /api/v1/kb/uploads` accepts `.csv` and `.xlsx` names; `POST /api/v1/kb/sources { kind: 'spreadsheet', … }` returns 201 `queued` at `scan` with an audit `kb_source.created` without the file name and one `ingest` job. A `.pdf` name as a spreadsheet is 400 `unsupported_type`; the file limit counts spreadsheets (409 `file_limit_reached`); an `agent` session gets 403.
- **AC-2 (KB-11; UC-10 2, 2a).** A spreadsheet goes through the malware scan: an EICAR file named `prices.csv` fails `malware` and is deleted unread. `protected.xlsx` fails `encrypted`; `legacy.xls`, a DOCX named `.xlsx` and an executable named `.csv` fail `unsupported_type`; `latin1.csv` fails `unsupported_type` (not UTF-8). An XLSX uploaded as a plain file still fails `unsupported_type` (FEAT-015 AC-3 holds).
- **AC-3 (KB-03 "mappings are auto-suggested"; UC-10 3).** After the parse, `price-list.xlsx` waits `queued` at stage `map` with no job, its header found on row 3 below the title row, its rows stored with their cells and its suggested mapping `{ sku: 0, product: 1, unit: 2, price: 3, stock: 4 }` and GST `inclusive`; `services.csv` suggests `{ service: 0, price: 1 }` with its quoted cells read whole. The hidden first sheet of `hidden-first.xlsx` is passed over. A sheet with a header and no data fails `no_rows`.
- **AC-4 (KB-03 "rows that fail validation are listed with the reason"; UC-10 4, 5).** `POST /:id/preview` for `price-list.xlsx` with the suggested mapping returns the importable count, each rejected row with its reason (`no_price`, `bad_price` for "TBC", `bad_stock`, `not_sgd`), the blank row as empty and the repeated row as a duplicate, and writes nothing. Changing the mapping (for example unmapping stock) changes the result. A mapping without a price or name column, or with one column twice, is 400 `bad_mapping`. `mapRows` unit tests cover every rule of §5.5.
- **AC-5 (KB-03 "confirming the import preview approves the imported rows"; KB-16; ADR-010).** `POST /:id/import` stores the mapping and the import runs to `ready`: every importable row is an `approved` product fact with `source 'spreadsheet'`, `confidence` 1, provenance `{ url: 'row/<n>', quote: the row }` and `location { unit: 'row' }`, its SKU, stock and `stockAsOf` in the value, `gst_treatment` as chosen, a version row, a chunk, and an audit `fact.approved { mode: 'import' }` by the confirming user; `kb_source.import_confirmed` records the counts. Rejected rows are `failed` pages with their reasons and no fact. An approved imported fact is answered to a visitor through `visitor_facts`; stock and SKU never appear in the agent's prompt.
- **AC-6 (KB-15; UC-10 4a).** For a GST-registered tenant, importing with GST "unknown" approves the rows but none is in `visitor_facts` and all appear under the facts list's `gst=unknown` filter; the preview's `gstReview` equals the importable count. For a tenant not registered for GST, the same rows are in `visitor_facts`.
- **AC-7 (KB-06; UC-10 6).** A row whose product the KB already has at another price is written `conflicted` and the existing fact is flagged `conflicted` (out of visitor answers); a row equal to an existing fact is not written again. The preview's `conflicts` and `existing` count them beforehand. Two rows of one product with different prices are both written conflicted.
- **AC-8 (KB-12, UC-10 5a, NFR-17).** Confirming a mapping under which no row is importable fails the source `no_valid_rows` with nothing written; retry brings it back to `map` with its rows, and a corrected mapping then imports. With embeddings failing, the source fails `extraction_unavailable` with no fact; retry runs `parse` → `import` → `promote` with the kept mapping and ends `ready`. A duplicate or stale import job changes nothing. Retry on `no_rows` is 409 `not_retryable`. Deleting a spreadsheet removes its rows and facts and purges its object; one waiting at `map` can be deleted.
- **AC-9 (ADR-005).** RLS: tenant B sees none of tenant A's spreadsheet sources or rows in any zone, and preview or import of tenant A's source from tenant B is 404.
- **AC-10 (NFR-16).** On the local stack, `price-list-500.csv` is `ready` with 500 approved facts within 1 minute of `POST /:id/import` (fake embeddings). Timed and recorded.
- **AC-11 (UC-10, UC-03 6; E2E; NFR-19, NFR-09).** In the browser the owner uploads `price-list.xlsx` on Add sources, follows "Map columns" to SCR-APP-025, sees the suggested mapping with sample values, sees the preview with the rejected rows and reasons, changes a column, chooses the GST treatment, confirms, watches it import and sees the done state ("8 rows imported · 4 not imported") with the rejected rows listed; an imported fact's page shows "From row 5 of price-list.xlsx" with its SKU and stock. No serious axe violations on SCR-APP-025.

## 7. Decisions

- **D1 — A spreadsheet is a KB_SOURCE; its rows are its pages.** Driver: ADR-018 d1 and FEAT-015 D1. Rows as `kb_source_pages` give per-row status and reason (the rejected-row list), provenance (`row/12`), review and conflict passages, retry and delete with no new table; `cells` keeps the row's structure for remapping. Rejected: a `kb_sheet_rows` table (a second row model for the same consumers) or a JSON blob on the source (no per-row status, no provenance join).
- **D2 — XLSX and CSV are read by our own small readers, not SheetJS.** Driver: npm's SheetJS 0.18.5 has unfixed advisories and newer builds aren't on the registry (pinned versions, Renovate); FEAT-015 reads OOXML with `fflate` already; we need cell values only, not formats or formulas. Rejected: `exceljs` (a large dependency tree for a read of one sheet), SheetJS from the vendor CDN (outside the registry and Renovate). Consequence: legacy `.xls` and `.ods` aren't read (the UI says "Save it as .xlsx or CSV").
- **D3 — Waiting for the mapping is stage `map` with status `queued`, not a new status.** Driver: KB-12 names four states, and the source is waiting, as a queued one is. No job is written for `map`, so nothing runs until the owner confirms; the dashboard shows "Map columns" for it and stops polling. Rejected: a fifth status (every consumer of the status list changes for a sub-state).
- **D4 — The preview is computed by the API from the stored rows; the import re-runs the same function.** Driver: KB-03 "the owner confirms or edits the mapping", with the result shown before anything is written; one pure `mapRows` for both means the preview can't drift from the import. 2,000 rows validate in milliseconds. Rejected: validating in the browser (a second implementation) or a preview job (a round trip through the queue for each mapping change).
- **D5 — Confirming approves; conflicts still win.** Driver: KB-03 and D11 make the confirmation the approval; KB-06 makes conflicting prices unquotable. So an imported row that disagrees with the KB is written `conflicted`, like any source's, and the owner resolves it (UC-10 step 6, FEAT-014). The confirm audit entry plus one `fact.approved` per fact give KB-16's per-approval record with the approver.
- **D6 — Retry re-parses the stored file.** Driver: `retrySource` clears the attempt's pages (FEAT-012); re-reading the stored file is cheap and gives the same rows. After `no_valid_rows` the mapping is cleared so the owner can map again; after a transient failure it is kept, so the owner isn't asked twice.
- **D7 — "Cost" isn't a price.** Driver: a POS export often has both a cost price and a selling price; quoting cost would be a wrong price. The owner can still map a cost column by hand.
- **D8 — SKU and stock are stored but never quoted, and survive edits.** Driver: KB-03 maps them; architecture Q6 and OI-2 say stock counts aren't quoted unless the owner turns on "quote stock" (not in this feature). The agent's prompt already gives the model only name, unit and price. `stockAsOf` records when the count was true, for the "as of <date>" Q6 asks for when quoting is built. The fact page shows them read-only; an edit of name, price or unit keeps them. Rejected: dropping stock (KB-03 lists it) or making it editable (no requirement asks; Q6 makes it a display-only value for now).
- **D9 — One sheet per import, the first visible one.** Driver: a price list is one table; asking for a sheet adds a step for the rare workbook with several. The mapping screen names the sheet it read. Rejected: a sheet picker (revisit if pilots ask).
- **D10 — Rows over 2,000 are counted, not read.** Driver: NFR-16 sizes the job at 500 rows; 2,000 keeps a preview response and a row list small (about 200 KB) and an import within the minute. The screen says how many were left out.

## 8. Escalations and open items

- **No architecture amendment.** Spreadsheets are KB_SOURCE (ADR-018 d1), confirmed imports are approved facts (ADR-010's state diagram), SKU and stock are fields of the Product entity (KB-05, Q6).
- **ADR-018 d3 divergence** (SheetJS → own readers) is recorded in D2; no ADR change is needed because the decision's intent (a deterministic parse in the ingest worker) holds.
- **Re-importing an updated price list:** an existing spreadsheet's facts with the same prices are dropped as duplicates, and changed prices conflict with the old ones. The UI suggests deleting the old spreadsheet first. A replace-and-diff import is FEAT-020's territory (re-sync); noted for its design.
- **Stock updates** on a row whose price didn't change aren't written (the fact is a duplicate by FEAT-014 D2's rule). Harmless while stock isn't quoted (Q6); revisit with the "quote stock" setting.
- **Owner e-mail alert on failure** stays with FEAT-052, as for files.
- **Legacy `.xls`, `.ods`, `.numbers`** aren't read (D2); the refusal text names the formats to save as.

## 9. Self-check

Requirement coverage: KB-03 → AC-1, AC-3, AC-4, AC-5, AC-10, AC-11 (500 rows: AC-10; mapping suggested and editable: AC-3, AC-4, AC-11; invalid rows listed with reasons and not imported: AC-4, AC-5; confirming approves: AC-5). KB-11 → AC-2. KB-15 → AC-6. KB-16 → AC-5. KB-06 → AC-7. KB-12 → AC-8. KB-07 (p) → AC-8. UC-10 1 → AC-1; 2, 2a → AC-2; 3 → AC-3; 4 → AC-4, AC-11; 4a → AC-6; 5 → AC-4, AC-5; 5a → AC-8; 6 → AC-7. UC-03 6 → AC-11. NFR-16 → AC-10; NFR-17 → AC-8; NFR-11 → §5.6 and §5.9 (counts and codes only); NFR-06 → AC-2; NFR-07 → FEAT-015's buckets; NFR-19, NFR-09 → AC-11; ADR-005 → AC-9. E2E obligation: UC-03 and UC-10 are in J1 (architecture §8.7); this feature completes UC-10 → T12 adds `spreadsheets.e2e.ts`. IDs checked: KB-03/06/07/11/12/15/16, UC-03/10, SCR-APP-007/023/025/028, ADR-005/010/012/015/018, NFR-06/07/09/11/16/17/19, D11, Q6, OI-2 all resolve. Schema changes are on KB_SOURCE and FACT only. Contracts keep `/api/v1`, `{ error, message }` and `version`. Changes to FEAT-015's contracts are additive (new enum values, nullable `sheet` and `cells`); the dashboard is the only consumer and is updated in the same PR.
