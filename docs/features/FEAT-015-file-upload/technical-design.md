# Technical Design: FEAT-015 — File upload with content-type and malware checks; parsing and Tesseract OCR

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) and §5 (M2, fifth) · Epic: E2 Knowledge base
> Implements: KB-02, KB-11 · Also serves: KB-05 (p: extraction from file pages, through FEAT-012's extract stage), KB-07 (p: browse and delete file documents, the FEAT-011 §8 plan correction), KB-12 (p: file sources), KB-16 (facts from files enter the review queue), GOV-05 (p: a deleted file's object goes with it) · Binding NFRs: NFR-06 (malware protection), NFR-16 (95% of files ≤ 25 MB ready in 3 minutes), NFR-07 (files stay in ap-southeast-1), NFR-11 (IDs-only logs and audit), NFR-17 (no job lost), NFR-19 (states), NFR-09 (WCAG 2.1 AA)
> Realizes: UC-03 step 6 (files) and 4a ("no website → files"); UC-10 steps 1–2 and exception 2a for the shared upload and safety path (spreadsheet mapping is FEAT-016); UC-11 step 2's "checks and scans the file" (mining is FEAT-017)
> Screens: SCR-APP-007 (p: the files part), SCR-APP-023, SCR-APP-024 (p: a file's extraction), SCR-APP-028 and SCR-APP-019 (p: file provenance), designed in [ui-design.md](ui-design.md)
> Status: Verified (self-check §9) · Date: 2026-10-23

## 1. Intent

Many SMEs have no website worth crawling, or keep their real price list in a PDF, a Word file or a photo of the menu board (UC-03 4a). FEAT-015 lets the owner upload those files (KB-02). Each file goes to a quarantine bucket and is checked before anything reads it: its content type comes from its bytes, not its name; it is scanned for malware; encrypted and password-protected files are refused (KB-11). A clean file is parsed into pages (PDF text layer, DOCX, PPTX, TXT), with Tesseract OCR in English and Chinese for scanned pages and images (ADR-019). From there it joins FEAT-012's pipeline: the same extract and promote stages, the same `needs_review` facts with provenance, the same conflict detection (FEAT-014), and the same source status, retry and delete (KB-12). It comes after FEAT-014 in M2 because it reuses that whole pipeline, and FEAT-016 (spreadsheets) and FEAT-017 (chat exports) reuse the upload and safety path this feature builds.

## 2. Codebase context

Surveyed on `main` at `9acc7d1` (after FEAT-014, PR #20).

- **Schema:** migrations 0000–0022. `kb_sources` (kind `website` only; `url`, `domain`, `page_limit`, `attested_by`, `attested_at` not null; stages `crawl`, `extract`, `promote`; failures `no_pages`, `site_unreachable`, `extraction_unavailable`, `internal`), `kb_source_pages` (per attempt, `url` unique per attempt, `content` masked text ≤ 50,000 chars), `kb_staged_facts`, `facts.source_id`/`confidence`/`provenance`. Outbox topic `ingest`. `app_ingest` has SELECT/UPDATE on `kb_sources`, full DML on pages and staging, SELECT/INSERT on facts, versions and chunks, and FEAT-014's status-only UPDATE on facts.
- **Pipeline:** `packages/kb/src/ingest/job.ts` `runIngestJob` (stale check on source, attempt and stage; `processing`; transient errors rethrown until `INGEST_MAX_ATTEMPTS`, then `failed`), `extract.ts` (per page, reads `kb_source_pages` of the attempt, `parseExtraction` checks quotes and prices against the page), `promote.ts` (`planPromotion` with conflicts, one transaction). The extract and promote stages read only pages and staging, never the crawl, so a file that writes pages can reuse them unchanged.
- **Sources API:** `apps/api/src/sources.ts` (`POST/GET /api/v1/kb/sources`, `GET/DELETE /:id`, `POST /:id/retry`), contracts in `packages/contracts` ("knowledge sources"), capability `kb.manage`, error envelope `{ error, message }`, `version` precondition.
- **S3:** `@aws-sdk/client-s3` 3.1152.0 is already used by `@kaki/governance` (audit anchors) against LocalStack locally (`02-buckets.sh`) and through `@testcontainers/localstack` in tests. Terraform's storage module already creates the `quarantine` bucket (24-hour lifecycle) and the `sources` bucket; no application role uses either yet.
- **ClamAV:** `docker-compose.yml` has `clamav/clamav:1.4` on port 3310 behind the `ingest` profile, with a comment naming FEAT-015. No code talks to it.
- **Review and provenance:** `withPassages` (review, conflicts) finds a fact's page by `(source_id, provenance.url)` in the current attempt, and names the source by `kb_sources.domain`. `FactProvenance` and the review card render `provenance.url` as an external link.
- **Dashboard:** SCR-APP-023 `pages/sources.tsx`, SCR-APP-024 `pages/source.tsx`, SCR-APP-007's website form `pages/add-website.tsx` at `/knowledge/sources/new` and `/setup/sources`, shared helpers in `lib/sources.ts` (states, stage names, reasons, 2 s polling).
- **Divergences (reality wins):** the plan names GuardDuty. Locally and until MD the scanner is ClamAV (plan §7, R7); ADR-019 already makes ClamAV the fallback, so both sit behind one interface (§5.3). ADR-018 d3 says pdf.js for the text layer; pdf.js can't render pages to images in Node without a canvas library, so scanned pages are rendered with poppler's `pdftoppm` (§7 D4).

## 3. API contracts

Shapes live in `packages/contracts` ("knowledge sources" section, extended). Auth, `kb.manage`, tenant from the session, `{ error, message }` and `version` as in FEAT-012 §3.

### 3.1 Shapes

```ts
SourceKind    = 'website' | 'file'
SourceStage   = 'scan' | 'parse' | 'crawl' | 'extract' | 'promote'
SourceFailure = 'no_pages' | 'site_unreachable' | 'extraction_unavailable' | 'internal'   // FEAT-012
              | 'upload_missing' | 'too_large' | 'unsupported_type' | 'encrypted'        // KB-11 safety
              | 'malware' | 'scan_unavailable' | 'unreadable' | 'no_text'                 // KB-11, KB-02
FileType      = 'pdf' | 'docx' | 'pptx' | 'txt' | 'jpeg' | 'png'
Source += {
  url: string | null, domain: string | null, pageLimit: number | null, attestedAt: string | null,  // null for files
  name: string,                         // the domain, or the file's name
  retryable: boolean,                   // failed with a reason a retry can fix (§5.6)
  file: { name, sizeBytes, type: FileType | null, ocrPages: number, scannedAt: string | null } | null,
}
PageReason += 'no_text'                 // excluded: no text, even after OCR
            | 'page_limit' | 'ocr_limit' // skipped: over FILE_PAGE_LIMIT / OCR_PAGE_LIMIT
SourcePage += { ocrConfidence: number | null }        // 0..1 when the page was read by OCR
Provenance += { location: { unit: 'page' | 'slide' | 'part' | 'image', number: number } | null }  // files
UploadTicket = { uploadId: uuid, url: string, headers: Record<string, string>, expiresAt: string }
```

A file page's `url` is a locator, `page/3`, `slide/2`, `part/1` or `image/1` (unique per attempt, as the column requires), and its `title` is null; `location` is derived from it. `Fact.source` gains the value `'file'`.

### 3.2 Endpoints

| Method, path | Request | Success | Errors |
|---|---|---|---|
| `POST /api/v1/kb/uploads` (new) | `{ fileName: string (1–200 chars, no `/`, `\` or control characters), sizeBytes: int (1 … 26,214,400) }` | 201 `UploadTicket`: a presigned `PUT` to the quarantine bucket, key `uploads/<tenantId>/<uploadId>`, valid 15 min, `Content-Length` signed to `sizeBytes`. Nothing is written to the database | 400 `bad_request`; 400 `unsupported_type` (extension not one of `.pdf .docx .pptx .txt .jpg .jpeg .png`; UC-10 2a); 400 `file_too_large` (over 25 MB, KB-02); 409 `file_limit_reached` (the tenant has `FILE_LIMIT` file sources, D2); 401, 403 |
| `POST /api/v1/kb/sources` | gains `{ kind: 'file', uploadId: uuid, fileName, sizeBytes }` (the size as declared for the upload; the scan stores the object's real size) beside FEAT-012's website body (a discriminated union on `kind`) | 201 `{ source }`: `kind 'file'`, `queued`, stage `scan`; audit `kb_source.created { kind: 'file', ext, sizeBytes }`; outbox `ingest` job | 400 `bad_request`/`unsupported_type` as above; 409 `source_exists` (this `uploadId` already has a source); 409 `file_limit_reached`; 401, 403 |
| `GET /api/v1/kb/sources` | — | gains `fileLimit: number`, `maxFileBytes: number` | unchanged |
| `GET /api/v1/kb/sources/:id` | — | a file's pages carry `ocrConfidence` | unchanged |
| `POST /api/v1/kb/sources/:id/retry` | `{ version }` | 200: a file restarts at `parse` when its clean copy is stored, else at `scan` (§5.6) | gains 409 `not_retryable` (a file failed for a reason only a new upload fixes) |
| `DELETE /api/v1/kb/sources/:id` | query `version` | 204, as FEAT-012, and an outbox `ingest` purge job removes the file's objects (§5.7) | unchanged |

The body of `POST /uploads` declares the size so the URL can sign it; the worker checks the stored object's real size again (§5.3), so a client that lies gains nothing. The upload ID is a fresh UUID under the session's tenant prefix, so a source can only be created for an object in the caller's own tenant prefix (§7 D2).

## 4. Schema changes

Migration `0023_file_sources` (drizzle-kit DDL from `schema.ts`, with the `name` backfill added by hand before its `NOT NULL`) and `0024_file_sources_grants` (hand-written; comments only if no grant changes are needed, §4 last row), against 0000–0022.

| Change | Conceptual entity | Definition |
|---|---|---|
| `kb_sources.kind` | KB_SOURCE (ADR-018 d1, d2: files are sources) | check gains `'file'` |
| `kb_sources.name text not null` | KB_SOURCE | the domain for websites (backfilled from `domain`), the file name (≤ 200 chars, as uploaded) for files. Review, conflicts and the summary read it instead of `domain` |
| `url`, `domain`, `page_limit`, `attested_by`, `attested_at` | KB_SOURCE | drop `not null`; new check `kb_sources_website_ck`: `kind <> 'website' or (url, domain, page_limit, attested_by, attested_at all not null)`. The unique `(tenant_id, kind, domain)` is unaffected (nulls are distinct) |
| `upload_key text null`, `file_key text null`, `file_size integer null`, `file_type text null`, `ocr_pages integer default 0`, `scanned_at timestamptz null` | KB_SOURCE (its file) | `upload_key` = the quarantine key; `file_key` = the `sources` bucket key once the file is clean; `file_type` check in `FILE_TYPES`; check `kb_sources_file_ck`: `kind <> 'file' or (upload_key is not null and file_size > 0)`; unique `(tenant_id, upload_key)` |
| `kb_sources.stage`, `failure` | KB_SOURCE | stage check gains `scan`, `parse`; failure check gains the eight file failures of §3.1. `kb_sources_counts_ck` allows a null `page_limit` |
| `kb_source_pages.reason` | KB_SOURCE (its page list) | check gains `no_text`, `page_limit`, `ocr_limit` |
| `kb_source_pages.ocr_confidence real null` | KB_SOURCE | check between 0 and 1 |
| `facts.source` | FACT | the value `'file'` (free text; no check change) |
| Grants | ADR-005 | none needed: `app_dashboard` already has full DML on `kb_sources` and INSERT on `outbox`; `app_ingest` has SELECT/UPDATE on `kb_sources` and DML on pages. 0024 is not written if it would hold no statement |
| RLS | ADR-005 | no new table. `rls.int.test.ts` gains a file-source case (tenant B sees none of tenant A's file sources) |

Rollback is forward-only, as in earlier migrations.

**Object storage (no database change):** quarantine `uploads/<tenantId>/<uploadId>` (24-hour lifecycle backstop, Terraform already); sources `files/<tenantId>/<sourceId>` (no lifecycle; deleted with the source; every attempt reads the same object). Locally both buckets are created by `02-buckets.sh` (`kaki-local-quarantine` with a 1-day expiry rule and CORS for the dashboard origin, `kaki-local-sources`).

## 5. Component design

```mermaid
sequenceDiagram
    autonumber
    actor O as "Owner"
    participant API as "api"
    participant Q as "S3 quarantine"
    participant DB as "Postgres"
    participant IW as "ingest-worker"
    participant AV as "ClamAV (GuardDuty at MD)"
    participant S as "S3 sources"
    O->>API: "POST /kb/uploads {fileName, sizeBytes}"
    API-->>O: "presigned PUT (15 min)"
    O->>Q: "PUT file"
    O->>API: "POST /kb/sources {kind: file, uploadId}"
    API->>DB: "tx: kb_sources(queued, scan) + audit + outbox ingest"
    IW->>Q: "head + get (≤ 25 MB)"
    IW->>AV: "scan bytes"
    IW->>IW: "sniff type, encryption check"
    IW->>S: "copy clean file; delete from quarantine"
    IW->>DB: "tx: file_type, file_key, stage parse + outbox"
    IW->>S: "get file"
    IW->>IW: "parse; OCR scanned pages and images (Tesseract eng+chi_sim)"
    IW->>DB: "kb_source_pages; tx: stage extract + outbox"
    Note over IW,DB: "extract and promote as FEAT-012 §5.3–5.4"
```

### 5.1 Where the code lives

- `packages/kb/src/ingest/files/` (logic, unit-tested with fakes): `sniff.ts` (type detection and encryption check), `parse.ts` (PDF text layer through `pdfjs-dist`, DOCX and PPTX XML through `fflate`, TXT, splitting into pages), `scan-stage.ts` and `parse-stage.ts` (the two new stages), `ports.ts` (the interfaces below).
- `apps/ingest-worker/src/` (adapters, integration-tested): `s3-files.ts` (`FileStore` on S3), `clamav.ts` (`MalwareScanner` over clamd's INSTREAM), `guardduty.ts` (`MalwareScanner` reading GuardDuty's object tag), `tesseract.ts` (`OcrEngine`, the `tesseract` CLI), `pdf-raster.ts` (`PdfRasterizer`, `pdftoppm`).
- `apps/api/src/uploads.ts`: `POST /api/v1/kb/uploads` and the `UploadSigner` (S3 presigner), injected through `Deps` so route tests use a fake.

```ts
interface FileStore {
  head(bucket: 'quarantine' | 'sources', key: string): Promise<{ size: number } | null>;
  get(bucket: 'quarantine' | 'sources', key: string): Promise<Uint8Array>;
  copyToSources(fromKey: string, toKey: string): Promise<void>;
  delete(bucket: 'quarantine' | 'sources', key: string): Promise<void>;   // a missing key is not an error
}
interface MalwareScanner {          // throws ScannerUnavailableError when it can't answer (transient)
  scan(file: { key: string; bytes: Uint8Array }): Promise<{ infected: false } | { infected: true; signature: string }>;
}
interface OcrEngine {               // Tesseract 5, eng+chi_sim (ADR-019)
  recognize(png: Uint8Array): Promise<{ text: string; confidence: number }>;   // confidence 0..1
}
interface PdfRasterizer { render(pdf: Uint8Array, page: number): Promise<Uint8Array> }  // PNG, 200 dpi
```

`IngestDeps` gains `files?: FileDeps = { store, scanner, ocr, rasterizer, limits }`; a worker without them fails a file job as `internal` (never happens when wired).

### 5.2 The job

`IngestJob.stage` gains `scan` and `parse`, and a separate body `{ tenantId, sourceId, stage: 'purge', keys: { quarantine?: string; sources?: string } }` (§5.7). `runIngestJob`'s stale check, `processing` transition, transient retry and `maxAttempts` failure are unchanged; the switch gains:

- `scan` → `scanFile` (§5.3), then `next('parse')`, or `failed` with a safety reason.
- `parse` → `parseFile` (§5.4), then `next('extract')`, or `failed: unreadable | no_text`.
- `extract`, `promote` → FEAT-012's functions, unchanged except: `extractPage` picks the file prompt for file sources (§5.5); `promoteSource` writes `source: 'file'` for file sources and caps each fact's confidence at its page's OCR confidence (§7 D6).
- On a transient failure exhausted at `scan`, the failure is `scan_unavailable`; at `parse`, `internal` (existing mapping, plus the scanner error).

### 5.3 Scan stage: safety first (KB-11)

`scanFile(zdb, source, files)`, in this order, with nothing parsed before step 5:

1. `head('quarantine', upload_key)`: missing → `failed: upload_missing` (the PUT never happened, or the 24-hour lifecycle removed it). Size over 25 MB → `failed: too_large`, object deleted.
2. `get` the bytes (at most 25 MB in memory).
3. `scanner.scan`: infected → `failed: malware`, the object deleted, audit `kb_source.rejected { reason: 'malware' }` (the signature name is logged, not audited; NFR-11). `ScannerUnavailableError` → transient (rethrown; after `maxAttempts`, `scan_unavailable`).
4. `sniffType(bytes, fileName)` (pure, `sniff.ts`), from the bytes, never from the name:
   - `%PDF-` in the first 1,024 bytes → `pdf`; `89 50 4E 47 0D 0A 1A 0A` → `png`; `FF D8 FF` → `jpeg`.
   - ZIP (`PK 03 04`): read the central directory (`fflate` `unzipSync` with a filter, entry count ≤ 5,000): `word/document.xml` → `docx`; `ppt/presentation.xml` → `pptx`; any entry with the encryption flag → `encrypted`; anything else (including XLSX, which is FEAT-016's) → `unsupported_type`.
   - OLE compound file (`D0 CF 11 E0 A1 B1 1A E1`): with a `.docx` or `.pptx` name it is how Office stores a password-protected file → `encrypted`; otherwise (legacy `.doc`/`.ppt`) → `unsupported_type`.
   - Executables and scripts (`MZ`, `7F 45 4C 46`, Mach-O magics, `#!`) → `unsupported_type`, whatever the name (the renamed-executable criterion).
   - Otherwise, a `.txt` name and bytes that decode as strict UTF-8 (BOM allowed) with no NUL → `txt`; anything else → `unsupported_type`.
   - The sniffed type wins over the extension when both are allowed (a PNG named `.jpg` is read as PNG).
5. PDFs: encryption check with pdf.js (`getDocument` with no password). A `PasswordException`, or any `/Encrypt` dictionary, → `failed: encrypted` (§7 D3). A PDF pdf.js can't open → `failed: unreadable`.
6. Clean: `copyToSources(upload_key, files/<tenant>/<source>)`, then `delete('quarantine', upload_key)`; one transaction sets `file_type`, `file_key`, `scanned_at`, stage `parse` and writes the outbox job. Audit `kb_source.scanned { type, verdict: 'clean' }`.

Every rejection deletes the quarantine object in the same step and writes the failure and one audit entry `kb_source.rejected { reason }` in one transaction; the file never reaches the `sources` bucket and no page or fact exists for it (the EICAR criterion). The scanner adapters:

- **ClamAV** (`clamav.ts`, local and the ADR-019 fallback): a TCP connection to `CLAMAV_HOST:CLAMAV_PORT`, `zINSTREAM\0`, 64 KB chunks with 4-byte lengths, a zero chunk, then the reply: `stream: OK` → clean, `stream: <name> FOUND` → infected, anything else, a timeout (60 s) or a connection error → `ScannerUnavailableError`.
- **GuardDuty** (`guardduty.ts`, MD): GuardDuty Malware Protection for S3 tags each new quarantine object `GuardDutyMalwareScanStatus`. The adapter polls `GetObjectTagging` every 2 s for up to 90 s: `NO_THREATS_FOUND` → clean; `THREATS_FOUND` → infected; `UNSUPPORTED`, `ACCESS_DENIED`, `FAILED` or no tag yet → `ScannerUnavailableError`. It never treats a missing tag as clean.
- `MALWARE_SCANNER=clamav | guardduty` selects one (default `clamav`).

### 5.4 Parse stage (KB-02)

`parseFile(zdb, source, files)` reads the clean file from `sources` and produces pages, written like crawl pages (`kb_source_pages`, attempt, `seq`, `status`, `content` masked with `piiMask` and cut at 50,000 chars, `content_hash`), with the counts on the source (`pagesFound`, `pagesIncluded`, `pagesExcluded`, `pagesSkipped`, `ocr_pages`). Text keeps line breaks (whitespace inside a line is collapsed), so extraction sees a list as a list.

- **PDF** (`pdfjs-dist` legacy build, CMaps and standard fonts from the package so Chinese text layers decode): per page, text items joined, a line break at `hasEOL`. A page with at least 20 non-space characters is `included` (`page/<n>`). A page with less is OCR'd: `rasterizer.render(pdf, n)` → `ocr.recognize` → `included` with `ocr_confidence` if the OCR text has ≥ 20 characters, else `excluded: no_text`. Pages after `FILE_PAGE_LIMIT` (default 200) are `skipped: page_limit` and not read; OCR'd pages after `OCR_PAGE_LIMIT` (default 50) are `skipped: ocr_limit`. OCR runs `OCR_CONCURRENCY` (default 2) pages at a time.
- **DOCX:** `word/document.xml` (and nothing else: headers, footers and comments are left out). Paragraphs (`w:p`) become lines; `w:t` text; `w:tab` a tab; `w:br`/`w:cr` a line break; table cells (`w:tc`) are joined by tabs and rows (`w:tr`) by line breaks. XML entities decoded. The text is split into parts of ≤ 50,000 chars at paragraph boundaries (`part/<n>`).
- **PPTX:** `ppt/slides/slideN.xml` in number order, one page per slide (`slide/<n>`); `a:p` paragraphs, `a:t` text. Speaker notes are left out.
- **TXT:** decoded UTF-8, CRLF normalised, split into parts like DOCX.
- **JPEG, PNG:** OCR of the image as one page (`image/1`).
- **Zip-bomb and size guards:** DOCX/PPTX entries are decompressed with a 100 MB total cap; more → `failed: unreadable`. A file whose XML doesn't parse → `unreadable`.
- **Outcome:** zero `included` pages → `failed: no_text`. Otherwise one transaction moves to stage `extract` with its outbox job.

**Tesseract (`tesseract.ts`):** `tesseract stdin stdout -l eng+chi_sim --psm 3 tsv` with the PNG on stdin (60 s timeout per page). Words are regrouped into lines by `block/par/line`; spaces Tesseract puts between two CJK characters are removed. `confidence` is the mean of word confidences (0–100 → 0..1), weighted by word length; words below 0 are ignored. Failure to run the binary is transient (`OcrUnavailableError`, rethrown). **pdftoppm (`pdf-raster.ts`):** `pdftoppm -f n -l n -r 200 -png` on a temporary file in the job's own temp directory, removed in `finally`.

### 5.5 Extract and promote for files

- `extractPage` takes `{ kind }`: file pages use `FILE_EXTRACTION_SYSTEM`, the website prompt with its first sentence changed to "one page of a document from a Singapore business (a price list, menu, brochure or policy)" and the same rules, schema and checks; the tail is `File: <name>\nPage: <n>` (still the same for every tenant: cacheable). `parseExtraction`'s quote and price checks apply unchanged, so OCR noise that changes a price's digits drops the fact instead of storing a wrong price (D4 of FEAT-012).
- `promoteSource` stores `provenance = { url: 'page/3', title: null, quote, start, end }`, `source: 'file'`, and `confidence = min(model confidence, page OCR confidence)` for OCR pages (D6). Conflicts with facts from other sources are detected as for websites (FEAT-014 D6).
- `withPassages` and the review summary read `kb_sources.name`; the passage lookup by `(source_id, url)` works for locators unchanged.

### 5.6 kb domain functions

- `createFileSource(ctx, { uploadId, fileName, sizeBytes? }, { fileLimit })` (dashboard scope): counts the tenant's file sources (`file_limit_reached` at the limit), refuses a second source for the same `upload_key` (`SourceExistsError`), inserts `kind 'file'`, `name` = file name, `upload_key`, stage `scan`, audit `kb_source.created`, outbox job.
- `retrySource` generalised: a website restarts at `crawl` (unchanged). A file with failure `upload_missing`, `too_large`, `unsupported_type`, `encrypted`, `malware`, `unreadable` or `no_text` throws `NotRetryableError` (409 `not_retryable`): only a new upload fixes those, and its quarantine object is already gone. Otherwise (`scan_unavailable`, `extraction_unavailable`, `internal`) it clears the attempt's pages and staging and restarts at `parse` when `file_key` is set, else at `scan`. A new attempt reads the same stored object.
- `retryable(source)` (exported) gives the contract's `retryable`.
- `deleteSource` (unchanged for websites) also enqueues the purge job for a file (§5.7).
- `toSource` (api) maps `name`, nullable website fields, and `file`.

### 5.7 Deleting a file (KB-07, GOV-05)

`deleteSource` deletes the rows in one transaction as FEAT-012 does and, for a file source, enqueues `{ stage: 'purge', keys: { quarantine: upload_key, sources: 'files/<tenant>/<source>' } }` on the `ingest` topic in the same transaction (ADR-012: side effects through the outbox). The worker handles `purge` before any source lookup (the row is gone) by deleting the quarantine key and the sources object; deleting a missing object is a no-op, so the job is idempotent. A source being scanned or parsed can't be deleted (`processing` → 409, unchanged).

### 5.8 Wiring and configuration

- `packages/contracts`: §3.1 shapes, `UploadRequestBody`, `UploadTicket`, `CreateSourceBody` as a discriminated union, `IngestJob` with the new stages and the purge body.
- `packages/db`: schema and the two migrations (§4).
- `apps/api`: `uploads.ts` (route + `s3UploadSigner` with `@aws-sdk/s3-request-presigner` 3.1152.0); config `QUARANTINE_BUCKET`, `S3_ENDPOINT_URL` (LocalStack locally; unset in AWS), `AWS_REGION`, `FILE_LIMIT` (default 50, D2 Starter, until FEAT-067), `MAX_FILE_BYTES` fixed at 25 MB in code (KB-02; not configurable).
- `apps/ingest-worker`: config `QUARANTINE_BUCKET`, `SOURCES_BUCKET`, `S3_ENDPOINT_URL`, `MALWARE_SCANNER`, `CLAMAV_HOST` (default `127.0.0.1`), `CLAMAV_PORT` (3310), `TESSERACT_PATH` (default `tesseract`), `PDFTOPPM_PATH` (default `pdftoppm`), `FILE_PAGE_LIMIT`, `OCR_PAGE_LIMIT`, `OCR_CONCURRENCY`; health check gains `scanner` (ClamAV `PING`; GuardDuty: always healthy) and `ocr` (`tesseract --list-langs` includes `eng` and `chi_sim`, checked once at start). Logs: source ID, stage, verdict, type, page counts, OCR confidence; never file names or text (NFR-11).
- `.env.example` for both roles, `gen-local-env.mjs` values for both; `docker-compose.yml`: ClamAV leaves the `ingest` profile (it is needed by the ingest worker from now on) and gets a health check (`clamdcheck.sh`); `02-buckets.sh` creates the two buckets.
- **Image:** the Dockerfile's ingest-worker stage installs `tesseract-ocr`, `tesseract-ocr-eng`, `tesseract-ocr-chi-sim` and `poppler-utils` from Debian.
- **Terraform** (written and validated, not applied): quarantine bucket CORS for the app origin (PUT only); `aws_guardduty_malware_protection_plan` on the quarantine bucket with object tagging, and its IAM role; api task policy `s3:PutObject` on `quarantine/uploads/*`; ingest-worker task policy `s3:GetObject`, `s3:GetObjectTagging`, `s3:DeleteObject` on quarantine and `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on sources; the bucket names in both tasks' environment; `MALWARE_SCANNER=guardduty` on the ingest-worker task.
- **CI:** the integration job installs `tesseract-ocr tesseract-ocr-chi-sim poppler-utils` (apt); the e2e job too, since `pnpm dev` runs the ingest worker; `docker compose up -d --wait` now starts ClamAV.

### 5.9 Test fixtures

`apps/ingest-worker/fixtures/files/`: committed small binaries produced once by `fixtures/files/generate.ts` (Chromium for the PDFs and images, `qpdf` for the encrypted PDF, `fflate` for DOCX/PPTX; the script is kept so they can be regenerated): `price-list.pdf` (3 text pages with the fake extractor's patterns: products, an FAQ, a refund policy, a promotion), `scanned-menu.pdf` (2 image-only pages with prices, OCR), `menu-photo.png` and `menu-photo.jpg` (OCR), `chinese-notice.png` (simplified Chinese text, OCR `chi_sim`), `faq.docx`, `promo.pptx` (3 slides), `policies.txt`, `protected.pdf` (user password), `protected.docx` (an OLE container as Office writes it), `blank.png` (no text), `program.pdf` (an ELF header named `.pdf`). The EICAR file is never committed: tests build it from two string halves at run time, so no checkout trips a virus scanner.

## 6. Acceptance criteria

- **AC-1 (KB-02; UC-03 6).** `POST /api/v1/kb/uploads` for each allowed extension returns a presigned PUT that stores the object under `uploads/<tenant>/<uploadId>` in the quarantine bucket; `POST /api/v1/kb/sources { kind: 'file', uploadId, fileName, sizeBytes }` returns 201 with `queued` at stage `scan`, an audit `kb_source.created` with no file name, and one `ingest` outbox job. An unknown extension returns 400 `unsupported_type`; over 25 MB 400 `file_too_large`; the same `uploadId` twice 409 `source_exists`; at `FILE_LIMIT` file sources 409 `file_limit_reached`; an `agent` session 403. Nothing is written by `POST /uploads`.
- **AC-2 (KB-11).** The EICAR test file, uploaded as `test.pdf`, fails `malware`: it is deleted from quarantine, never copied to `sources`, and the source has zero pages, staged rows and facts; the extractor and the OCR engine were never called. Audit `kb_source.rejected { reason: 'malware' }`.
- **AC-3 (KB-11).** An executable renamed `menu.pdf` (ELF and PE headers) fails `unsupported_type` and is never parsed. A password-protected PDF and a password-protected DOCX fail `encrypted`. An XLSX or a ZIP of images fails `unsupported_type`. A `.txt` holding binary bytes fails `unsupported_type`. A PNG named `.jpg` is read as an image. Each rejection deletes the quarantine object.
- **AC-4 (KB-02; text formats).** `price-list.pdf`, `faq.docx`, `promo.pptx` and `policies.txt` each end `ready` with one page per PDF page or slide (or part), every page's `content` equal to its text (masked), and the fake extractor's facts as `needs_review`, `source 'file'`, with provenance `location` (`page 2`, `slide 3`, `part 1`) whose `quote` equals `content.slice(start, end)`.
- **AC-5 (KB-02; OCR, English and Chinese).** `scanned-menu.pdf`, `menu-photo.png` and `menu-photo.jpg` are read by OCR with `ocr_confidence` set and `ocr_pages` counted; their product names and prices are extracted as facts whose confidence is at most the page's OCR confidence. `chinese-notice.png`'s page content contains its Chinese sentence (character accuracy ≥ 90% against the fixture text). `blank.png` fails `no_text`.
- **AC-6 (KB-12, NFR-17).** A file source moves `queued → processing (scan → parse → extract → promote) → ready` with matching counts. With the scanner unavailable, it shows `queued` at stage `scan` between redeliveries and fails `scan_unavailable` after `INGEST_MAX_ATTEMPTS` with nothing stored; retry then runs it from `scan` and ends `ready`. With the extractor throwing, it fails `extraction_unavailable` with zero facts; retry runs from `parse` using the stored file. Retry on a `malware`, `encrypted`, `unsupported_type` or `no_text` source returns 409 `not_retryable`. A duplicate or stale job changes nothing.
- **AC-7 (KB-07 documents, GOV-05).** Deleting a ready file source removes its rows and facts as in FEAT-012 AC-9 and, through the purge job, its `sources` object and its quarantine key; running the purge job twice succeeds.
- **AC-8 (ADR-005).** RLS: tenant B sees and changes none of tenant A's file sources or their pages in any zone; a source can't be created for another tenant's upload (the key is built from the session's tenant).
- **AC-9 (NFR-16).** On the local stack (fake provider, ClamAV, Tesseract), each fixture file is `ready` within 3 minutes of `POST /sources`, and a 25 MB PDF (200 text pages and 10 scanned pages) is `ready` within 3 minutes. Times are logged as measured; re-measured with the real model and GuardDuty at MD.
- **AC-10 (UC-03 6, 4a; E2E; NFR-19, NFR-09).** In the browser, the owner opens Add sources, chooses `price-list.pdf` and `menu-photo.png`, sees each upload's progress and then a row that goes Queued → Processing → Ready, opens the PDF's source page and sees its pages ("Page 1 · Read"), opens a fact and sees "From page 1 of price-list.pdf". An EICAR file shows Failed "This file contains malware…" with no Retry. A 26 MB file is refused in the browser before upload. No serious axe violations on SCR-APP-007, -023 or -024.

## 7. Decisions

- **D1 — A file is a KB_SOURCE with two more stages; its parts are pages.** Driver: ADR-018 d1–d3 and FEAT-012 D1. Writing a file's pages into `kb_source_pages` lets the extract and promote stages, review passages, conflicts, retry and delete work unchanged. Rejected: a separate `kb_files` table (a second source model for every consumer to join).
- **D2 — Presign first, create the source after the upload.** Driver: no source row for an upload that never happens, and the quarantine key built from the session's tenant (ADR-005: tenant from a trusted source). The size is signed into the URL and checked again by the worker. Rejected: creating the source before the PUT (orphan `queued` sources) or uploading through the api (25 MB bodies through Fastify, ADR-018 d2 says presigned).
- **D3 — Any encrypted PDF is refused, including permission-only ones.** Driver: KB-11 "encrypted or password-protected files are rejected", and an encrypted stream is harder to scan. The failure text tells the owner to save an unprotected copy. Rejected: accepting PDFs that open without a password (they still carry `/Encrypt`).
- **D4 — pdf.js for text, `pdftoppm` for rendering scanned pages, the `tesseract` CLI for OCR.** Driver: ADR-018 d3 (pdf.js text layer), ADR-019 (Tesseract 5 `eng+chi_sim`, a native binary called from TypeScript). pdf.js can't rasterise in Node without a native canvas package; poppler is a Debian package like Tesseract. Rejected: `tesseract.js` (WASM with downloaded language data at run time, slower), Textract (no Chinese, ADR-019).
- **D5 — Content decides the type.** Driver: KB-11 "by content type, not just extension". Only TXT, which has no magic number, needs the extension, and only with strict UTF-8. The extension list at presign time is a convenience check for a clear early error, not the safety check.
- **D6 — OCR confidence caps a fact's confidence.** Driver: ADR-019's mitigation for moderate Chinese OCR ("showing OCR confidence on review"). The review card already marks confidence below 70%, so a doubtful scan shows up there without a new field. The page's own confidence is on SCR-APP-024.
- **D7 — Safety failures aren't retryable.** Driver: the quarantined file is deleted on rejection, and retrying an infected or encrypted file can't change the answer. KB-12's retry action is "Upload again" for those (ui-design). Transient failures keep Retry.
- **D8 — Page and OCR caps per file.** Driver: NFR-16's 3 minutes for 95% of files. 200 pages and 50 OCR pages keep a 25 MB file within budget at about 1.5 s per OCR page on two workers; pages over the caps are listed as skipped, not silently dropped (KB-12 spirit). Revisit with FEAT-067's plan limits.
- **D9 — ClamAV runs in the default local stack.** Driver: from this feature on, the ingest worker can't finish a file without a scanner. The compose `ingest` profile is removed rather than asking every `pnpm stack:up` to add it.

## 8. Escalations and open items

- **No architecture amendment.** Files are KB_SOURCE (ADR-018 d2); pages are its parts (FEAT-012 D1); the buckets and scanner are ADR-018/ADR-019's.
- **GuardDuty availability:** ADR-019 left GuardDuty Malware Protection for S3's ap-southeast-1 availability unconfirmed. The Terraform plan resource is written; `initial-deployment` confirms availability and sets `MALWARE_SCANNER=clamav` with a ClamAV task if it isn't offered. Pending MD.
- **Real-model extraction from files (AC-4's facts):** measured on the fake provider; the extraction eval subset gains two file-page cases (an OCR'd price list and a DOCX FAQ) so the M1.5 run covers file text. "Real-model check pending" as in FEAT-012 §0.
- **Images inside DOCX/PPTX** (a photo of a menu pasted into Word) aren't OCR'd. Plan correction not needed; recorded as a KB-02 limitation and in the UI help text ("Text in pictures inside Word or PowerPoint files isn't read").
- **File plan limit:** `FILE_LIMIT` from config until FEAT-067 (as FEAT-012 D8).
- **Tenant deletion (AUTH-07)** must delete the tenant's `files/<tenant>/` and `uploads/<tenant>/` prefixes; noted for FEAT-010.
- **Owner e-mail alert on failure** stays with FEAT-052 (FEAT-012 §8).
- **Spreadsheets (FEAT-016) and chat exports (FEAT-017)** reuse `POST /uploads` and the scan stage; their parsers and screens are theirs. XLSX and CSV are `unsupported_type` until then.

## 9. Self-check

Requirement coverage: KB-02 → AC-1, AC-4, AC-5, AC-9, AC-10. KB-11 → AC-2, AC-3, AC-10. KB-05 (p) → AC-4, AC-5. KB-12 (p) → AC-6, AC-10. KB-07 documents (p), GOV-05 (p) → AC-7. KB-16 → AC-4 (`needs_review`). UC-03 6, 4a → AC-10; UC-10 1–2, 2a → AC-1, AC-3. NFR-06 → AC-2; NFR-16 → AC-9; NFR-17 → AC-6; NFR-11 → §5.3 audit payloads and §5.8 logs; NFR-07 → §4 object storage (ap-southeast-1 buckets only); NFR-19, NFR-09 → AC-10; ADR-005 → AC-8. E2E obligation: UC-03 and UC-10 are in J1 (architecture §8.7); this feature completes UC-03 step 6 for files → T13 adds `files.e2e.ts`. IDs checked: KB-02/05/07/11/12/16, GOV-05, UC-03/10/11, SCR-APP-007/019/023/024/028, ADR-005/012/015/018/019, NFR-06/07/09/11/16/17/19, D2 all resolve. Schema changes are on KB_SOURCE and FACT only. Contracts keep `/api/v1`, `{ error, message }` and `version`. Breaking changes to FEAT-012's `Source` contract (four fields nullable, `name` from a column) are additive for websites and the dashboard is the only consumer, updated in the same PR.
