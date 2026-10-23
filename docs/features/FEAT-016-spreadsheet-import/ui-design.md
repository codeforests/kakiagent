# UI Design: FEAT-016 — Spreadsheet import with column mapping and preview

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-025 (new), SCR-APP-007 (extended: spreadsheets in the files part), SCR-APP-023 (extended: spreadsheet rows), SCR-APP-028 (extended: a row's provenance, SKU and stock) · Mode: per-feature · Status: Verified · Date: 2026-10-23

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so every screen here is a code-native spec. Every value comes from design.md and `tokens.json`. No new component or token is introduced: the mapping uses `select` fields, the GST choice `radio`s, the preview a `table`/`list`, and states use `alert`, `progress`, `status-badge`, `empty-state` and `error-state`.

## Cross-screen

- **Source icon:** spreadsheets get a table icon (the 20 px line style, `currentColor`), beside the globe, document and picture icons.
- **File type labels:** xlsx "Excel workbook", csv "CSV file".
- **Field names** (`SheetField` → label): product "Product name", service "Service name", price "Price", unit "Unit or size", sku "SKU or item code", stock "Stock".
- **Stage names** add: map → "Waiting for you: map the columns", import → "Importing rows". scan and parse keep FEAT-015's ("Checking the file", "Reading the file"); promote keeps "Saving facts".
- **Failure reasons** add, for spreadsheets:
  - `no_rows`: "We couldn't find a table with a header row and at least one row below it. Check the first sheet, then upload it again."
  - `no_valid_rows`: "None of the rows could be imported with that mapping. Retry to map the columns again."
  - `unsupported_type` on a spreadsheet: "This isn't a spreadsheet we can read. Upload an .xlsx file, or a CSV saved as \"CSV UTF-8\"."
  - `encrypted` on a spreadsheet: "This workbook is password-protected. Save a copy without a password and upload that."
  - `unreadable` on a spreadsheet: "This spreadsheet seems damaged and couldn't be read. Open it, save it again as .xlsx, and upload the copy."
  - Others (malware, upload_missing, too_large, scan_unavailable, extraction_unavailable, internal) keep FEAT-012/015's text.
- **Row reasons** (`reason` → text): `no_name` "No product or service name", `no_price` "No price", `bad_price` "The price isn't an amount in dollars, like 12.50", `not_sgd` "The price isn't in Singapore dollars", `bad_stock` "Stock isn't a whole number", `too_long` "A name, unit or SKU is too long", `duplicate` "Same as an earlier row", `empty_row` "Empty row".
- **Row labels:** "Row 12" (the sheet's row number, as Excel shows it).
- **Retry or upload again:** as FEAT-015; `no_rows` is not retryable, so it shows "Upload again".

## SCR-APP-025 — Spreadsheet import

- **Strategy and source:** code-native (this section).
- **Route:** `/knowledge/sources/:id` for a source of kind `spreadsheet` (SCR-APP-024 renders this screen instead of the page list). Back link "Sources". Roles: Owner, Admin (`kb.manage`); others get the permission state.
- **Contract bindings:** `GET /api/v1/kb/sources/:id` (source with `file`, `sheet`, and its rows as `pages` with `cells`), `POST /api/v1/kb/sources/:id/preview`, `POST /api/v1/kb/sources/:id/import`, `POST /:id/retry`, `DELETE /:id`.
- **Page head:** title = file name; caption "{Excel workbook | CSV file} · {size} · Uploaded {date}"; when `file.scannedAt`: success caption with a check icon "Checked for malware: none found"; a `status-badge` on the right (Queued, Processing, "Map columns" info tone when stage is `map`, Ready, Failed).

### processing (scan, parse)
A `card` with the stage name and an indeterminate `progress`; body-sm "We'll show you the columns as soon as the sheet is read." Polling every 2 s as FEAT-012.

### mapping (stage `map`)
Single column, max width 720 px.
1. `subsection-title` "Match your columns"; body-sm: "We read {rows} rows from the sheet "{sheet.name}"" (CSV: "from the file"), "starting at row {headerRow + 1}. Check each column we matched, then preview the import." When `rowsSkipped` > 0: warning `alert` "Only the first 2,000 rows are imported. {n} rows after that weren't read."
2. **Mapping form**, one `field` with a `select` per target, in this order: Product name, Service name, Price (required), Unit or size, SKU or item code, Stock. Options: "Not in this sheet" then each column as "{header} — e.g. {first sample}" (samples truncated at 40 chars). Suggested choices are preselected and their help text says "Suggested from the column name" (or "Suggested from its values" for a content match). Help under Product/Service: "Choose at least one. A row uses the product name, or the service name when it has none." Help under Stock: "Stock is saved with today's date. Your assistant doesn't tell customers stock counts."
3. **GST** `fieldset` with legend "Do these prices include GST?" and three `radio`s: "Yes, prices include GST", "No, GST is added on top", "Not sure". Preselected from `suggested.gst`; none selected otherwise (required). For a GST-registered business, "Not sure" has help text: "Your assistant won't quote these prices until you set their GST treatment." For a business not registered for GST, the fieldset's help says "Your business profile says you're not GST-registered, so customers see these prices as they are." and "Yes" is preselected when nothing was suggested.
4. A `secondary` button "Preview import". Validation (on submit, design.md §4.2): no name column → error on Product name "Choose the column with the product or service names"; no price → on Price "Choose the column with the prices"; one column twice → on the later field "This column is already used for {field}"; no GST choice → on the fieldset "Choose whether the prices include GST". Server `bad_mapping` shows its message in the top `alert`.

### preview (after "Preview import")
Shown below the form (the form stays editable; changing any field hides the preview and asks to preview again, so what is confirmed is what was shown).
1. **Summary** `card`: title-sm "{importable} rows will be imported"; body-sm lines, each only when non-zero: "{rejected} rows can't be imported (listed below)", "{empty} empty rows and {duplicates} repeated rows will be skipped", "{existing} rows match facts you already have and won't be added again", "{conflicts} rows disagree with facts you already have. They'll be held back until you resolve them in Review → Conflicts." (warning text with the `!` icon), "{gstReview} prices wait for their GST treatment before your assistant uses them." (warning). Then: "Importing approves these rows: your assistant can use them straight away."
2. **Preview** `table` (desktop) / stacked `list` (< 768 px), caption "First {n} rows to import": columns Row, Name, Price (SGD with 2 decimals), Unit, SKU, Stock (only mapped fields), and a `chip` "Conflict" (warning) on rows with `conflict`.
3. **Can't be imported** section (when `rejects` is non-empty): `subsection-title` "Rows we can't import ({rejected})", a `table`/`list` with Row, Reason (text above), and the row's cells joined with " · " in text-secondary, truncated with the full text in `title`. More than 500 → caption "Showing the first 500."
4. Actions: `primary` "Import {importable} rows" opening a `confirm-dialog`: title "Import {importable} rows?"; body "They're approved as you import them, so your assistant can use them straight away{, except the {conflicts} that disagree with facts you have | , except {gstReview} prices waiting for their GST treatment}. Rows that can't be imported are listed on this page afterwards."; buttons "Cancel" and "Import {importable} rows". When `importable` is 0 the primary is disabled and an inline danger `alert` says "None of the rows can be imported with this mapping. Check the Price and name columns." `danger-ghost` "Delete spreadsheet…" in the footer (as FEAT-012's delete-confirm, title "Delete {file name}?", body "Nothing has been imported from it yet. The file is deleted from our storage.").
5. Loading: the Preview button shows its loading state; the preview area keeps the previous result dimmed with `aria-busy`. Error: inline danger `alert` "We couldn't preview the import. Try again." with [Try again]. 409 `invalid_state` or `version_conflict` on import: info `alert` "This import changed in another tab. We've reloaded it." and the screen refetches.

### importing (stage `import` or `promote`)
A `card` with "Importing rows" / "Saving facts", an indeterminate `progress`, and body-sm "This takes under a minute for most price lists." The mapping is shown read-only above it (field: column header).

### done with rejects (ready)
1. Success `alert`: title "{facts} rows imported" (facts = `counts.facts`); body "They're approved and your assistant can use them now." plus, when present, "{n} disagree with facts you already have: resolve them in Review → Conflicts." with a `link` to `/review/conflicts`, and "{n} prices wait for their GST treatment." with a `link` to `/knowledge?gst=unknown`.
2. Figures row (as SCR-APP-024's ready figures): "Imported" (`counts.pagesIncluded`), "Not imported" (`counts.pagesFailed`), "Skipped" (`counts.pagesExcluded` + `sheet.rowsSkipped`).
3. **Rows** section with a filter (`select`: All rows, Imported, Not imported, Skipped) and the `table`/`list`: Row, Result (`chip`: Imported success, Not imported danger with the reason text, Skipped neutral with the reason text), the row's cells joined with " · ". Default filter "Not imported" when there are any, else "All rows". Filtered-empty: "No rows match this filter." [Show all rows].
4. The mapping, read-only, under a `subsection-title` "Columns used".
5. Footer: `link` "See imported facts" → `/knowledge?sourceId={id}`; `danger-ghost` "Delete spreadsheet…" (FEAT-012 delete-confirm with the facts count: "Its {facts} facts will be deleted too…").

### failed
Danger `alert` with the reason text and Retry (`retryable`) or "Upload again" (→ `/knowledge/sources/new#files`). After `no_valid_rows` and Retry, the screen returns to processing, then mapping.

### loading, error, not-found, permission
As SCR-APP-024 (skeleton of the page head and a card; error-state with [Try again]; "This source doesn't exist or was deleted." with [Back to sources]; "Only the Owner or an Admin can import spreadsheets.").

- **Live region:** polite announcements: "{file} is ready to map." (map), "{n} rows imported." (ready), the failure text (failed), and after a preview "{importable} rows will be imported, {rejected} can't be."
- **Responsive notes:** below 640 px the selects are full width and the preview tables become stacked lists (primary: Name, meta: Price · Unit · SKU · Stock, chip right; rejects: "Row 12", reason, cells). The primary action is full width.
- **Decisions:** the mapping and preview are one page, not a wizard of steps, so a changed column and its effect are seen together; the preview is hidden on change, so the confirm always matches a shown preview (technical design D4). Spreadsheets live on the existing source route so links from SCR-APP-023 and the upload list don't need to know the kind.

## SCR-APP-007 — Add your sources (extended: spreadsheets)

- **Strategy and source:** code-native (on top of FEAT-015's files part).
- **Changes to the Files section:** help text becomes "PDF, Word (.docx), PowerPoint (.pptx), text (.txt), JPG or PNG, up to 25 MB each. Price lists in Excel (.xlsx) or CSV are imported row by row: you match the columns before anything is added. Scanned pages and photos are read with OCR, in English and Chinese. Text in pictures inside Word or PowerPoint files isn't read." The input's `accept` adds `.csv,.xlsx`. A `.csv` or `.xlsx` file is created as a `spreadsheet` source (technical design §3.2); the plan line counts files and spreadsheets.
- **Upload list for a spreadsheet:** table icon; once the source waits at `map`, the row's state is the "Map columns" badge and a `link` "Map columns" (instead of "View") to SCR-APP-025. The live region says "{file} is ready to map." once.
- **Refusals:** an `.xls` file is refused in the browser with "Save it as .xlsx or CSV first".
- **States:** unchanged (default, uploading, added, refused, limit, error), plus the row's map state.

## SCR-APP-023 — Sources (extended: spreadsheet rows)

- **Strategy and source:** code-native.
- **Rows:** table icon; name = file name; meta "Uploaded {date} · Excel workbook · 48 KB". Waiting at `map`: the "Map columns" badge and a `secondary sm` "Map columns" link-button to SCR-APP-025; the list doesn't poll for it (it's waiting for the owner). Ready: "{facts} facts imported · {n} rows not imported" (the second part only when non-zero). Failed: the reason and Retry or "Upload again".
- **Help text** gains nothing; the empty state is unchanged.

## SCR-APP-028 — Fact (extended: a row's provenance, SKU and stock)

- **Strategy and source:** code-native (on top of FEAT-015's file provenance).
- **Provenance line:** for `location.unit = 'row'`: "From row {n} of {source name}" as plain text, then "Imported" instead of a confidence, then "Open source". The review and conflict cards use the same words.
- **SKU and stock:** for a product with `sku` or `stock`, a read-only definition list under the price fields: "SKU or item code: PC-01", "Stock: 12 (as of 23 Oct 2026)", with caption text-secondary "From the imported spreadsheet. Your assistant doesn't tell customers stock counts." Editing the fact keeps them.
- **States:** unchanged.

## Manifest and gaps

- SCR-APP-025 gets its own entry: `feature: FEAT-016`, `strategy: code-native`, spec this file's SCR-APP-025 section, states covered processing, mapping, preview, importing, done-with-rejects, failed, loading, error, not-found, permission, filtered-empty, delete-confirm; no gaps.
- SCR-APP-007 gains this file in `extended_by`; its gap becomes "chat exports (FEAT-017)". SCR-APP-023 and SCR-APP-028 gain this file in `extended_by`.
- No design-system escalation: `select`, `radio`, `fieldset`/`field`, `table`/`list`, `card`, `alert`, `progress`, `status-badge`, `chip`, `confirm-dialog`, `empty-state`, `error-state` and the live-region pattern are all in design.md.
