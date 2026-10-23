# Technical Design: FEAT-014 — Conflict detection and side-by-side resolution

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) and §5 (M2, fourth) · Epic: E2 Knowledge base
> Implements: KB-06 · Also serves: KB-17 (p: each source's date and the newer one suggested), GOV-01 (p: detection and resolution in the audit chain), KB-07 (p: a resolution is live in the same transaction), ONB-09 (p: the conflict count the readiness check will read) · Binding NFRs: NFR-09 (WCAG 2.1 AA), NFR-11 (IDs-only audit), NFR-19 (states)
> Realizes: UC-12 (main flow and alternate 2a); UC-15 2a (a conflicted fact goes to Conflicts); UC-03 7a (p: conflicting entities stay blocked)
> Screens: SCR-APP-020 (built here), SCR-APP-019 and SCR-APP-008 (p: the conflict count and link), designed in [ui-design.md](ui-design.md)
> Status: Verified (self-check §9) · Date: 2026-10-23

## 0. Sequencing note: the M1.5 real-model gate

The gate still waits for an Anthropic API key (FEAT-012 design §0; owner decision of 2026-10-21). FEAT-014 adds no prompt and no model call: detection compares extracted values in code, and resolution is a set of status transitions. No criterion depends on the gate.

## 1. Intent

KB-06 makes one promise: a price (or rule) that two sources state differently is never quoted until the owner says which is right. FEAT-014 keeps it in two places. When a source's facts are promoted (FEAT-012's last stage), each fact is compared with the tenant's other facts about the same entity, and with the run's other findings: where the values disagree, every fact involved becomes `conflicted` and leaves visitor answers in that transaction. The owner then opens **Review · Conflicts**, sees each disagreement with the sources side by side (value, passage, the date each source said it, the newer one suggested, KB-17), and picks one value, enters the right one, or disables the entity (UC-12). It comes fourth in M2, straight after the review gate (FEAT-013), because the crawl can already produce conflicts and FEAT-013 left conflicted cards with nowhere to go.

## 2. Codebase context

Surveyed on `main` at `f778d17` (after FEAT-013, PR #19).

- **Schema:** `facts.status` already has `conflicted` (0002), and `visitor_facts`/`visitor_chunks` (0011) admit only `approved`, so a conflicted fact can't reach a visitor today. `fact_versions` is immutable and records each version's status. Chunks follow the fact's version (FEAT-013 §2). `facts` keeps no entity key: FEAT-012 computes `dedupe_key` (type + normalised name and unit, question or title) in `extract.ts` only for staging.
- **Promote (FEAT-012 §5.4, `ingest/promote.ts`):** collapses the run's staged facts by `dedupe_key`, keeping the highest confidence, so a run that finds two prices for one product keeps one silently. It drops a candidate whose `(type, value)` the tenant already has word for word, embeds the rest, and inserts them as `needs_review` in one transaction under `lockRun`. The ingest role (`app_ingest`) may `SELECT, INSERT` on `facts`, `fact_versions` and `kb_chunks`, but not `UPDATE`.
- **Review (FEAT-013, `review.ts`):** lists `needs_review` and `conflicted` facts with their passages (`passageOf`, source name and capture date), refuses to decide a conflicted fact (`InvalidStateError` "resolve this conflict first", skip reason `conflicted`), and excludes conflicted facts from Approve all. `decideRows` writes a set of status moves (facts, versions, chunk versions, one audit entry each) as the dashboard user. `ReviewSummary.conflicted` counts conflicted facts.
- **Knowledge (FEAT-011):** `updateFact` refuses conflicted and rejected facts; `deleteFact` deletes a fact of any status; `deleteSource` deletes the source's facts.
- **API and dashboard:** routes under `/api/v1/kb/...` with `kb.manage`, the `{ error, message }` envelope, the `version` precondition and `patchOf`/`mergePatch`/`prepareChunk` for edits (`apps/api/src/review.ts`). `/review/conflicts` is a placeholder naming FEAT-014; conflicted cards on `/review` link to it.
- **Divergences (reality wins):**
  - Architecture §5.2 lists `conflicts` among the kb module's data and the plan's FEAT-014 row names `conflicts` as data, but the logical model (§5.3) has no CONFLICT entity and ADR-010 models a conflict as the `conflicted` status. This design follows ADR-010: a conflict is derived from the facts (D1), with no table.
  - ADR-010's state diagram has `conflicted → approved` only. UC-12 (signed off) also needs the losing values dropped and alternate 2a's "disable the entity", so resolution uses `conflicted → rejected` and `conflicted → disabled` as well (§8).

## 3. API contracts

Shapes live in `packages/contracts` (a "conflicts" section after "review"). Auth (`kb.manage`: owner, admin), tenant from the session, the error envelope and malformed-ID handling are as in FEAT-013 §3.

### 3.1 Shapes

```ts
ConflictFact = ReviewFact & {
  sourceDate: string,          // ISO: when this source said it (D4)
  newer: boolean,              // the strictly newest member (KB-17 "suggests the newer one")
}
Conflict = {
  id: string,                  // 16 hex: sha256(entity key), stable while the conflict is open
  type: FactType,
  facts: ConflictFact[],       // ≥ 1, newest first, then higher confidence, then id
  suggestedId: uuid | null,    // the `newer` member, or null when no date is strictly newest
}
ConflictList = { conflicts: Conflict[] }           // KB-16 type order, then oldest first
ReviewSummary += { conflicts: int }                // open conflicts (groups), additive
ResolveConflictBody =                               // discriminated on action
  | { action: 'use',     facts: FactRef[], keepId: uuid, gstTreatment?: 'inclusive'|'exclusive' }
  | { action: 'enter',   facts: FactRef[], keepId: uuid, value, gstTreatment?, validFrom?, validUntil? }
  | { action: 'disable', facts: FactRef[], keepId: uuid }
  // facts: 1–50 distinct refs, every member as listed; keepId must be one of them
ResolveConflictResponse = { fact: Fact, rejected: FactRef[] }
```

`enter`'s edit fields are those of `ApproveFactBody` and are checked against the kept fact's type exactly as the approve route does (`patchOf`).

### 3.2 Endpoints

| Method, path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/v1/kb/conflicts` | — | 200 `ConflictList`: every open conflict of the tenant, each with its facts' passages, source names and dates | 401, 403 |
| `POST /api/v1/kb/conflicts/resolve` | `ResolveConflictBody` | 200 `ResolveConflictResponse`. **use:** the kept fact → `approved` (version + 1, `last_confirmed_at`), the others → `rejected`. **enter:** the kept fact takes the entered value (re-embedded) and → `approved`; the others → `rejected`. **disable:** the kept fact → `disabled`, the others → `rejected` (UC-12 2a). Audit per fact plus one `kb.conflict.resolved` (§5.4) | 409 `conflict_changed` `{ conflict: Conflict \| null }` (a member's version or status changed, a member is missing, or the conflict has a member the request didn't list; nothing written; the fresh conflict, or null if it's gone); 400 `gst_required` (use or enter leaves a price with an unknown GST treatment, KB-15); 400 `bad_request` (shape, `keepId` not among `facts`, edit fields wrong for the type); 503 `unavailable` (embedder; `enter`, or `use` with a GST choice); 401, 403 |
| `GET /api/v1/kb/review/summary` | unchanged | gains `conflicts` | unchanged |
| `GET /api/v1/kb/review/facts`, the FEAT-013 decisions | unchanged | unchanged: conflicted facts are listed with a link here and can't be decided there | unchanged |

Another tenant's fact in `facts` makes the request a 409 `conflict_changed` with `conflict: null` (the tenant has no such member), never a write.

## 4. Schema changes

**No table or column.** One hand-written migration, `0022_kb_conflicts_grants.sql`, gives the ingest trust zone the least it needs to move existing facts into `conflicted` during promote:

```sql
GRANT UPDATE (status, version, updated_by, updated_at) ON facts TO app_ingest;
GRANT UPDATE (fact_version) ON kb_chunks TO app_ingest;
```

It still can't change a fact's value, provenance or GST treatment, delete facts, or read conversations. The journal gets the entry (`meta/_journal.json`, idx 22); there is no DDL, so no snapshot change. Down: `REVOKE` the two grants. `TENANT_SCOPED_TABLES` is unchanged; the RLS suite gains the ingest-role cases (AC-9).

## 5. Component design

```mermaid
sequenceDiagram
    autonumber
    participant IW as "ingest-worker promote"
    participant KB as "kb conflicts.ts"
    participant DB as "Postgres"
    actor O as "Owner"
    participant API as "api /api/v1/kb/conflicts"
    IW->>DB: "tx: lockRun; tenant conflict lock"
    IW->>KB: "planPromotion(candidates, existing facts)"
    KB-->>IW: "duplicates dropped; new facts needs_review or conflicted; existing facts to flag"
    IW->>DB: "insert facts + versions + chunks; flag existing (status, version, chunk version); audit"
    O->>API: "GET conflicts"
    API->>KB: "listConflicts()"
    KB->>DB: "conflicted facts + passages"
    API-->>O: "conflict-compare per entity (newer suggested)"
    O->>API: "POST resolve { facts, keepId, action }"
    API->>KB: "resolveConflict(...)"
    KB->>DB: "tx: lock members; same set and versions; kept approved or disabled; others rejected; audit"
```

### 5.1 Entity key and same value (`packages/kb/src/conflicts.ts`)

- `entityKey(input: FactInput): string` — FEAT-012's `dedupeKeyOf`, moved here and imported by `extract.ts`, so staging and detection share one definition: `product:<name>|<unit>`, `faq:<question>`, `policy:<title>`, `promotion:<title>`, each part lower-cased with whitespace collapsed.
- `sameValue(a, b): boolean` — whether two facts with one key agree (D2):
  - product: the same `priceCents`, and GST treatments that aren't one `inclusive` and the other `exclusive` (`unknown` agrees with either: the price is the same, and KB-15's flag handles the treatment);
  - promotion: the same `priceCents` (or both without), GST as for products, the same `validFrom` and `validUntil`, and the same normalised `details`;
  - policy: the same `kind` and normalised `details`; faq: the same normalised `answer`.
- `conflictId(key) = sha256(key).slice(0, 16)`.

### 5.2 Detection at promote (`planPromotion`, used by `ingest/promote.ts`)

Pure function, unit-tested: `planPromotion(candidates, existing) → { insert: { candidate, status }[], flag: ExistingFact[] }`, where `existing` are the tenant's facts with the candidates' keys (any status).

1. **Within the run**, candidates are grouped by key (they already are by `dedupe_key`). In each group, in confidence order then crawl order, a candidate that has the same value as one already kept is dropped (FEAT-012's collapse, now by value rather than by key alone); one that differs is kept as well. So one product with two prices on two pages keeps both.
2. **Against the tenant**, a kept candidate is dropped as a duplicate when any existing fact with its key has the same value, whatever that fact's status (D3). This widens FEAT-012's "word for word" rule to "same entity, same value", so a value the owner rejected or disabled is not proposed again.
3. **Decision per key.** `live` = existing facts with the key that are `approved`, `needs_review` or `conflicted`. If the key's kept candidates plus `live` hold at least two facts that don't all agree pairwise, every kept candidate is inserted as `conflicted` and every `live` fact not yet conflicted is flagged; otherwise the candidates are inserted as `needs_review`, as before. Existing facts that are `rejected` or `disabled` never join a conflict.

`promoteSource` changes only inside its write transaction: after `lockRun` it takes `pg_advisory_xact_lock(hashtextextended('kb.conflicts:' || tenant_id, 0))`, so two sources promoting at once for one tenant see each other's facts; reads the tenant's facts of the candidates' types (id, type, status, value, GST, validity, version); computes keys in code; locks the matched existing rows `FOR UPDATE` and plans with the locked values; then inserts as now, with each candidate's planned status, and flags existing facts set-based (status `conflicted`, version + 1, `updated_by = 'ingest-worker'`, a version row, the chunk's `fact_version`). Candidates are embedded before the transaction as today; a candidate the plan drops simply isn't written. Audit: one `fact.conflicted { version, from, source }` per flagged existing fact (it leaves visitor answers), and `kb_source.promoted` gains `conflicted` (new facts written as conflicted) when there are any. `kb_sources.facts_count` stays the number of facts written.

A tenant's facts are read whole per promote (a few thousand rows at most): keys are computed in code, the same function as staging, rather than kept in a generated column whose SQL normalisation could drift from it (D5).

### 5.3 Listing and resolving (`conflicts.ts`, dashboard scope)

- `listConflicts(ctx) → ConflictRecord[]`: the tenant's `conflicted` facts, enriched with passage, source name and capture date by the helper FEAT-013's `listReviewFacts` uses (extracted as `withPassages(ctx, rows)` in `review.ts`), plus `lastConfirmedAt`; grouped by `entityKey`; each fact's `sourceDate` = its source's `finishedAt`, or `lastConfirmedAt` for a fact without a source (D4); members ordered newest first, then confidence, then id; `newer`/`suggestedId` on the member whose date is strictly later than every other's. Groups in KB-16 type order, then by their oldest member's `updatedAt`.
- `conflictCount(ctx)`: the number of groups, for `reviewSummary` (which gains `conflicts`).
- `resolveConflict(ctx, refs, keepId, resolution, edit?)` with `resolution` `use | enter | disable` and `edit = { next, chunk }` when the kept fact's content changes (`enter`, or `use` with a GST choice):
  1. Lock the referenced rows `FOR UPDATE` (by id). Every ref must exist in the tenant, be `conflicted`, be at its version, and share one key; and no other `conflicted` fact of the tenant may have that key. Otherwise `ConflictChangedError(fresh conflict | null)`, before any write.
  2. `use`/`enter`: if the kept fact's resulting GST treatment is `unknown` → `GstRequiredError`. Without an edit, the kept fact goes through the set-based writer with status `approved`; with one, it gets the new content, `approved`, a version row and the new chunk (as FEAT-013's edit-and-approve). `last_confirmed_at = now()` either way.
  3. `disable`: the kept fact → `disabled` (UC-12 2a; the owner can re-enable it in Knowledge, FEAT-011).
  4. The other members → `rejected` through the set-based writer.
  5. Audit (§5.4). Returns the kept fact and the rejected refs.
- `settleConflicts(ctx, keys)`: called by `deleteFact` and `deleteSource` with the keys of the conflicted facts they deleted. For each key, if the remaining conflicted facts all agree pairwise (including a single one), each goes back to its status before the conflict: the latest earlier version whose status isn't `conflicted`, or `needs_review` if it was written as conflicted. Audit `fact.conflict_cleared { version, to }`. So deleting a source never leaves another source's fact blocked by a disagreement that no longer exists.

The set-based writer is FEAT-013's `decideRows`, generalised to take the actor (user or system) and the extra target statuses `conflicted` and `disabled`, so promote, resolve and settle share it. `checkReviewable` and the skip reasons are unchanged.

Errors (`errors.ts`): `ConflictChangedError { conflict }` (409 `conflict_changed`); `GstRequiredError` reused.

### 5.4 Audit entries

| Action | Actor | Subject | Payload | When |
|---|---|---|---|---|
| `fact.conflicted` | system `ingest-worker` | `fact` / id | `{ version, from: approved\|needs_review, source }` | an existing fact joins a conflict at promote |
| `kb_source.promoted` | system | `kb_source` / id | gains `conflicted` (count) when above 0 | each promote |
| `fact.approved` | user | `fact` / id | `{ version, mode: conflict, batch }` | the kept value (use, enter) |
| `fact.updated` | user | `fact` / id | `{ version }` | enter, or use with a GST choice, before `fact.approved` |
| `fact.disabled` | user | `fact` / id | `{ version, mode: conflict, batch }` | disable |
| `fact.rejected` | user | `fact` / id | `{ version, mode: conflict, batch }` | each losing value |
| `kb.conflict.resolved` | user | `kb_conflict` / batch id | `{ resolution: use\|enter\|disable, kept, facts, type, suggested: bool }` | once per resolution (UC-12 3) |
| `fact.conflict_cleared` | user | `fact` / id | `{ version, to }` | settle after a delete |

Payloads hold IDs, codes, counts and booleans only (NFR-11); `suggested` records whether the owner kept the suggested (newer) value.

### 5.5 API routes (`apps/api/src/conflicts.ts`)

`registerConflictRoutes(app, deps, sessionFrom)`, `kb.manage` like the review routes. The resolve route parses the body, checks `keepId` is among `facts` (400), loads the kept fact, builds the edit with `patchOf` + `mergePatch` (for `enter`, or `use` with `gstTreatment`), embeds with `prepareChunk` before the transaction when the content changed, then calls `resolveConflict`. `toConflict` maps records with `toReviewFact`. `app.ts` maps `ConflictChangedError` to 409 `{ error: 'conflict_changed', message, conflict }`.

### 5.6 Dashboard

- `/review/conflicts` → SCR-APP-020 `ConflictsPage` under the hub's tabs; the Conflicts tab shows `conflicts` as a danger count pill.
- The Review nav pill and the Facts tab count conflicted facts as waiting (ui-design).
- `/setup/review` (SCR-APP-008) shows an alert with the conflict count and a link to `/review/conflicts` when there are any.
- Details, states and copy in [ui-design.md](ui-design.md).

## 6. Acceptance criteria

- **AC-1 (KB-06 detection, cross-source; UC-12 precondition).** A tenant has an approved product "Pandan chiffon cake, 20 cm" at S$26.00. A website source whose page states S$28.50 is promoted: the new fact is `conflicted`, the approved fact becomes `conflicted` (version + 1, a version row, `fact.conflicted` with actor `ingest-worker` and `from: approved`), and in that transaction neither is in `visitor_facts`, `visitor_chunks` or a visitor search, so a visitor turn on it quotes no price. A needs_review fact with a different value is flagged the same way (`from: needs_review`).
- **AC-2 (KB-06 detection, within a run).** A run whose pages state two prices for one product (same name and unit) writes both, as `conflicted`; two pages stating the same price write one `needs_review` fact (FEAT-012's collapse holds).
- **AC-3 (KB-06 no false conflicts; D2, D3).** A candidate with the same key and value as an existing fact of any status (approved, needs_review, conflicted, rejected, disabled) is not written; S$55.00 with GST `unknown` agrees with S$55.00 `inclusive`; `inclusive` against `exclusive` at one price is a conflict; a candidate whose key matches only rejected or disabled facts with other values is written `needs_review`; facts with different units or names never conflict. FEAT-012's promote tests pass unchanged.
- **AC-4 (KB-06, KB-17; UC-12 1).** `GET /kb/conflicts` returns one conflict per entity with every member's value, passage (quote equal to the page slice), source name and `sourceDate`, newest first; the strictly newest is `newer` and `suggestedId`; equal dates give no suggestion; a manual fact's date is its `last_confirmed_at`. Another tenant's conflicts never appear; an `agent` gets 403; `review/summary.conflicts` counts conflicts, not facts.
- **AC-5 (UC-12 2–3, use).** Resolving with `use` on one member approves it (version + 1, `last_confirmed_at`, chunk at the new version) and rejects the rest; the kept fact is in `visitor_facts` and `visitor_chunks` at once (KB-07) and the next visitor turn on the fixture question quotes its price; the audit chain has `fact.approved` and `fact.rejected` (`mode: conflict`, one batch) and one `kb.conflict.resolved { resolution: use, suggested }` with the user as actor. Keeping a GST-unknown price without `gstTreatment` is 400 `gst_required`; with it, the fact is approved with that treatment (`fact.updated` then `fact.approved`).
- **AC-6 (UC-12 2, enter).** `enter` with a new value on the kept member stores and re-embeds that value, approves it and rejects the rest; edit fields wrong for the type are 400 and change nothing.
- **AC-7 (UC-12 2a, disable).** `disable` leaves the kept member `disabled` and the rest `rejected`; none is in `visitor_facts`; `kb.conflict.resolved { resolution: disable }` is audited; re-enabling the fact in Knowledge (FEAT-011) makes it approved.
- **AC-8 (concurrency and staleness).** A resolve whose refs miss a member, carry a stale version, or include a fact that is no longer conflicted is 409 `conflict_changed` with the fresh conflict (or null), and nothing changes. After a resolution, a later promote of the rejected value writes nothing; one of a third value starts a new conflict with the kept fact.
- **AC-9 (ADR-005).** Tenant B can't list or resolve tenant A's conflicts (409 with `conflict: null`, A's rows unchanged). `app_ingest` can update facts' status and version and chunks' version, but not a fact's value, GST or provenance, and still can't delete facts. `app_agent_visitor` still can't read `facts`.
- **AC-10 (settle).** Deleting the source behind one side of a two-member conflict returns the other member to its earlier status (approved, or needs_review if it was written conflicted), with `fact.conflict_cleared`; deleting one of three disagreeing members leaves the conflict open.
- **AC-11 (UC-12, J1; E2E; NFR-19, NFR-09).** In the browser: with manual prices for two of the fixture site's products, the owner crawls the site; Review shows the conflicted cards with "Resolve conflict", and the Conflicts tab count; SCR-APP-020 shows each conflict with both sources side by side, the website's date, and its "Newer" tag; the owner uses the website value for one (the widget then answers that price), enters a different value for the other through the dialog, and disables a third created the same way; each collapses to a resolved row and the tab empties to the empty state. A stale resolve shows the refresh message. `/setup/review` shows the conflict alert while conflicts remain. No serious axe violations on SCR-APP-020 and its dialogs.

## 7. Decisions

- **D1 — A conflict is derived from facts, not stored.** Driver: ADR-010 models a conflict as the `conflicted` status, and every transition out of it (resolve, settle) is a fact write; a `conflicts` table would be a second record of the same state that every fact path must keep in step. A conflict is the set of `conflicted` facts sharing an entity key; its ID is a hash of the key, and its resolution record is the audit chain (`kb.conflict.resolved` plus one entry per fact). Rejected: a `kb_conflicts` table with members (two sources of truth; it also adds a tenant-scoped table and RLS cases for no behaviour).
- **D2 — "Different values" means different values a visitor would be told.** Driver: KB-06 ("two prices for one SKU") and ADR-008's protected values. Prices, GST basis and promotion dates compare exactly; policy and FAQ texts compare after normalising case and whitespace, so two different refund rules conflict but a capitalisation difference doesn't. GST `unknown` agrees with a stated treatment at the same price, because the price is the same and KB-15 already holds the price back until its treatment is set. Rejected: comparing whole `value` objects (a unit spelt "1kg" vs "1 kg" is already in the key; an extra `unit` field would make agreeing facts conflict).
- **D3 — An agreeing finding is a duplicate, whatever the existing fact's status.** Driver: FEAT-012's word-for-word rule, widened to the entity: proposing a value the owner already has, rejected or disabled adds review work and, for a rejected losing value, would reopen a conflict the owner just resolved (AC-8). Rejected or disabled facts don't join conflicts: the owner has taken them out of answers already.
- **D4 — A source's date is when it said the value.** Driver: KB-17 "shows each source's date and suggests the newer one". For an extracted fact that is its source's `finished_at` (the crawl that read it); for a fact entered by hand it's `last_confirmed_at` (the owner's latest word). Only a strictly newer date is suggested; members of one run share a date, so none is suggested and the owner chooses. Rejected: `updated_at` (moving a fact into `conflicted` changes it).
- **D5 — Keys are computed in code at promote.** Driver: one normalisation shared with staging (`entityKey`), and a KB of at most a few thousand facts per tenant. Rejected: a stored generated `entity_key` column (its SQL normalisation can drift from JavaScript's for non-ASCII whitespace and case, and it needs a migration and backfill for no measurable gain).
- **D6 — Detection runs where facts arrive from sources, not on the owner's own writes.** Driver: KB-06 is about sources disagreeing; a fact the owner types or edits is the owner's word (KB-07, ADR-010 "manual create or edit → approved"). FEAT-015, -016, -017 and -020 call the same `planPromotion`. Consequence: an owner can still approve a review card that disagrees with a fact they typed later; recorded in §8.
- **D7 — Resolving rejects the losing values and keeps one fact.** Driver: UC-12 "the chosen value is active; the conflict is closed". Keeping one fact (the chosen one, or for `enter` and `disable` the member the owner acted on, by default the suggested one) avoids duplicate entities in Knowledge; the rejected versions stay in `fact_versions` for FEAT-021's history and restore. Disable keeps one disabled fact the owner can re-enable (UC-12 2a). There's no Undo: the result is visible at once and reversible in Knowledge. Rejected: disabling every member (several disabled copies of one entity).
- **D8 — The ingest role gets column-level UPDATE.** Driver: flagging an approved fact as conflicted is the one write promote must make to an existing fact (ADR-010 "approved → conflicted: new source disagrees"). Column grants keep the value, GST and provenance out of its reach (ADR-005 least privilege).
- **D9 — Two promotes of one tenant are serialised by an advisory lock.** Driver: two sources finishing together would each miss the other's facts and leave two disagreeing `needs_review` facts unflagged. A transaction-scoped advisory lock keyed on the tenant costs only the promote transaction's length. Dashboard paths don't take it: they lock the rows they change.

## 8. Escalations and open items

- **No architecture amendment.** D1 keeps to ADR-010's status model; `conflicts` in architecture §5.2's data list is read as "conflicted facts". Suggested note for the next architecture revision: list `conflicted → rejected` and `conflicted → disabled` (UC-12 2 and 2a) in ADR-010's state diagram, and drop `conflicts` from §5.2's data list or call it derived. Recorded here, not edited in (AGENTS.md, document rules).
- **Manual writes don't detect (D6).** If the owner approves an extracted card while a fact they typed disagrees with it, both are live. KB-18's correction queue and FEAT-019's coverage report are the places that could surface it; noted for FEAT-018.
- **Plan's data column** names `conflicts` for FEAT-014; per D1 it's the facts table. No plan correction needed beyond this note.
- **Readiness (ONB-09):** `review/summary.conflicts` is the count FEAT-035's readiness warning reads.
- **Home KB health (DSH-01):** same count for the Home screen's feature.
- **Stale flags (KB-17):** the "Stale since…" chip and the stale scan remain FEAT-018; this feature covers KB-17's "shows each source's date and suggests the newer one".
- **SCR-APP-008:** the conflict alert is added here; the wizard frame is FEAT-035.

## 9. Self-check

Requirement coverage: KB-06 → AC-1 (cross-source detection and blocking), AC-2 (within a run), AC-3 (no false conflicts), AC-4 (the side-by-side list), AC-5..AC-7 (resolution), AC-8, AC-10, AC-11; KB-17 (p) → AC-4 (dates, newer suggested), AC-11; GOV-01 (p) → AC-1, AC-5..AC-7, AC-10 (§5.4); KB-07 (p) → AC-5; ONB-09 (p) → AC-4 (`conflicts` count). UC-12 1 → AC-4, 2 → AC-5/AC-6, 3 → AC-5, 2a → AC-7; UC-15 2a → AC-11 (the card's link). NFR-09, NFR-19 → AC-11; NFR-11 → §5.4; ADR-005 → AC-9. E2E obligation: J1 (architecture §8.7 critical journeys; SRS J1 "resolves 2 price conflicts") → T7 adds `conflicts.e2e.ts`. IDs checked: KB-06/07/15/16/17/18, GOV-01, ONB-09, UC-03, UC-12, UC-15, SCR-APP-008/019/020/028, ADR-005/008/010/014, NFR-09/11/19, FEAT-011/012/013/015/016/017/018/019/020/021/035 resolve. Schema: grants only (0022), within `facts`/`kb_chunks`; no new entity (D1). Contracts keep `/api/v1`, `{ error, message }`, `FactRef` with versions and `ReviewFact`; `ReviewSummary` change is additive. Mermaid uses quoted labels.
