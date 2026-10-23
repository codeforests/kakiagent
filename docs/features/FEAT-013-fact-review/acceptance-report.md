# Acceptance Report: FEAT-013 — Fact review, bulk approval and Approve all

> Verdict: **Accepted** (first verification; KB-16 gets a full Test ref) · Date: 2026-10-23
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-10) @ `066df62` · Sources: SRS v0.4 (KB-16; KB-07, KB-15, GOV-01 in part; NFR-09, NFR-11, NFR-19), use-cases v0.4 (UC-15 1–4, 3a, 3b), ADR-005, ADR-008, ADR-010, ADR-014
> Repo state audited: `0c2647f` (implementation head `07bac0b` plus one test-correction commit)

## Verdict summary

FEAT-013 is accepted. Every criterion from AC-1 to AC-10 has a test that asserts what the criterion says.

Two tests asserted less than their criteria, and both are corrected:

- **AC-9:** the E2E never rendered the empty or error states, and it never approved a GST-unknown fact left in the queue after Approve all.
- **AC-8:** the API test never sent a bulk reject or an undo from tenant B's session.

The corrected tests pass against the code. The new E2E assertion went red when the error state was removed. There are no rework or design-defect findings.

No real-model check applies: review is deterministic code and changes no prompt (design §8). The M1.5 gate still pending an API key doesn't affect this feature.

This verification ran in the same session as the implementation. Its standard was re-derived from the SRS, UC-15 and design §6, not from tasks.md. Every green below was observed in this run, after a `pnpm stack:reset` (volumes wiped, fresh migrations and seed).

## Audit standard

- **KB-16 (M):** "every fact extracted from a website, file or chat export starts as 'needs review' and is never used in answers to visitors until the Owner or an Admin approves it. The review screen shows each fact next to the source passage it came from, with the extraction confidence, and offers approve, edit and approve, and reject for single facts; bulk approval by source or by entity type; and Approve all, which approves every remaining fact in one step. Prices, policies and promotions are listed first." Acceptance: "No fact in 'needs review' or 'rejected' status appears in a visitor answer (tested). 'Approve all' first shows how many facts it will approve, by entity type, and asks for confirmation. Every approval, including bulk and 'Approve all', is recorded in the audit log with the approver and timestamp."
  - Encoded by AC-1 to AC-7 and AC-9.
  - Faithful, with one recorded narrowing. Approve all leaves out conflicted facts and GST-unknown prices. That comes from ADR-010 decision 3 and KB-15 (a price can't be quoted without its GST treatment), and the dialog says how many were left out and why. "Every remaining fact" is therefore every fact that can be approved without a choice. That is an accepted architecture decision, not a misencoding.
  - Files and chat exports are FEAT-015..017's sources. Their facts arrive as `needs_review` like a website's, and the queue reads them by status, not by source kind. KB-16's review half is therefore complete here.
- **UC-15:**
  - 1 (the list, passage, date, confidence) → AC-2.
  - 2 (single decisions) → AC-3.
  - 3 (bulk by source or type) → AC-4, AC-5.
  - 4 (audited, and used within 60 s) → AC-1, AC-3.
  - 3a (Approve all with counts by type and confirmation) → AC-5, AC-9.
  - 3b (cancel approves nothing) → AC-5, AC-9.
  - 2a (conflicts) is UC-12, FEAT-014's. Here a conflicted fact is listed with only "Resolve conflict".
- **KB-07 (60 s):** decisions commit in the same transaction as the chunk's version move, so `visitor_chunks` follows at once. AC-1 and AC-10 cover it.
- **KB-15 (in part):** a GST-unknown price needs a choice before approval. AC-3, AC-5 and AC-9 cover it.
- **GOV-01, NFR-11 (in part):** one audit entry per fact, plus a summary for bulk actions. Payloads hold IDs, versions, modes and counts, and no PII. AC-3 to AC-8 and AC-10 cover it.
- **NFR-09, NFR-19:** axe on every screen and dialog, and keyboard operation. AC-9 covers both.
- **ADR-005:** AC-8.

No source path lacks a criterion.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | KB-16 gate, KB-07, UC-15 4 | `packages/kb/test/review.int.test.ts`: "approve: …visible" (in neither `visitor_chunks` nor visitor search before approval, in both after); "reject: … never visible". "previews … then approves exactly that" (`visitor_chunks` equals the approved set; GST-unknown and conflicted stay out). The E2E's widget answers S$62.00 after Approve all and never quotes the seed's in-review S$70. | faithful. "Cites it" is shown as visitor retrieval plus a real widget turn on the fake provider. | green |
| AC-2 | KB-16, UC-15 1 | kb "lists needs_review and conflicted facts…" (order product, policy, FAQ; `quote === page.slice(start, end)`; `before` ≤ 160 chars and a suffix of the page; confidence, source name and date; type and source filters); "pages with a cursor, every fact once"; "summarises counts…". API "lists facts to review in the KB-16 order with their passages" (filters, cursor, 400s); "needs kb.manage and a session" (403 agent, 401 none). | faithful | green |
| AC-3 | KB-16, KB-15, UC-15 2 | kb: approve (version 2, version row, chunk v2, `last_confirmed_at`, `fact.approved` actor user `mode: single`); edit and approve (`fact.updated` then `fact.approved` `mode: edited`, re-embedded chunk); reject; GST-unknown → `GstRequiredError`, unchanged, then approved with a choice; stale version, decided, conflicted, other tenant refused. API: `version_conflict`, `invalid_state`, 400 `gst_required` with its message, then `inclusive`. | faithful | green |
| AC-4 | KB-16, UC-15 3 | kb "applies each eligible ref and skips the rest with reasons" (GST-unknown, conflicted, changed version, other tenant; `mode: bulk` per fact and one `kb.review.approved_bulk {count: 2}`; a decided ref is `not_reviewable`); "rejects a selection…". API selection test (skips, 400 for empty, duplicate and bad refs). | faithful | green |
| AC-5 | KB-16, UC-15 3a, 3b | kb "previews counts by type…" (counts by type, excluded counts, a 64-hex hash; exactly that set approved; `mode: all` per fact; summary payload with the counts and the hash; chain verifies); "approves nothing when the set changed…" (added, edited, decided → `PreviewStaleError` with a new hash, nothing visible, no summary); "scopes to one source or one type" (a hash from another scope is stale). API: 409 `preview_stale` with a fresh `preview`; a type-scoped run. E2E: Cancel leaves the card count unchanged. | faithful | green |
| AC-6 | D5 | kb "puts an approval or rejection back in review" (version 3, chunk v3, out of `visitor_chunks`, `fact.review_undone` with `from`); "refuses a changed fact, a manual fact, an old decision and another tenant" (updated 11 minutes ago → `not_reviewable`). API undo after Approve all (restored 3). E2E: Undo restores the card. | faithful | green |
| AC-7 | KB-16 via KB-07 | kb "an approving edit through updateFact is audited as an approval (AC-7)". FEAT-011's `facts.e2e.ts` still passes on the refactored form (T5). | faithful | green |
| AC-8 | ADR-005 | API "keeps tenant B out of tenant A's facts" | **was weak → corrected**: see below. `packages/db/test/rls.int.test.ts` already shows `app_agent_visitor` denied on `facts`. The kb tests show B can't approve or undo A's facts at the domain layer. | green; chain verifies after 500 facts |
| AC-9 | UC-15, NFR-09, NFR-19 | `e2e/tests/review.e2e.ts` | **was weak → corrected**: see below. | green (about 21 s); mutation (error state removed) → red |
| AC-10 | KB-07, scale | kb "approves 500 facts in one Approve all within 10 s…" | faithful | about 0.85 s for 500 facts on the local stack (indicative); 500 `fact.approved`; chain verifies |

## Corrected tests

Commit `0c2647f`, "FEAT-013 acceptance: correct tests for AC-8 and AC-9".

- **AC-9.** The criterion says "Empty and error states render" and "the queue shows only the GST-unknown facts, and approving one of them asks for the GST choice". The test approved a GST-unknown card *before* Approve all, checked the remaining queue only by its count and its first chip, and never showed an empty or error state.
  - The corrected test approves a card left after Approve all and asserts the GST prompt, with the queue unchanged.
  - It filters the source to FAQs (all approved) and asserts "No facts to review here", then "Show all facts".
  - It makes the list request fail and asserts "We couldn't load your facts", then "Try again".
  - It signs in as the second tenant and asserts "No facts waiting for review" with "Add a source".
  - Mutation: with the error state's render turned off, the test failed at that assertion. Restored, it passed.
- **AC-8.** The criterion says tenant B "can't list, preview, approve, reject or undo". The API test sent list, preview, single approve and reject, bulk approve and Approve all from B, but no bulk reject and no undo.
  - The corrected test sends `POST /review/reject` from B (`not_found` skip).
  - It approves as A, then sends `POST /review/undo` from B (`restored: 0`, `not_found`).
  - It checks that A's fact stays approved at version 2.

## Independent execution

All runs from `0c2647f`, after `pnpm stack:reset`. The run set `CHROMIUM_EXECUTABLE_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to the local Chromium.

| Command | Result |
| :------ | :----- |
| `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser) | exit 0 |
| `pnpm typecheck`, `pnpm test` | exit 0 (22 tasks) |
| `pnpm --filter @kaki/kb test:integration` | 56 passed (18 in `review.int.test.ts`) |
| `pnpm --filter @kaki/api test:integration` | 119 passed (10 in `review.int.test.ts`, with the correction) |
| `pnpm --filter @kaki/db test:integration` (RLS suite) | 94 passed |
| `pnpm test:coverage` | exit 0; per-package thresholds hold (run at `07bac0b`; the correction only adds assertions to integration and E2E tests) |
| `pnpm build && pnpm size` | exit 0; loader 1.75 KB gz, panel 9.6 KB, initial load 1.75 KB |
| `pnpm test:e2e --project=chromium` | 34 passed (1.8 min), with no retries needed |
| `pnpm eval --fast` | every threshold met |

No flaky behaviour was seen. Migrations: FEAT-013 adds none (design D9), and `db:setup` ran clean after the reset.

## Direct verification

- **Audit entries (KB-16, GOV-01, NFR-11).** This was checked in the local database after the E2E run, for tenant Kaki Bakery.
  - There are 15 `fact.approved` entries. That matches the flow: 11 from Approve all, two for the fudge cake (approved, undone, approved again by keyboard), one edit-and-approve and one GST choice.
  - There is one `fact.rejected`, one `fact.review_undone` and one `kb.review.approved_all`. The last carries `{count: 11, product: 5, policy: 2, promotion: 1, faq: 3, scope: "source", source, previewHash}`.
  - Every `fact.approved` has `actor_type: user` and the owner's ref. Each entry's `ts` is the timestamp.
  - The payloads hold only modes, versions, batch IDs, counts and the hash, with no PII.
- **Chain.** `pnpm audit:verify --tenant 11111111-…` returned `ok: true`, with 127 entries checked.
- **Screens.** SCR-APP-019 and SCR-APP-008 were checked at 1280 px and 390 px against ui-design. The states checked were: still reading a source, the grouped queue with passages and confidence, the GST choice on a card, the bulk bar, the Approve all dialog's per-type counts and exclusion line, Edit and approve, and the setup step. The page doesn't scroll sideways at 390 px. Colours, spacing and radii come from token variables (`app.css` review block).
- **Contracts.** The routes, bodies and error codes match design §3: `gst_required` 400, `preview_stale` 409 with `preview`, `version_conflict`, `invalid_state`, and skip reasons `gst_unknown`, `conflicted`, `changed`, `not_found` and `not_reviewable`.

## Findings

**Rework:** none.

**Design defect:** none.

**Minor:**

1. **KB-15 and GOV-01 have no FEAT-013 design ref in the RTM.** Design §9 lists them as partly touched, but the design step appended its refs only to KB-16. FEAT-012's report noted the same pattern. Design ref isn't this skill's column, so this is left for the next detailed-design or planning pass.
2. **The coverage run predates the test correction.** It ran at `07bac0b`. The correction only adds assertions, and the affected suites were re-run after it (API integration, the E2E), so the gate's result stands.

## RTM

The Test ref `features/FEAT-013-fact-review/acceptance-report.md` was appended to this row:

| Requirement | Ref | Why |
| :---------- | :-- | :-- |
| KB-16 | full | Review, bulk by selection, source and type, and Approve all are all delivered. Facts from files and chat exports (FEAT-015..017) enter the same queue. |
