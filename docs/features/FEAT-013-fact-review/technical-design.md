# Technical Design: FEAT-013 — Fact review, bulk approval and Approve all

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) and §5 (M2, third) · Epic: E2 Knowledge base
> Implements: KB-16 · Also serves: KB-15 (p: an unknown GST treatment is chosen while approving), KB-17 (p: approval records `last_confirmed_at`), KB-07 (p: an edit that approves a fact is audited as an approval), GOV-01 (p: review decisions in the audit chain), ONB-09 (p: the review counts the readiness check reads) · Binding NFRs: NFR-09 (WCAG 2.1 AA), NFR-11 (IDs-only audit), NFR-19 (states)
> Realizes: UC-15 steps 1–4, alternate 3a, exception 3b (2a, conflicts, is FEAT-014)
> Screens: SCR-APP-019 (anchor screen, built here), SCR-APP-008 (p: the facts part, without the wizard frame or coverage summary), designed in [ui-design.md](ui-design.md)
> Status: Verified (self-check §9) · Date: 2026-10-22

## 0. Sequencing note: the M1.5 real-model gate

The gate is still pending an Anthropic API key (FEAT-012 design §0; owner decision of 2026-10-21 to skip it until the key arrives). FEAT-013 adds no model prompt and changes no model-dependent behaviour: review is deterministic (statuses, the `visitor_facts` view, audit). Its acceptance therefore doesn't depend on the gate, and no criterion here is "real-model check pending".

## 1. Intent

KB-16 (D11) is the gate between extraction and use: a fact the crawler found (FEAT-012) is `needs_review` and never reaches a visitor until the Owner or an Admin approves it. FEAT-013 builds that gate's owner side. The Review screen lists the facts waiting, prices, policies and promotions first, each next to the passage it came from (highlighted in its page context), with the extraction confidence and the source. The owner approves a fact, edits and approves it, or rejects it, one at a time, by selection, by source or type, or all at once with **Approve all**, which first shows how many facts of each type it will approve. Every decision is audited with the approver and time, and an approved fact is in visitor answers as soon as the transaction commits. It comes third in M2 because the crawl's facts (FEAT-012) are unusable until this exists; the interim "crawl → review" demo (plan §5) follows it.

## 2. Codebase context

Surveyed on `main` at `458fd3a` (after FEAT-012, PR #18).

- **Schema:** `facts` has `status` (`needs_review`, `approved`, `rejected`, `conflicted`, `disabled`), `version`, `last_confirmed_at`, `source_id`, `confidence`, `provenance { url, title, quote, start, end }`. `fact_versions` is immutable. `kb_chunks` has one chunk per fact with `fact_version`; `visitor_chunks` joins `visitor_facts` on the version, so a status change must move the chunk's version with it (FEAT-011 does this for disable/enable). `kb_source_pages.content` holds the masked page text the provenance offsets refer to (FEAT-012 D5). `app_dashboard` already has `SELECT, UPDATE` on `facts`, `SELECT, INSERT` on `fact_versions`, `UPDATE` on `kb_chunks` and `SELECT` on `kb_source_pages`.
- **Visitor view (0011):** `visitor_facts` admits `approved`, started, unexpired facts, and drops a price with `gst_treatment = 'unknown'` at a GST-registered tenant (or one without a profile). So `needs_review`, `rejected` and `conflicted` facts can't reach a visitor already; FEAT-013 adds the path into `approved`.
- **kb module:** `updateFact` (FEAT-011) refuses a status-only approval of a `needs_review` fact ("review this fact in Review") and silently approves one on a content edit, auditing only `fact.updated`. `listFacts`, `getFact`, `mergePatch`, `contentChanged`, `checkFact`, `prepareChunk` (embed before the transaction, FEAT-022 D4). Errors map to the envelope in `apps/api/src/app.ts`.
- **API:** `apps/api/src/facts.ts` (capability `kb.manage`: owner, admin), contract shapes in `packages/contracts` (`Fact`, `UpdateFactBody`, `Provenance`).
- **Dashboard:** `/review` is a placeholder naming FEAT-013; Sources links to it. `FactForm` in `pages/fact.tsx` holds the type-specific fields and draft logic inline. `ConfirmDialog` (Radix) in `@kaki/ui`; a toast pattern (`useToast`) and `.passage` styles exist. The shell's `NavCount` renders the failed-sources pill on Knowledge.
- **Audit:** `audit.append(tx, tenantId, entry)` per entry; payloads take IDs, codes, numbers and hashes only (ADR-014).
- **Divergences (reality wins):** ADR-010 decision 2 says "the chunk index stores the fact status with each chunk"; the built design filters chunks through `visitor_facts` by version instead (FEAT-022), which gives the same same-transaction effect. Nothing here changes it.

## 3. API contracts

All shapes live in `packages/contracts` (a new "review" section). Auth, `kb.manage`, tenant-from-session, the error envelope and the `version` precondition are as in FEAT-011 §3.

### 3.1 Shapes

```ts
ReviewType   = FactType                                     // product | faq | policy | promotion
ReviewScope  = { sourceId?: uuid, type?: ReviewType }       // "by source or by entity type" (KB-16)
Passage      = { before: string, quote: string, after: string }   // ≤ 160 chars each side, cut at a word
ReviewFact   = Fact & { passage: Passage | null, sourceName: string | null, sourceCapturedAt: string | null }
FactRef      = { id: uuid, version: int }
SkipReason   = 'gst_unknown' | 'conflicted' | 'not_reviewable' | 'changed' | 'not_found'
ReviewSummary = {
  needsReview: int, conflicted: int,                        // the tab and nav count
  byType: Record<ReviewType, int>,                          // needs_review + conflicted, per type
  bySource: Array<{ id: uuid | null, name: string, count: int }>,   // null: facts with no source
  approvedInUse: int,                                       // the empty state's "using N approved facts"
  sourcesBusy: int,                                         // SCR-APP-008 "still extracting"
}
ApprovePreview = {
  scope: ReviewScope, count: int, byType: Record<ReviewType, int>,
  excluded: { gstUnknown: int, conflicted: int },           // shown, never approved by Approve all
  previewHash: string,                                      // 64 hex
}
```

### 3.2 Endpoints

| Method, path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/v1/kb/review/facts` | query `sourceId?`, `type?`, `cursor?`, `limit?` (1–100, default 50) | 200 `{ facts: ReviewFact[], nextCursor }`: `needs_review` and `conflicted` facts, ordered product, policy, promotion, faq (KB-16 "prices, policies and promotions first"), then `created_at`, `id` (crawl order) | 400 (malformed query or cursor); 401, 403 |
| `GET /api/v1/kb/review/summary` | — | 200 `ReviewSummary` | 401, 403 |
| `GET /api/v1/kb/review/preview` | query `sourceId?`, `type?` | 200 `ApprovePreview` | 400; 401, 403 |
| `POST /api/v1/kb/review/approve-all` | `{ sourceId?, type?, previewHash }` | 200 `{ approved: int, facts: FactRef[] }` (the new versions, for Undo); one `fact.approved` audit entry per fact and one `kb.review.approved_all` summary | 409 `preview_stale` `{ preview }` (the eligible set changed since the preview; nothing approved); 400; 401, 403 |
| `POST /api/v1/kb/facts/:id/approve` | `{ version, value?, gstTreatment?, validFrom?, validUntil? }` (the edit fields of `UpdateFactBody`; any present = "edit and approve") | 200 `{ fact }`, version + 1; audit `fact.updated` (when edited) and `fact.approved` | 400 `gst_required` (a price with an unknown GST treatment and none chosen, KB-15); 400 `bad_request`; 409 `invalid_state` (not `needs_review`; conflicted facts go to FEAT-014); 409 `version_conflict`; 404; 503 `unavailable` (embedder, edits only); 401, 403 |
| `POST /api/v1/kb/facts/:id/reject` | `{ version }` | 200 `{ fact }` (`rejected`, version + 1); audit `fact.rejected` | 409 `invalid_state`; 409 `version_conflict`; 404; 401, 403 |
| `POST /api/v1/kb/review/approve` | `{ facts: FactRef[] }` (1–200, distinct) | 200 `{ approved: FactRef[], skipped: { id, reason: SkipReason }[] }`; audit per fact plus `kb.review.approved_bulk` | 400; 401, 403 |
| `POST /api/v1/kb/review/reject` | `{ facts: FactRef[] }` (1–200) | 200 `{ rejected: FactRef[], skipped }`; audit per fact plus `kb.review.rejected_bulk` | 400; 401, 403 |
| `POST /api/v1/kb/review/undo` | `{ facts: FactRef[] }` (1–5,000; the refs a decision returned) | 200 `{ restored: int, skipped }`: each fact goes back to `needs_review`, version + 1; audit `fact.review_undone` per fact | 400; 401, 403 |
| `PATCH /api/v1/kb/facts/:id` | unchanged | unchanged; a content edit that approves a `needs_review` fact now also audits `fact.approved` (`mode: edited`) | unchanged |

A malformed fact ID is a 404, as in FEAT-011. Another tenant's fact is a 404 for single calls and `not_found` in a bulk call's `skipped`.

## 4. Schema changes

**None.** Every state the feature needs exists: `facts.status`, `version`, `last_confirmed_at`, `fact_versions`, `kb_chunks.fact_version` and `kb_source_pages.content`, with the dashboard grants above. Listing reads `facts_tenant_status_updated_idx` (`tenant_id, status, updated_at`); a review queue is at most a few thousand rows per tenant, so the type ordering is a sort, not an index. `TENANT_SCOPED_TABLES` and the RLS suite are unchanged, and the RLS suite gains review-path cases (AC-8).

## 5. Component design

```mermaid
sequenceDiagram
    autonumber
    actor O as "Owner"
    participant UI as "Review (SCR-APP-019)"
    participant API as "api /api/v1/kb/review"
    participant KB as "kb review.ts"
    participant DB as "Postgres"
    O->>UI: "Approve all…"
    UI->>API: "GET preview?sourceId&type"
    API->>KB: "previewApproveAll(scope)"
    KB->>DB: "eligible facts (id, version, type)"
    API-->>UI: "{ count, byType, excluded, previewHash }"
    O->>UI: "Approve 41 facts"
    UI->>API: "POST approve-all { scope, previewHash }"
    API->>KB: "approveAll(scope, previewHash)"
    KB->>DB: "tx: eligible FOR UPDATE; hash check; facts approved + versions + chunk versions + audit per fact + summary"
    API-->>UI: "{ approved: 41, facts }"
    UI-->>O: "toast: 41 facts approved · Undo"
```

### 5.1 kb review functions (`packages/kb/src/review.ts`)

Dashboard scope (`DashboardKbContext`), each in the caller's `withTenant` transaction:

- `listReviewFacts(ctx, scope, cursor?, limit?)` → `{ facts: ReviewRecord[], nextCursor }`. `ReviewRecord = FactRecord & { passage, sourceName, sourceCapturedAt }`. Order key `(type rank, created_at, id)` with rank product 0, policy 1, promotion 2, faq 3; the cursor encodes the key like FEAT-011 D5 (`created_at` as Postgres text). The passage comes from one join to the source's current-attempt page with the provenance URL (`kb_source_pages` `content`), sliced around `[start, end)`: up to 160 characters each side, widened or trimmed to a word boundary, with "…" where cut. If the page is gone or `content.slice(start, end) !== quote` (a defensive check), `passage` is `{ before: '', quote, after: '' }`; manual facts (no provenance) have `null`.
- `reviewSummary(ctx)` → `ReviewSummary`, from grouped counts on `facts` and `kb_sources` (busy = `queued` or `processing`).
- `previewApproveAll(ctx, scope)` → `ApprovePreview`. **Eligible** = `needs_review`, in scope, and not "GST unknown" (`gst_treatment = 'unknown'`, which only priced facts carry). `excluded` counts the in-scope `conflicted` and GST-unknown `needs_review` facts. `previewHash = sha256(canonical { scope, facts: sorted "id:version" })` (D2).
- `approveAll(ctx, scope, previewHash)` → `{ facts: FactRef[] }`. Selects the eligible set `FOR UPDATE` in a stable order, recomputes the hash, and throws `PreviewStaleError(preview)` on a mismatch before writing anything. Then `approveRows` (below) with `mode: 'all'` and one summary entry.
- `approveFact(ctx, id, { version, gstTreatment? }, edit?)` where `edit = { next: FactInput, chunk: PreparedChunk }` when the owner edited. Locks the row; `version` must match (`VersionConflictError`); status must be `needs_review` (`InvalidStateError`). If the resulting fact still has `gst_treatment = 'unknown'` → `GstRequiredError`. Writes the new content (when edited), status `approved`, version + 1, `updated_by`, `updated_at`, `last_confirmed_at = now()`, a version row, and the chunk (the new chunk when edited, otherwise `fact_version` moved). Audit: `fact.updated` when edited, then `fact.approved { version, mode: 'single' | 'edited' }`.
- `rejectFact(ctx, id, version)`: `needs_review` → `rejected`, version + 1, version row, chunk version moved (the view excludes it either way), audit `fact.rejected { version }`.
- `approveSelected(ctx, refs)` / `rejectSelected(ctx, refs)`: lock the referenced rows of the tenant; each ref is applied or skipped with a reason: `not_found` (no such fact here), `changed` (version differs), `not_reviewable` (not `needs_review`, other than conflicted), `conflicted`, `gst_unknown` (approve only: the owner must choose). Applied rows go through `approveRows`/`rejectRows` with `mode: 'bulk'` and one summary entry `kb.review.approved_bulk` / `rejected_bulk { count }`. A selection with nothing applicable writes nothing and no summary.
- `undoReview(ctx, refs)`: for each ref, the fact must be at that version, `approved` or `rejected`, its previous version row must be `needs_review` (so only a review decision is reverted, never a manual fact or an older approval), and the decision must be under 10 minutes old (`updated_at`). It goes back to `needs_review` at version + 1 with a version row, chunk version moved, audit `fact.review_undone { version }`. Otherwise skipped (`changed` / `not_reviewable`). The 10-minute bound is server-side; the UI offers Undo for 5 s (design.md `fact-card`), plus the time a toast is held open by focus or hover.
- `approveRows(ctx, rows, mode, batchId?)`: one `UPDATE … FROM (VALUES …)` for status, version, `last_confirmed_at`, `updated_by`; one `INSERT … SELECT` of version rows; one `UPDATE` of chunk versions; then one `fact.approved { version, mode, batch? }` entry per fact (ADR-010 decision 3: "one audit entry per fact plus one summary entry"). Set-based writes keep a 500-fact Approve all within a few seconds; the audit appends are sequential by the chain's design.

Errors (in `errors.ts`): `PreviewStaleError { preview }` (409 `preview_stale`), `GstRequiredError` (400 `gst_required`), and the existing `FactNotFoundError`, `InvalidStateError`, `VersionConflictError`, `EmbeddingUnavailableError`.

`updateFact` (FEAT-011) gains one line: when a content edit moves `needs_review → approved`, it appends `fact.approved { version, mode: 'edited' }` after `fact.updated` and sets `last_confirmed_at` (it already does on content changes).

### 5.2 Audit entries

| Action | Subject | Payload | When |
|---|---|---|---|
| `fact.approved` | `fact` / id | `{ version, mode: single\|edited\|bulk\|all, batch? }` | each approval, any path |
| `fact.rejected` | `fact` / id | `{ version, mode: single\|bulk, batch? }` | each rejection |
| `fact.review_undone` | `fact` / id | `{ version, from: approved\|rejected }` | each undo |
| `kb.review.approved_all` | `kb_review` / batch id | `{ count, product, policy, promotion, faq, scope: all\|source\|type, source?, type?, previewHash }` | once per Approve all |
| `kb.review.approved_bulk`, `kb.review.rejected_bulk` | `kb_review` / batch id | `{ count }` | once per selection action |

Actor: `user` / the session's user ID; the entry's timestamp is the chain's. That is KB-16's "approver and timestamp". Payloads hold IDs, codes, counts and the hash only (NFR-11).

### 5.3 API routes (`apps/api/src/review.ts`)

`registerReviewRoutes(app, deps, sessionFrom)`, `kb.manage` like the fact routes. The approve route builds the patch exactly as the PATCH route does (type-checked value, GST only on priced types, validity only on promotions), merges it with `mergePatch`, embeds with `prepareChunk` before the transaction when the content changed, then calls `approveFact`. `toFact` is shared from `facts.ts`; `toReviewFact` adds the passage fields. `app.ts` maps the two new errors.

### 5.4 Dashboard

- `/review` → SCR-APP-019 `ReviewPage`; `/review/conflicts` and `/review/corrections` stay placeholders (FEAT-014, FEAT-018) under the same tab row.
- `/setup/review` → SCR-APP-008 (partial): the same `ReviewQueue` with the setup's step text and a Continue link; FEAT-035 adds the wizard frame and FEAT-019 the coverage summary.
- `FactForm`'s fields and draft rules move to `pages/fact-fields.tsx` and `lib/fact-draft.ts`, so the "Edit and approve" dialog reuses them (no behaviour change on SCR-APP-028).
- The shell's Review entry shows the `needsReview` count (`GET …/review/summary`), refreshed after every decision and while a source is busy.
- Details, states and copy in [ui-design.md](ui-design.md).

## 6. Acceptance criteria

- **AC-1 (KB-16 gate).** A `needs_review`, `rejected` or `conflicted` fact is never in `visitor_facts` or `visitor_chunks`, and a visitor turn asking about it cites none. After `POST …/approve` commits, the fact is in `visitor_facts` and its chunk in `visitor_chunks` (same transaction, so within KB-07's 60 s), and the next visitor turn on the fixture question cites it. After `…/reject`, it is still in neither.
- **AC-2 (KB-16 list; UC-15 1).** `GET /review/facts` returns only `needs_review` and `conflicted` facts of the tenant, ordered product, policy, promotion, faq, then crawl order; each extracted fact carries its confidence, source name and date, and a passage whose `quote` equals `page.content.slice(start, end)` with up to 160 characters of context each side; filters by source and type work; paging with the cursor returns every fact once. Another tenant's facts never appear; an `agent` gets 403.
- **AC-3 (KB-16 single; UC-15 2).** Approve moves `needs_review → approved` with version + 1, a version row, the chunk at the new version, `last_confirmed_at` set, and `fact.approved` (actor = the user, `mode: single`) in the audit chain. Edit and approve changes the value, re-embeds, approves and audits `fact.updated` then `fact.approved` (`mode: edited`). Reject moves to `rejected` and audits `fact.rejected`. A stale version is 409 `version_conflict`, an approved or rejected fact 409 `invalid_state`, and nothing changes. A product with GST `unknown` approved without a choice is 400 `gst_required`; with `gstTreatment: 'inclusive'` it is approved as inclusive.
- **AC-4 (KB-16 bulk; UC-15 3).** `POST /review/approve` with five refs approves the eligible ones and skips, with reasons, a GST-unknown fact, a conflicted fact, a fact whose version changed and another tenant's fact; there is one `fact.approved` (`mode: bulk`) per approved fact and one `kb.review.approved_bulk { count }`. `POST /review/reject` does the same for rejection.
- **AC-5 (KB-16 Approve all; UC-15 3a, 3b).** The preview counts, by type, exactly the in-scope `needs_review` facts that aren't GST-unknown, and reports the excluded GST-unknown and conflicted counts. Executing with its hash approves exactly that set, with one `fact.approved` (`mode: all`) per fact and one `kb.review.approved_all` carrying the count and per-type counts. If a fact is added, edited or decided after the preview, the execute is 409 `preview_stale` with a fresh preview and nothing is approved. Scoped to a source or a type, it approves only that source's or type's facts. Cancelling the dialog sends nothing (E2E).
- **AC-6 (Undo).** Undo on the refs an approval or rejection returned restores `needs_review` at a new version, removes the fact from `visitor_facts`, and audits `fact.review_undone`; a ref whose fact changed since, a manual fact, or a decision older than 10 minutes is skipped.
- **AC-7 (KB-16 via KB-07).** Editing a `needs_review` fact on SCR-APP-028 (`PATCH`) approves it and the audit chain holds `fact.approved` (`mode: edited`) after `fact.updated`.
- **AC-8 (ADR-005).** Tenant B's session can't list, preview, approve, reject or undo tenant A's facts (404 or `not_found`, and A's rows unchanged). `app_agent_visitor` still can't read `facts`. The audit chain verifies after a 500-fact Approve all.
- **AC-9 (UC-15; E2E; NFR-19, NFR-09).** In the browser: after the fixture site's crawl, the Review nav shows the count; the owner opens Review (loading, then cards grouped Prices, Policies, Promotions, FAQs with passages), approves one card (it collapses with Undo, and Undo restores it), edits and approves one in the dialog, rejects one, uses the keyboard (`J`, `A`), opens Approve all, sees the counts per type and the excluded GST-unknown count, cancels (nothing changes), opens it again and confirms; the queue shows only the GST-unknown facts, and approving one of them asks for the GST choice. The widget then answers a fixture price question with the approved price. Empty and error states render. `/setup/review` shows the queue with the setup text. No serious axe violations on SCR-APP-019, its dialogs and SCR-APP-008.
- **AC-10 (KB-07 60 s, scale).** On the local stack, Approve all of 500 facts completes in ≤ 10 s and the audit chain verifies (`pnpm audit:verify`). Logged as measured.

## 7. Decisions

- **D1 — Review decisions are commands, not a status PATCH.** Driver: ADR-010 decision 3 ("bulk approval is a server-side command, not a client loop") and FEAT-011's `updateFact`, which already refuses status-only approval of a `needs_review` fact. Separate commands keep every path into `approved` explicit and audited with its mode. Rejected: `PATCH { status: 'approved' }` (one more meaning on a general edit route, and no bulk).
- **D2 — Approve all executes the preview's hash.** Driver: KB-16 "first shows how many facts it will approve" and ADR-010 d3 "approves exactly what was shown". The hash covers the scope and every eligible `id:version`, so a fact added by a finishing crawl, edited by a colleague, or decided in another tab changes it; the execute then fails as a whole with a fresh preview rather than approving something unseen. Rejected: a count check (two different sets can have the same count).
- **D3 — GST-unknown and conflicted facts always need individual action.** Driver: ADR-010 d3 and KB-15 ("not quoted until reviewed"). Approve all and bulk approval skip them and say how many; the card's Approve asks for the GST choice inline. Conflicts are resolved in FEAT-014's screen, so a conflicted card offers only "Resolve conflict". Rejected: approving GST-unknown prices as-is (the view would keep hiding them, so the owner would think they're live).
- **D4 — Bulk selection is per fact, not all-or-nothing.** Driver: each approval is an independent decision with its own audit entry, and a colleague changing one card shouldn't undo the owner's other nine. Skipped refs come back with reasons, and the UI says so. Approve all is different (D2) because the owner confirmed a count.
- **D5 — Undo reverts only a review decision, briefly.** Driver: design.md `fact-card` (Undo for 5 s) and the anchor's Approve all toast with Undo. The server accepts an undo only for the version the decision produced, when the previous version was `needs_review` and within 10 minutes, so it can't be used to pull a manual or long-approved fact back into review. ADR-010's state machine gains no general `approved → needs_review` edge; undo is recorded as its own audit action.
- **D6 — Context comes from the stored page text.** Driver: KB-16 "next to the source passage it came from" and the anchor's highlighted span; FEAT-012 stored masked page text and exact offsets for this (its D5, ui-design). 160 characters each side shows the sentence around a price without turning the card into the page. Rejected: storing context in `provenance` (duplicates page text per fact and goes stale if FEAT-020 re-crawls).
- **D7 — Set-based writes with per-fact audit entries.** Driver: ADR-010 d3 asks for both; one `UPDATE … FROM VALUES` per batch keeps a few hundred facts fast, while the audit chain appends sequentially by design (ADR-014). AC-10 measures it.
- **D8 — An edit that approves is audited as an approval.** Driver: KB-16 "every approval … is recorded in the audit log". FEAT-011's PATCH path approved `needs_review` facts on edit but only logged `fact.updated`; FEAT-013 closes that gap rather than forbidding the edit there (owners reach extracted facts from Knowledge too).
- **D9 — No schema change.** Driver: the status machine, versions, chunk versions, confirmation time and page text already exist; review is a set of state transitions over them.

## 8. Escalations and open items

- **No architecture amendment.** The commands are ADR-010 decisions 1–3; undo is a recorded reversal of a decision, not a new state (D5).
- **SCR-APP-008 (partial):** the wizard frame is FEAT-035 and the coverage summary is FEAT-019 (KB-09). Plan already credits them; no correction needed.
- **Re-authentication:** design.md §4.10 (sensitive-action pattern) lists Approve all among the confirm-then-re-auth actions "if AUTH-03 requires it". AUTH-03's list doesn't include it and FEAT-006 (two-step verification) isn't built, so Approve all is confirm-dialog only. Recorded for FEAT-006.
- **Conflicts (UC-15 2a, KB-06):** conflicted cards link to `/review/conflicts`, a placeholder until FEAT-014.
- **Stale flags (KB-17):** cards don't show "Stale since…" yet; the stale scan is FEAT-018. Approval already records `last_confirmed_at`.
- **Home KB health (DSH-01):** the needs-review count is available from the summary endpoint for the Home screen's feature.

## 9. Self-check

Requirement coverage: KB-16 → AC-1 (gate), AC-2 (list, passage, confidence, order), AC-3 (approve, edit and approve, reject), AC-4 (bulk by selection), AC-5 (bulk by source and type, Approve all with counts by type and confirmation, audit), AC-6, AC-7, AC-9; KB-15 (p) → AC-3, AC-5, AC-9; KB-17 (p) → AC-3; GOV-01 (p) → AC-3..AC-8, AC-10; UC-15 1 → AC-2, 2 → AC-3, 3 → AC-4/5, 4 → AC-1/3, 3a → AC-5, 3b → AC-5/AC-9. NFR-09, NFR-19 → AC-9; NFR-11 → §5.2 payloads; ADR-005 → AC-8. E2E obligation: UC-15 is in the critical journey J1 (architecture §8.7) → T8 adds `review.e2e.ts`. IDs checked: KB-05/06/07/09/15/16/17, GOV-01, ONB-09, UC-12, UC-15, SCR-APP-008/019/027/028, ADR-005/009/010/014, NFR-09/11/19, FEAT-006/014/018/019/035 resolve. No schema change; contracts keep `/api/v1`, `{ error, message }` and the `version` precondition; the `Fact` shape is unchanged (`ReviewFact` extends it).
