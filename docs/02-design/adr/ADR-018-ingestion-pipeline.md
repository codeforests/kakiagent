# ADR-018: Ingestion pipeline — quarantine, parse, extract, stage, promote

**Status:** Proposed (awaiting product-owner sign-off)
**Date:** 2026-10-19
**Requirements addressed:** KB-01, KB-02, KB-03, KB-04, KB-05, KB-06, KB-08, KB-11, KB-12, KB-13, KB-15, KB-16, ONB-04, NFR-16, NFR-17, NFR-19, GOV-04, CHN-09, CHN-04, DSH-04, UC-03, UC-10, UC-11, UC-14

**Context**
Sources are website crawls (JavaScript-rendered pages, robots.txt, authorised domains only, plan page limits), files (PDF, DOCX, PPTX, TXT, JPG/PNG with OCR in English and Chinese, ≤ 25 MB), spreadsheets with mapping, and chat exports whose visitor PII must be redacted and whose original file must be deleted after mining. Every file is checked by content type and malware-scanned before processing (KB-11). A failed source must never leave partial entities live (KB-12). Throughput targets: 95% of files ready in 3 minutes, a 200-page crawl in 15 minutes, a 500-row spreadsheet in 1 minute (NFR-16), and a 30-page site's draft KB in ≤ 5 minutes (ONB-04).

**Decision**
1. **Source state machine** (`queued → processing → ready | failed`, with a reason and a retry action) in `kb_sources`. Every stage is an idempotent SQS job (ADR-012) keyed by `(source_id, stage, attempt)`.
2. **Files** are uploaded by presigned PUT to a **quarantine bucket** (no read access for application roles except the scanner pipeline; 24-hour lifecycle backstop). Stage *Safety*: malware scan (ADR-019), magic-byte content-type detection (a renamed executable fails), rejection of encrypted or password-protected files, size limits. Only clean files are copied to the `sources` bucket.
3. **Parse:** PDF text layer (pdf.js); for pages without text, render and **OCR with Tesseract 5 (`eng+chi_sim`)** inside the ingest worker (ADR-019). DOCX/PPTX via XML parsers, XLSX/CSV via SheetJS. Each passage keeps provenance (source, page, character range).
4. **Crawl:** Playwright Chromium in the ingest worker; starts only with a recorded KB-13 attestation; obeys robots.txt; same-domain plus listed subdomains; plan page cap, with extra pages reported as "skipped: plan limit"; 4 concurrent pages per tenant and 40 platform-wide, autoscaled on queue age; content-hash per page for re-crawl diffs (KB-08).
5. **Extract (KB-05):** Sonnet 5.5 with **structured outputs** (a JSON schema per entity type: Product/Service, Price with currency, unit, GST flag and validity, Policy, FAQ, Hours/Location, Promotion), batched by page, each entity carrying its source span and a confidence. Spreadsheets bypass the LLM: mapped rows become entities deterministically, and confirmed import rows are created as approved (KB-03, D11).
6. **Normalise and detect conflicts (KB-06):** entity keys (SKU; normalised name and variant; policy type) are matched against existing facts. Differing values produce `conflicted` facts with both sources and their dates (KB-17 "suggest newer"). GST-registered tenants get `gst_unknown` flags where the treatment was not stated (KB-15).
7. **Stage, then promote atomically:** all entities of a run are written to staging tables; one transaction promotes them into `facts` (status `needs_review`, ADR-010) and writes their embeddings (ADR-019) and the audit entries. A failure at any stage leaves nothing visible (KB-12).
8. **Chat exports (KB-04):** parsed in memory from the quarantined object; participants other than the business are redacted (names, phones, emails, NRIC) before anything is persisted; Haiku 5.5 mines Q&A pairs into *Suggested FAQs* (`needs_review`); the original object is deleted when mining finishes (the 24-hour lifecycle is the backstop).
9. **Embeddings** are computed per fact (the rendered fact text plus aliases) and stored with the fact status, so retrieval only ever returns facts (AGT-01). Source passages are kept for provenance display, not for answering.

**Options considered**
- **Queue-driven stages + staging tables + atomic promote (chosen)** — meets KB-12's "no partial entities" by construction; each stage scales on its own. Con: more tables and job types.
- **AWS Step Functions orchestration** — visible workflows. Deferred: the state is small enough for Postgres plus SQS (ADR-012).
- **A managed RAG service (for example Bedrock Knowledge Bases)** — fast to start. Lost: no typed-entity extraction with approval states, weaker control over tenant filtering (GOV-03), and opaque chunking.

**Consequences**
The headless browser also serves the theme preview (ADR-016). Extraction is the most expensive one-off LLM use (about US$0.40–0.60 per 30-page site, ADR-007) and is metered per tenant. Throughput is load-tested against NFR-16 using fixture sites and files.
