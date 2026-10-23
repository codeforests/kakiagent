# UI Design: FEAT-015 — File upload with content-type and malware checks; parsing and Tesseract OCR

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-007 (extended: the files part), SCR-APP-023 (extended: file rows), SCR-APP-024 (extended: a file's extraction), SCR-APP-028 and SCR-APP-019 (extended: file provenance) · Mode: per-feature · Status: Verified · Date: 2026-10-23

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so every change here is a code-native spec on top of FEAT-012's. Every value comes from design.md and `tokens.json`. No new component or token is introduced: the file chooser is a native file input behind a `secondary` button inside a `card`, and every other element is one FEAT-012 already uses.

## Cross-screen

- **Source icon:** websites keep the globe; files get a document icon (the same 20 px line icon style, `currentColor`); images (JPEG, PNG) get a picture icon.
- **File type labels** (`file.type`): pdf "PDF", docx "Word document", pptx "PowerPoint", txt "Text file", jpeg "JPG image", png "PNG image". Before the scan has named it, the label comes from the extension.
- **Sizes:** "2.4 MB", "820 KB" (one decimal place in MB, none in KB; 1 MB = 1,048,576 bytes, matching the 25 MB limit).
- **Stage names** add: scan → "Checking the file", parse → "Reading the file". extract and promote keep FEAT-012's "Finding facts" and "Saving facts".
- **Failure reasons** (`failure` → text) add:
  - `upload_missing`: "The upload didn't finish, so there's nothing to read. Upload the file again."
  - `too_large`: "This file is over 25 MB. Upload a smaller file, or split it."
  - `unsupported_type`: "This isn't a file type we can read. Upload a PDF, Word, PowerPoint, text, JPG or PNG file." (also for renamed programs; the message never says what the bytes were)
  - `encrypted`: "This file is password-protected or encrypted. Save a copy without a password and upload that."
  - `malware`: "This file contains malware, so we deleted it without reading it. Check your computer with antivirus software."
  - `scan_unavailable`: "We couldn't check this file for malware just now. Try again in a few minutes."
  - `unreadable`: "This file seems damaged and couldn't be read. Open and save it again, then upload the copy."
  - `no_text`: "We couldn't find any text in this file, even in its images. Upload a clearer scan or a text version."
- **Retry or upload again:** when `retryable` is true, a failed file has Retry, as a website does. When it is false, it has a `secondary sm` link-button "Upload again" to `/knowledge/sources/new#files` instead (technical design D7). KB-12's "retry action" is that link for files that need a new upload.
- **Page labels** for file pages (from `provenance.location` / the page locator): page "Page 3", slide "Slide 2", part "Part 1", image "Image".
- **Page reasons** add: included with `ocrConfidence` "Read with OCR · 82% confidence" (below 70%: warning text with the `!` icon, as on SCR-APP-028); excluded `no_text` "Excluded: no text found"; skipped `page_limit` "Skipped: over the 200-page limit"; skipped `ocr_limit` "Skipped: over the limit of 50 scanned pages". (The limits come from the source counts' context; the numbers are the configured defaults, so the text names them directly.)
- Polling, live-region announcements and dates as in FEAT-012.

## SCR-APP-007 — Add your sources (extended: files part)

- **Strategy and source:** code-native (this section, on top of FEAT-012's website part). Routes unchanged: `/knowledge/sources/new` (page head changes from "Add website" to **"Add sources"**, back link "Sources") and `/setup/sources`. The page has two sections in order: **Your website** (FEAT-012's `AddWebsiteForm`, unchanged, under a `subsection-title`) and **Files** (`AddFilesForm`, anchor `#files`). On `/setup/sources`, the `ghost` "Skip, I'll add files later" becomes "Skip for now" (UC-03 4a now has files on the same page).
- **Composition of the Files section:**
  1. `subsection-title` "Files", then body-sm help text: "PDF, Word (.docx), PowerPoint (.pptx), text (.txt), JPG or PNG, up to 25 MB each. Scanned pages and photos are read with OCR, in English and Chinese. Text in pictures inside Word or PowerPoint files isn't read."
  2. A `card` (the drop area) holding a `secondary` button "Choose files" (a visually hidden `<input type="file" multiple accept=".pdf,.docx,.pptx,.txt,.jpg,.jpeg,.png">` labelled by the button) and caption text-secondary "or drop them here". While a file is dragged over it, the card's border uses `--color-accent-default` and its background `--color-accent-soft`; drop is optional (keyboard and screen-reader users use the button).
  3. Caption text-secondary: "Every file is checked for malware before we read it. Your plan holds up to {fileLimit} files; you've added {n}." ({fileLimit} from `GET /api/v1/kb/sources`, {n} = file sources in the list.)
  4. **Upload list** (a `list`, newest at the bottom) with one row per chosen file: document or picture icon, file name (truncated with the full name in `title`), size in caption, and its state on the right:
     - checking in the browser → nothing (instant);
     - refused in the browser (wrong extension, over 25 MB, empty, or the file limit reached) → danger caption under the name, with no upload: "Not a file type we can read", "Over 25 MB", "This file is empty", "Your plan's file limit is reached";
     - uploading → a determinate `progress` bar with "Uploading 42%";
     - added (201) → the source's `status-badge` (Queued…) and a `link` "View" to SCR-APP-024; from then on the row follows the source through polling until Ready or Failed (with the reason text);
     - upload failed (network, 4xx/5xx from the presign, the PUT or the create) → danger caption "Upload failed" and a `ghost sm` "Try again" for that file.
  5. Files upload two at a time; the rest wait with "Waiting to upload".
- **Content and data mapping:** per file: `POST /api/v1/kb/uploads { fileName, sizeBytes }` → `PUT url` (XHR, for upload progress, with the returned `headers`) → `POST /api/v1/kb/sources { kind: 'file', uploadId, fileName }`. Errors: 400 `unsupported_type` and `file_too_large` show the browser messages above; 409 `file_limit_reached` shows "Your plan's file limit is reached" and stops the queue; 409 `source_exists` (a double submit) is treated as added.

### default
The help text, the drop card and the plan line; no upload list.
### uploading
Rows with progress; the "Choose files" button stays enabled to add more. Leaving the page while a file is uploading asks the browser's own "Leave site?" prompt (`beforeunload`); files already added keep going in the background.
### added
Rows show the source state and "View". A polite live region announces "menu.pdf added. We'll check it and read it." once per file, and the FEAT-012 announcements when a file is ready or failed.
### refused
Browser-side refusals as above, announced in the live region ("menu.zip can't be uploaded: not a file type we can read.").
### limit
At the file limit the button is still enabled (so the rule is announced, not hidden); choosing files adds refused rows with "Your plan's file limit is reached".
### error
Per-row "Upload failed" with "Try again", as above.

- **Responsive notes:** single column, max width 560 px, like the website form. Below 640 px the "Choose files" button is full width and the drop caption is hidden (touch devices don't drag files).
- **Decisions:** the website and files forms are separate sections, not tabs, because UC-03 6 expects both on one step. The drop card is a `card` with focus-style border colours, not a new component.

## SCR-APP-023 — Sources (extended: file rows)

- **Strategy and source:** code-native (on top of FEAT-012's spec).
- **Composition changes:**
  - Page head: the button "Add website" becomes **"Add sources"** (→ `/knowledge/sources/new`). Help text: "Websites and files you add are read page by page. The facts we find wait for your review before your assistant uses them."
  - File rows: document or picture icon; name = file name; meta "Uploaded 23 Oct 2026, 2:30 pm · PDF · 2.4 MB".
  - Progress while processing: scan and parse indeterminate; extract and promote as FEAT-012.
  - Counts: Ready "12 facts · 12 need review · 8 pages read" (+ " · 3 by OCR" when `ocrPages` > 0; slides say "slides", text files "parts", images nothing after the facts). Ready with no facts "No facts found · 8 pages read". Failed: the reason text, then Retry or "Upload again" (cross-screen).
- **States:** unchanged list (default, loading, empty, error, processing, failed, permission). The empty state's text becomes "Add your website or upload files, and we'll find your products, prices and policies for you to review." with [Add sources].

## SCR-APP-024 — Source (extended: a file's extraction)

- **Strategy and source:** code-native (on top of FEAT-012's spec). Route unchanged.
- **Composition for a file source:**
  - Title: the file name; under it in caption: "{type label} · {size} · Uploaded {date}" (no external link, no attestation line). When `file.scannedAt` is set: a success-tone caption with a check icon "Checked for malware: none found".
  - Status card: as FEAT-012, with the stage names above; ready figures "Facts found", "Need review", and "Pages read" ("Slides read", "Parts read", or omitted for an image), with "{n} read with OCR" under the last figure when `ocrPages` > 0. Failed: the reason in a danger `alert` with Retry or "Upload again".
  - **Pages** section (title "Slides" for PowerPoint, "Parts" for Word and text, hidden for an image, whose single row is summarised in the status card): the same filter and `table`, columns Page (the page label; no URL, no link), Result (the page reason text with its chip: Read success, Read with OCR success, Excluded neutral, Skipped warning), Facts.
  - When pages were skipped: info `alert` "{n} pages were skipped. We read up to 200 pages per file and 50 scanned pages."
  - Footer: `danger-ghost` "Delete file…".
- **States:** processing, ready, failed, loading, error, not-found, filtered-empty as FEAT-012. A file rejected by the scan has no pages: the Pages section shows "No pages were read." under the failed alert.
- **delete-confirm:** title "Delete {file name}?"; body "Its {facts} facts will be deleted too, including any you approved or edited, and your assistant stops using them straight away. The file is deleted from our storage. This can't be undone."; buttons and outcomes as FEAT-012.

## SCR-APP-028 — Fact and SCR-APP-019 — Review · Facts (extended: file provenance)

- **Strategy and source:** code-native (on top of FEAT-012's provenance section and FEAT-013's review card).
- **Change:** when `provenance.location` is set, the "From …" line reads "From {page label, lower-case: page 3 / slide 2 / part 1 / the image} of {source name}" as plain text (no external link, no ↗), followed by the confidence and "Open source" link as before. The review card's source line uses the same words where it showed the short URL. Websites are unchanged.
- **States:** unchanged.

## Manifest and gaps

- SCR-APP-007, -023, -024 keep `feature: FEAT-012` and gain this file in `source.extended_by`. 007's gap "files, spreadsheets, chat exports (FEAT-015..017)" becomes "spreadsheets, chat exports (FEAT-016, FEAT-017)", and its covered states gain the files part's: uploading, added, refused, limit. 024's gap "a file's extraction (FEAT-015)" is closed. SCR-APP-028 and SCR-APP-019 gain this file in `extended_by`.
- No design-system escalation: `card`, `secondary` button, `progress`, `list`, `status-badge`, `alert`, `table`, `confirm-dialog` and the live-region pattern are all in design.md.
