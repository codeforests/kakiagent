# Acceptance Report: FEAT-015 — File upload with content-type and malware checks; parsing and Tesseract OCR

> Verdict: **Accepted** (first verification; KB-02 and KB-11 get a full Test ref) · Date: 2026-10-23
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-10) @ `1da991e` · Sources: SRS v0.4 (KB-02, KB-11; KB-05, KB-07, KB-12, KB-16 and GOV-05 in the parts this feature extends to files; NFR-06, NFR-16, NFR-17), use-cases v0.4 (UC-03 6 and 4a, UC-10 1–2 and 2a), ADR-005, ADR-018, ADR-019
> Repo state audited: `b959232` (implementation head `2f96e58` plus one test-correction commit)

## Verdict summary

FEAT-015 is accepted. Every criterion from AC-1 to AC-10 now has a test that asserts what the criterion says, and every suite was observed green in this run.

Four test artifacts asserted less than their criteria and were corrected in `b959232`:

- **AC-4:** only a PDF ran through the pipeline, with every fact on page 1.
- **AC-3:** three of the rejection cases were only checked at unit level.
- **AC-6:** the `processing` status was never asserted.
- **AC-10:** the "Read" result of the PDF's page was not checked.

The corrected tests pass against the code. A mutation check (a `fileLocator` that always says "page") turned the new AC-4 cases red.

There are no rework or design-defect findings. Two minor findings are recorded below; neither blocks acceptance.

This verification ran in the same session as the implementation. Its standard was re-derived from KB-02, KB-11, UC-03 and UC-10 and from design §6, not from tasks.md.

## Audit standard

- **KB-02 (M):** "File upload: PDF, DOCX, PPTX, TXT, images (JPG/PNG, OCR), up to 25 MB each." Acceptance: "Text is extracted, including scanned PDFs through OCR. English and Chinese text supported."
  - The types are covered by AC-1 and AC-4.
  - The 25 MB limit is checked at three points: in the browser, by the API, and at the scan stage (AC-1, AC-10).
  - OCR of scanned PDFs and images is AC-5, which also covers Chinese, at ≥ 90% character accuracy.
  - Faithful.
- **KB-11 (M):** "every uploaded file is checked by content type (not just extension) and scanned for malware before processing. Encrypted or password-protected files are rejected with a reason." Acceptance: "An EICAR test file is rejected and never processed or indexed. A renamed executable is rejected."
  - Malware is AC-2. It goes beyond the statement: the file is never stored, parsed, OCR'd or extracted, and has zero pages and facts.
  - Content type over extension, encryption and renamed executables are AC-3.
  - The reason is shown to the owner (AC-10).
  - Faithful.
- **UC-03 6 (adds files), 4a (no website, skip to files):** AC-10. The setup link reads "Skip for now" and leads to the files part.
- **UC-10 1–2, 2a:** UC-10 is the spreadsheet use case (FEAT-016). This feature delivers its shared steps:
  - Steps 1–2, the upload and the checks: AC-1 to AC-3.
  - Exception 2a, unsafe or encrypted files rejected with a reason: AC-2, AC-3, AC-10.
  - XLSX is refused as `unsupported_type` until FEAT-016, which is consistent with the plan.
- **Parts this feature extends to files:**
  - KB-05 provenance (every entity links to its document and location): AC-4. Location is page, slide or part.
  - KB-16 `needs_review`: AC-4.
  - KB-12 states, reasons and retry: AC-6.
  - KB-07 and GOV-05 deletion of documents: AC-7.
  - These requirements' Plan ref is other features (FEAT-011, FEAT-012), so this report doesn't add their Test refs.
- **NFRs:**
  - NFR-16 (95% of files ≤ 25 MB ready within 3 minutes) is AC-9.
  - NFR-17 (dependency down → queued and retried, then failed) is AC-6, with the scanner as the dependency.
  - NFR-06 malware protection is AC-2.
- **Gaps in the standard:** none found. KB-12's "the owner is alerted when a source they added fails" is not in this feature's criteria. That is consistent with FEAT-012's report, which left owner alerts to FEAT-044, and is not a gap here.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | KB-02, UC-03 6 | `apps/api/test/uploads.int.test.ts` (presign, every refusal, 201 at `scan`, audit without name, one job, 409s, 403, a real PUT to LocalStack under the session tenant's prefix) | faithful | green |
| AC-2 | KB-11, NFR-06 | `packages/kb/test/files.int.test.ts` "rejects the EICAR test file…"; `apps/ingest-worker/test/files.int.test.ts` (real ClamAV finds EICAR, scan stage deletes it) | faithful | green |
| AC-3 | KB-11, UC-10 2a | `sniff.test.ts`; `packages/kb/test/files.int.test.ts` "rejects %s…" (ELF, PE, protected PDF, OLE DOCX, binary TXT, **XLSX, image ZIP added**) and "reads a PNG named .jpg as an image" (**added**); ingest-worker fixtures `program.pdf`, `protected.pdf`, `protected.docx` | was partly unit-only → corrected | green |
| AC-4 | KB-02, KB-05, KB-16 | `packages/kb/test/files.int.test.ts` "reads %s (%s) to ready…" (**added**: PDF page 2, PPTX slide 3, DOCX and TXT part 1); ingest-worker parse of the real fixtures | was PDF and page 1 only → corrected, mutation-checked | green |
| AC-5 | KB-02 (OCR, Chinese) | ingest-worker `files.int.test.ts` (real Tesseract on `scanned-menu.pdf`, `menu-photo.png`/`.jpg`, `chinese-notice.png` ≥ 90%); kb "OCRs an image… caps each fact's confidence" (fake model 0.9, OCR 0.6, facts 0.6) | faithful | green |
| AC-6 | KB-12, NFR-17 | kb `files.int.test.ts` scanner-down, extractor-down, stale-job and **processing-per-stage (added)** cases; `sources.int.test.ts` retry rules; api `uploads.int.test.ts` 409 `not_retryable` for all seven failures | `processing` unasserted → corrected | green |
| AC-7 | KB-07, GOV-05 | kb `sources.int.test.ts` "deletes a file source and writes the purge job…"; kb `files.int.test.ts` purge twice; api delete test; ingest-worker S3 store delete against LocalStack | faithful | green |
| AC-8 | ADR-005 | `packages/db/test/rls.int.test.ts` file-source cases in every zone; api "can't name another tenant's upload" | faithful | green |
| AC-9 | NFR-16 | measured on the local stack (below) | measured, indicative | within bound |
| AC-10 | UC-03 6, 4a; NFR-19, NFR-09 | `e2e/tests/files.e2e.ts` (2 tests; **"Read" result and no Pages section for an image added**) | partly unasserted → corrected | green |

## Corrected tests

All in `b959232`. Each one moves a test toward its criterion, and none loosens an assertion.

- **AC-4:** four new pipeline cases (PDF, PPTX, DOCX, TXT), each to `ready`. Each case asserts:
  - three `needs_review` facts with source `file`;
  - provenance `page/2`, `slide/3` or `part/1`;
  - a quote equal to `content.slice(start, end)`;
  - the page content equal to the text.

  With `fileLocator` mutated to always emit `page/N`, the PPTX, DOCX and TXT cases failed. The PDF case kept passing, as expected, and the mutation was then reverted.
- **AC-3:**
  - An XLSX named `.docx` and a ZIP of images named `.pptx` now go through the scan stage to `unsupported_type`, with quarantine emptied.
  - A PNG named `menu.jpg` is read as `png` and OCR'd to `ready`.
- **AC-6:** asserts `queued`/`scan`, then `processing` at `parse`, `extract` and `promote`, then `ready`.
- **AC-10:**
  - The first page row's chip reads "Read".
  - The photo's source page has no Pages table. ui-design SCR-APP-024 hides it for an image, and the status card's "1 read with OCR" summarises the page.
  - A first draft of this correction expected a "Read with OCR" row on the photo's page. It failed, which revealed that the draft contradicted the UI design, and was replaced.

## Independent execution

- The dev servers were stopped and restarted by `pnpm test:e2e`, so no process from the implementation was reused. Exception: the static fixture site on :5176 was still running.
- `pnpm stack:reset` was not run: it wipes local data, and the session's permissions refused it. The integration suites start their own databases with Testcontainers, so migrations ran on fresh stores; `pnpm db:setup` was re-run on the local database.
- The following were observed green:
  - `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser) and `pnpm typecheck`.
  - `pnpm test` (all unit suites).
  - `pnpm test:coverage` (unit and integration, at the per-package thresholds): kb 226, api 176, ingest-worker 48, db 96, agent 345 and platform 266 tests, all passed.
- The whole E2E suite ran with `pnpm test:e2e --project=chromium`: 36 passed and 1 failed. The failure was the corrected AC-10 draft described above. After the fix, `files.e2e.ts` and `sources.e2e.ts` re-ran and all 4 tests passed.
- Firefox and WebKit are not installed in this environment; CI runs all three engines.
- Flakiness was observed during implementation, before this audit, and is recorded as minor finding 1:
  - The zip-bomb unit test built 100 MB with fflate and timed out under parallel load and coverage.
  - It was fixed in T14 by building the same entry with zlib, with the assertions unchanged.
  - It passed in every run of this audit.
- Test-diff review: changes to tests from earlier features are mechanical.
  - The new non-null `name` column was added to fixture inserts.
  - `IngestJobBody` became `StageJobBody` where the purge body doesn't apply.
  - `sources.e2e.ts` follows the "Add website" → "Add sources" rename that ui-design specifies.
  - There are no new `.skip`, `.only` or `.todo` markers, and no coverage configuration changed.

## Direct verification

- **Audit and side effects:**
  - The AC-2 test reads `audit_entries` directly: `kb_source.rejected { reason: 'malware' }`, with no signature in any entry.
  - The AC-1 test checks that `kb_source.created` carries no file name (NFR-11).
  - The quarantine and sources buckets are inspected after every rejection.
- **NFR-16 (AC-9), indicative, on the local stack (fake provider, ClamAV, Tesseract 5, one ingest worker):**
  - T14's timing run measured the time from source creation to the final state:
    - every fixture took under 25 s (`scanned-menu.pdf` was slowest at 21.0 s, with 2 OCR pages);
    - a 24.4 MB PDF of 200 text pages and 10 scanned pages was ready in 69.7 s.
  - This audit observed the same path in the browser: `price-list.pdf` and `menu-photo.png` went from upload to Ready inside the 25.5 s E2E test. That figure includes a deliberate 1.5 s hold on each PUT.
  - Both are well within 3 minutes.
  - **Pending environment:** with the real model (Bedrock) and GuardDuty Malware Protection for S3, whose scan adds its own latency, at milestone MD. The scaffold notes list it.
- **Screens:**
  - axe ran on SCR-APP-007, -023 and -024 in `files.e2e.ts` with no serious violations.
  - The new dashboard CSS uses only `var(--…)` tokens; the only raw values are the 1px borders that `app.css` already uses 30 times.
  - The states in the manifest that the E2E renders all appear: upload progress, refused before upload, Ready, Failed for malware with "Upload again" and no Retry, file rows, and page labels.
- **Contracts:** responses match design §3, including the `{ error, message }` envelope, `fileLimit` and `maxFileBytes` on the list, and `not_retryable`. The recorded deviation of `AWS_ENDPOINT_URL` instead of a new `S3_ENDPOINT_URL` is in tasks.md's notes.

## Findings

- **Rework:** none.
- **Design defect:** none.
- **Minor:**
  1. **The zip-bomb unit test was flaky** (timeouts under parallel load and coverage). It was fixed during T14 without changing its assertions, and it passed in every run here. Recorded so that a later failure isn't read as new.
  2. **AC-9's example file is over D8's page cap.** The example PDF has 200 text pages and 10 scanned pages, 210 pages in all, above the 200-page cap. The measured file was ready with the 10 pages past the cap listed as skipped, as D8 says. The criterion's wording should say "up to 200 pages" when the design is next amended. The bound itself holds.

## RTM

Test ref appended: KB-02 and KB-11 → `features/FEAT-015-file-upload/acceptance-report.md`, full, because FEAT-015 is each row's only Plan ref. KB-05, KB-07, KB-12, KB-16 and GOV-05 aren't planned to this feature, so their rows are unchanged. NFR-16 and NFR-06 stay with their M6 and MD verification, as for FEAT-012.
