# Acceptance Report: FEAT-012 — Website crawl with attestation, extraction to "needs review", source status and retry

> Verdict: **Accepted — real-model check pending** (first verification; ONB-04, KB-05 and KB-12 get partial Test refs) · Date: 2026-10-22
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-12) @ `266737c` · Sources: SRS v0.4 (ONB-04, KB-01, KB-05, KB-12, KB-13; NFR-09, NFR-11, NFR-16, NFR-17, NFR-19), use-cases v0.4 (UC-03 4, 4b, 5, 5a, 5b, 5c), ADR-005, ADR-008, ADR-010, ADR-015, ADR-018
> Repo state audited: `63fc214` (implementation head `065b83c` plus two test corrections)

## Verdict summary

FEAT-012 is accepted. Every criterion from AC-1 to AC-12 has a test that asserts what the criterion says. The exception is AC-6's real-model half, which can't run here.

Two tests asserted less than their criteria, and both are corrected:

- **AC-3:** the test only required at least one skipped page.
- **AC-9:** the test never asked the visitor retrieval.

The corrected tests pass against the code, and both went red when the behaviour was broken. There are no rework or design-defect findings.

The real-model extraction run (AC-6) and the real-model timings (ONB-04, NFR-16) are recorded as pending. The owner, Ken, skipped the M1.5 gate on 2026-10-21 until an API key is available ("Ok, skip the gate for now. I will get a key later"; design §0, §8).

This verification ran in the same session as the implementation. Its standard was re-derived from the SRS, the use cases and design §6, not from tasks.md. Every green below was observed in this run, after a `pnpm stack:reset` (volumes wiped, fresh migrations and seed).

## Audit standard

- **ONB-04 (M):** "'Paste your website URL' as the first and quickest path to a working bot." Acceptance: "For a typical 30-page SME site, a draft KB is ready for review (KB-16) in ≤ 5 minutes."
  - Encoded by AC-11 and AC-12.
  - Faithful. The local measurement uses the fake extractor, so the real-model timing is pending (partial).
- **KB-01 (M):** "Website crawl: authorised domains only (KB-13), respects robots.txt, page limit set by the tenant's plan (D2), renders JavaScript pages." Acceptance: "Crawl status and page list are visible. Excluded or failed pages are listed with a reason. Pages beyond the plan limit are listed as 'skipped: plan limit'."
  - Encoded by AC-2, AC-3 and AC-12.
  - Faithful. The plan limit comes from `CRAWL_PAGE_LIMIT` until plans exist (D8, FEAT-067), which is a recorded decision.
- **KB-05 (M):** LLM extraction into typed entities, each starting as "needs review", with provenance.
  - Encoded by AC-4, AC-5 and AC-6.
  - Faithful for products, prices, policies, FAQs and promotions. Business hours and location are deferred to FEAT-035 (design §8), and the real-model run is pending, so the ref is partial.
- **KB-12 (M):** a state with a reason and retry for every source; "A failed source never leaves partial entities live. The owner is alerted when a source they added fails."
  - Encoded by AC-7, AC-8 and AC-12.
  - Faithful for website sources and the in-app alert (the failed count on the nav entry and tab). The e-mail alert is FEAT-052's (design §8), and other source kinds come with FEAT-015..017, so the ref is partial.
- **KB-13 (M):** attestation before a crawl, crawling stays in the confirmed domain and listed subdomains, confirmed domains become allowed origins. Acceptance: "A crawl without an attestation cannot start. Links to other domains are not followed. The attestation is recorded in the audit log."
  - Encoded by AC-1, AC-2 and AC-12.
  - Faithful.
- **UC-03:** step 4 and 4b → AC-1; step 5 → AC-2, AC-4; 5a → AC-7; 5b → AC-3; 5c → AC-7.
- **Binding NFRs:**
  - NFR-16 (ingestion throughput) → AC-11.
  - NFR-17 (idempotent consumers) → AC-7, AC-8.
  - NFR-11 (no plaintext in audit) → AC-1 (domain hash only).
  - NFR-09 and NFR-19 (WCAG 2.1 AA) → AC-12.
  - Tenant isolation (ADR-005) → AC-10.

Every planned FR has at least one criterion, and every UC-03 path from step 4 onwards is represented. The standard needs no amendment.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | KB-13, UC-03 4, 4b, NFR-11 | `packages/kb/test/sources.int.test.ts` "records the attestation before the source…": the audit order is attested, then created; the payload is the SHA-256 domain hash with no plaintext; three origins are added; the crawl job is written. `apps/api/test/sources.int.test.ts`: `attestation_required` with nothing written; `url_not_public` for private and unresolvable hosts; `bad_request` for an IP literal, `localhost`, a port and a foreign subdomain; 409 `source_exists`; 403 for agent; 401 without a session. | faithful | green |
| AC-2 | KB-01, KB-13, UC-03 5 | `packages/kb/test/ingest.int.test.ts` "lists every in-scope page…" (each page's status, reason and HTTP status; robots-blocked and other hosts never requested; NRIC masked). `apps/ingest-worker/test/chromium.int.test.ts`: a JS-only page is rendered; an off-domain redirect is seen without requesting the other host; a 404; the address guard aborts private requests; the fixture server log shows no `/private/*` request. | faithful | green |
| AC-3 | KB-01, UC-03 5b | `ingest.int.test.ts` "stops at the page limit…" | **was weak → corrected**: see below | green; mutation (only one skipped row written) → red |
| AC-4 | KB-05, KB-15, KB-16 | `ingest.int.test.ts` "a full run ends ready…": five typed facts, `needs_review`, `website`, confidence; each `provenance.quote === content.slice(start, end)` with the page's URL; GST `unknown` where unstated; none returned by visitor retrieval. Chromium end-to-end run on the fixture site. | faithful. "A visitor turn cites none" is shown as "the visitor retrieval returns none". That is the turn's only fact input, and `turn.int.test.ts` (FEAT-022 AC-7) already proves `needs_review` facts are never cited in a real turn. | green |
| AC-5 | KB-05, ADR-008 | `packages/kb/src/ingest/extract.test.ts`: invented prices, quotes not on the page, other currencies, bad dates and promotions without an end date are dropped; the prompt-injected page yields only what it states; malformed output is rejected. The full run collapses the fudge cake on two pages into one fact. | faithful; mutation (price-in-quote check always true) → 2 tests red | green |
| AC-6 | KB-05, AGT-14 | `evals/extraction/pages.json` (15 pages, 12 on the fake provider); `evals/src/extraction.test.ts`; `thresholds.json` extraction-precision 0.95, recall 0.8, prices 1.0 | faithful (fake half). The real-model half is **pending** (gate skipped by the owner) | `pnpm eval --fast`: precision, recall and prices 1.000 |
| AC-7 | KB-12, UC-03 5a, 5c | `ingest.int.test.ts`: the failing extractor leaves the source `queued` at `extract`, then `failed: extraction_unavailable` with zero facts and zero staged rows; a retry runs as attempt 2 and ends `ready`. "fails no_pages…": every page is `excluded: robots`. `sources.int.test.ts` "retries only a failed source…" (409 on a non-failed source). | faithful | green |
| AC-8 | KB-12, NFR-17 | `ingest.int.test.ts` "resumes extraction after a crash…" (only the 2 unfinished pages are re-extracted); "ignores duplicate and stale jobs" (four stale variants; status, counts and version unchanged; 5 facts) | faithful | green |
| AC-9 | KB-07, GOV-05 | `sources.int.test.ts` "deletes a source…" | **was weak → corrected**: see below | green; mutation (approved facts kept on delete) → red |
| AC-10 | ADR-005 | `packages/db/test/rls.int.test.ts`: tenant B reads, updates and deletes 0 rows of A's sources, pages and staged facts as `app_dashboard` and `app_ingest`; `app_ingest` can't read conversations, messages, users or sessions, and can't delete facts or change tenants; `app_agent_visitor` gets permission denied on the three tables and doesn't see extracted facts in `visitor_facts`. | faithful | green |
| AC-11 | ONB-04, NFR-16 | `chromium.int.test.ts` end-to-end timings | faithful (local, fake provider) | bakery site 6.4 s (≤ 5 min); 200-page site 33.2 s (≤ 15 min) |
| AC-12 | UC-03 4–5, NFR-09, NFR-19, KB-12 | `e2e/tests/sources.e2e.ts`: empty state; attestation blocks the start; Queued/Processing → Ready; page reasons; the "N facts · N need review" row; a fact's source passage; a failed source with its reason, the failed count and Retry; axe on SCR-APP-023, -007, -024 and -028 | faithful | 2/2 green |

## Corrected tests

Both corrections are in commit `63fc214`, "FEAT-012 acceptance: correct tests for AC-3 and AC-9".

1. **AC-3, "every further discovered page is `skipped: plan_limit`".**
   - **What was weak:** the test only asserted `skipped.length > 0`. An implementation that listed one skipped page and dropped the rest would have passed.
   - **The faithful assertion:** collect the links of the 100 fetched pages, then check that the skipped rows are exactly the discovered pages that weren't fetched, and that the list holds nothing else.
   - **Mutation check:** writing only the first skipped row turns the test red.
2. **AC-9, "the next visitor turn can't retrieve a deleted approved fact".**
   - **What was weak:** the test checked that the facts, chunks and versions rows were gone, but never asked visitor retrieval.
   - **The faithful assertion:** the approved fact is returned by `searchVisitorFacts` on the visitor zone before the delete, and not after it.
   - **Mutation check:** keeping approved facts on delete turns the test red.

## Independent execution

All commands below are the harness's own (AGENTS.md):

- `pnpm stack:reset`: volumes wiped, `docker compose up --wait`, roles, migrations, RLS and seed. Exit 0.
- `CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium pnpm test:coverage --concurrency=2`: exit 0 with every per-package threshold held. Test counts:

  | Package | Tests |
  | :------ | ----: |
  | db (cross-tenant RLS suite included) | 94 |
  | platform | 266 |
  | governance | 93 |
  | llm-gateway | 36 |
  | identity | 30 |
  | tenancy | 37 |
  | inbox | 7 |
  | analytics | 7 |
  | channels | 2 |
  | kb | 115 |
  | ingest-worker | 5 |
  | agent | 345 |
  | api | 109 |

  The sandbox's Chromium is a different build from the one playwright-core 1.64.1 pins, hence the path override. CI installs the pinned headless shell.
- `pnpm test:e2e --project=chromium` with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` and `CHROMIUM_EXECUTABLE_PATH` set to the sandbox Chromium: **33 passed**, none flaky.
  - The first attempt left `PLAYWRIGHT_CHROMIUM_EXECUTABLE` unset, and all 33 failed to launch a browser ("Executable doesn't exist … chromium_headless_shell-1248"). That is an environment issue. Nothing ran, and it isn't a test result.
- `pnpm eval --fast`: every subset passes, and extraction precision, recall and prices are each 1.000 over 5 pages.
- `pnpm format:check`, `lint` (ESLint and dependency-cruiser), `test` and `build && size` exit 0 (T14; only test files and docs changed since). `pnpm typecheck` was not re-run after the AC-3 correction, and CI caught a type error in it (the fake site's page union). That was fixed in `FEAT-012 acceptance: type the AC-3 correction`, and `pnpm typecheck` then exited 0, with the corrected test still green.
- **Anti-fake-green review** (diff `266737c^..63fc214` over the test files, `thresholds.json`, the vitest configs and `ci.yml`):
  - **Additions only.** The only removed lines extend existing lists: the RLS role list gains `app_ingest` (4 → 5 roles), the outbox tests' queue map gains the ingest queue, and `thresholds.json` gains a trailing comma and a longer `$comment`.
  - **No loosening.** No thresholds were lowered, no coverage scope was narrowed or excluded, and no skip, todo or only was added.
  - **CI.** The workflow only gains browser installs.

## Direct verification

- **Audit (KB-13, NFR-11):** `kb_source.attested` precedes `kb_source.created`, and its payload is `{ domainHash, subdomains }`, with no domain text. `kb_source.promoted { facts, attempt }` and `kb_source.deleted { kind, facts }` were inspected in the integration tests' audit queries.
- **Allowed origins (KB-13 → CHN-11):** `tenants.allowed_origins` gains the apex, `www` and listed subdomain origins (AC-1 test).
- **No partial entities on failure (KB-12):** zero facts and zero staged rows after `extraction_unavailable` (AC-7 test).
- **NFR-16 and ONB-04, measured locally:** 6.4 s for the bakery fixture site and 33.2 s for 200 pages, with the fake extractor. These figures are indicative only.
- **Pending environment:**
  - Extraction precision, recall and price accuracy on the real model: AC-6, `LLM_PROVIDER=anthropic-dev pnpm eval`, at M1.5.
  - ONB-04 and NFR-16 timings with real extraction latency: M1.5 and MD.
  - The Chromium image size and cold start: MD.
  - The DNS-rebinding residual, closed by egress-only security group rules for ingest-worker: MD (design D7, §8).
- **Screens:**
  - **Observed in this run:** the E2E run rendered SCR-APP-023 (empty, list, failed with Retry), SCR-APP-007 (validation), SCR-APP-024 (busy, ready, page filter, failed) and SCR-APP-028 (source passage), all axe-clean. The CSS added for FEAT-012 uses only `var(--…)` tokens.
  - **Checked during T12, not re-observed here:** the loading, error, not-found and delete-confirm states (at 1280 px and 390 px).
  - **Manifest:** the entries resolve to `ui-design.md` anchors.
- **Contracts:** routes, bodies and error codes match design §3. Every error is `{ error, message }`, and `source_exists` also carries `sourceId`. `Fact` gained the nullable `sourceId`, `confidence` and `provenance`. In production builds the API ignores `CRAWL_ALLOW_PRIVATE_HOSTS`, as the worker does (T14).

## Findings

**Rework:** none.

**Design defect:** none.

**Minor:**

1. **KB-15 and CHN-11 have no FEAT-012 design ref in the RTM.** Design §9 lists them as partially touched (GST `unknown` on extracted prices; confirmed domains as allowed origins), but the design step appended its refs only to ONB-04, KB-01, KB-05, KB-07, KB-12 and KB-13. The plan entry doesn't list them either. Design ref isn't this skill's column, so this is left for the next detailed-design or planning pass.
2. **Two plan corrections suggested in design §8 are still open:** KB-12's e-mail alert should be credited to FEAT-052, and the hours and location suggestion to FEAT-035.
3. **Local Chromium:** E2E needs `PLAYWRIGHT_CHROMIUM_EXECUTABLE` as well as `CHROMIUM_EXECUTABLE_PATH` where the pinned browser isn't installed. AGENTS.md named only the second; it now names both (docs only).

## RTM

The Test ref `features/FEAT-012-website-crawl/acceptance-report.md` was appended to these rows:

| Requirement | Ref | Why |
| :---------- | :-- | :-- |
| ONB-04 | partial | Real-model timing pending |
| KB-01 | full | |
| KB-05 | partial | Hours and location are FEAT-035's; the real-model run is pending |
| KB-12 | partial | The e-mail alert is FEAT-052's; file, spreadsheet and chat sources are FEAT-015..017's |
| KB-13 | full | |
