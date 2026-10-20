# Technical Design: FEAT-011 — KB manager

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Epic: E2 Knowledge base
> Implements: KB-07, KB-15 (p), KB-05 (p) · Binding NFRs: NFR-10 (SGD and date formats), NFR-11 (IDs-only logs and audit)
> Realizes: UC-13 (main flow steps 1–3)
> Screens: SCR-APP-027, SCR-APP-028, designed in [ui-design.md](ui-design.md)
> Status: Verified (self-check §9) · Date: 2026-10-20

## 1. Intent

FEAT-022 built the narrow end of the knowledge base: an owner can type a product price or an FAQ, edit it and switch it off, and the next visitor turn uses it. FEAT-011 turns that into the KB manager KB-07 asks for. The owner can browse and search all facts by type, state and GST, page through a large list, and delete a fact. They can also enter the other typed entities KB-05 lists that belong in the fact store: **policies** and **promotions with validity dates**. Prices whose GST treatment is unknown are flagged for review (KB-15). It comes next in M1 (plan §5) because FEAT-012 (website crawl and extraction) writes into these same types and states. The owner's review and edit screens have to exist before extracted facts arrive in bulk.

## 2. Codebase context

Surveyed on `main` at `b9f1ea6` (after FEAT-004, PR #12).

- **Schema:** migrations 0000–0009. `facts`, `fact_versions` and `kb_chunks` (0002) with forced RLS, the `visitor_facts` and `visitor_chunks` views owned by `kaki_visitor_views`, and `visitor_tenant_state()` (0003, last recreated in 0009). `facts.type ∈ {product, faq}`. `facts.valid_until` exists and the view filters on it, but nothing writes it yet. `app_dashboard` has `SELECT, INSERT, UPDATE` on facts and chunks and `SELECT, INSERT` on versions, with **no `DELETE`** (FEAT-022 §4 left deletion to this feature).
- **Module:** `packages/kb` (`facts.ts`: `listFacts`, `getFact`, `createFact`, `updateFact`, `mergePatch`, `contentChanged`; `chunk.ts`; `visitor.ts`; scope-typed contexts). The API routes are in `apps/api/src/facts.ts`, with contracts in `packages/contracts` (the "facts" section). Errors use the `{ error, message }` envelope (`bad_request`, `unauthorized`, `forbidden`, `not_found`, `version_conflict`, `invalid_state`, `unavailable`). The capability is `kb.manage` (owner, admin).
- **Agent:** slots `[[f:<ref>.<field>]]` (`slots.ts`, `SLOT_FIELDS`, `PROTECTED_FIELDS`), `renderSegment` / `renderPrice` (`render.ts`), `factLine` in the prompt tail (`prompt.ts`), and `fakeVisitorResponder`, which reads the fact lines. Evals load typed fixtures (`evals/src/cases.ts` `Fixture`) and score `prices-from-facts` against rendered product prices (`run.ts`).
- **Dashboard:** SCR-APP-027 (`pages/facts.tsx`) and SCR-APP-028 (`pages/fact.tsx`) from FEAT-022, plus `lib/facts.ts` display rules. `@radix-ui/react-dropdown-menu` is already a dependency (the account menu). There is no dialog component yet.
- **Conventions reused:** `withTenant`, `audit.append` (IDs only), embed before the transaction (FEAT-022 D4), optimistic concurrency on `version`, `TENANT_SCOPED_TABLES` with cases in `rls.int.test.ts`.
- **Divergences (reality wins):** the plan names the block `/kb/facts/*`; the routes are `/api/v1/kb/facts/*` (FEAT-022 §2). KB-07's "documents" have no table yet: `kb_sources` arrives with FEAT-012 (§8).

## 3. API contracts

All shapes live in `packages/contracts`. Auth, capability (`kb.manage`), tenant-from-session and the error envelope are unchanged from FEAT-022 §3.2.

### 3.1 Fact shape (extended)

```ts
FactType   = 'product' | 'faq' | 'policy' | 'promotion'
PolicyKind = 'refund' | 'delivery' | 'booking' | 'payment' | 'other'
SgDate     = 'YYYY-MM-DD'                         // a calendar day in Singapore
ProductValue   = { name: 1..200, price: Money, unit?: 1..60 }                    // unchanged
FaqValue       = { question: 1..300, answer: 1..2000 }                            // unchanged
PolicyValue    = { kind: PolicyKind, title: 1..120, details: 1..2000 }
PromotionValue = { title: 1..120, details: 1..2000, price?: Money }
Fact = {
  id, type, status, version, source, updatedAt,   // unchanged
  value,                                          // discriminated by `type`
  gstTreatment: GstTreatment | null,              // product: required; promotion: iff price; faq, policy: null
  validFrom: SgDate | null,                       // promotion only (null for the others)
  validUntil: SgDate | null,                      // promotion: required, the last day it runs
}
```

The product type is labelled "Product or service" on screen. KB-05's Price entity is the product's price (amount, SGD, unit, GST treatment). Price validity on products is written by extraction later (§8). Business hours and location are the business profile's (FEAT-009), not facts.

Validity is entered as Singapore calendar days. It is stored as instants: `valid_from` = 00:00 SGT on the start day, and `valid_until` = 00:00 SGT on the day **after** the end day (exclusive). A promotion that ends on 31 Oct is therefore visible until 23:59:59 SGT that day. The API converts both ways (`kb/dates.ts`).

### 3.2 Endpoints

| Method, path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/v1/kb/facts` | query `status?`, `type?` (FactType), `gst?` (`unknown`), `q?` (≤ 100 chars; case-insensitive match on name, unit, question, answer, title, details), `cursor?` (opaque, ≤ 200 chars), `limit?` (1–200, default 50) | 200 `{ facts: Fact[], nextCursor: string \| null }`, newest change first (`updated_at desc, id desc`) | 400 `bad_request` (including a malformed cursor), 401, 403 |
| `GET /api/v1/kb/facts/:id` | — | 200 `{ fact }` | unchanged |
| `POST /api/v1/kb/facts` | `{ type, value, gstTreatment?, validFrom?, validUntil? }`, one variant per type (below) | 201 `{ fact }`, `approved`, version 1 | 400 (validation, below), 401, 403, 503 `unavailable` |
| `PATCH /api/v1/kb/facts/:id` | `{ version, value?, gstTreatment?, validFrom?: SgDate \| null, validUntil?: SgDate, status?: 'approved' \| 'disabled' }`, at least one change | 200 `{ fact }`, version + 1 | 400, 401, 403, 404, 409 `version_conflict`, 409 `invalid_state`, 503 |
| **`DELETE /api/v1/kb/facts/:id`** | query `version` (int ≥ 1, required) | **204**, no body | 400 (missing or bad `version`), 401, 403, 404 (no such fact, another tenant's ID, or already deleted), 409 `version_conflict` (the fact changed since it was loaded) |

**Create variants** (`gstTreatment` for manual entries ∈ `inclusive | exclusive`, as before):
- `product`: `value: ProductValue`, `gstTreatment` required. No validity.
- `faq`: `value: FaqValue`, no GST, no validity.
- `policy`: `value: PolicyValue`, no GST, no validity.
- `promotion`: `value: PromotionValue`, `validUntil` required, `validFrom` optional, and `validFrom ≤ validUntil`. `gstTreatment` is required when `value.price` is present and must be absent when it isn't.

**PATCH merge rules.** The route validates `value` against the fact's own type. kb's `mergePatch` builds the full next fact and checks the cross-field rules. A promotion's price and GST treatment go together. Removing the price clears the treatment. Adding a price needs a treatment. A stored `unknown` treatment is kept on an edit that doesn't touch it. Validity is accepted for promotions only. Any rule failure is 400 `bad_request` (`InvalidFactError`). The FEAT-022 status rules are unchanged. A content edit (value, GST or validity) on `needs_review` approves the fact (KB-07: hand edits count as approved), and setting the GST treatment of an `unknown` price is such an edit (KB-15 review). `status` moves `approved ↔ disabled` only.

**DELETE semantics.** This is a hard delete of the fact, its chunk and its versions, in one transaction with a `fact.deleted` audit entry (`payload: { type, version }`, IDs and codes only, NFR-11). Any status may be deleted, including `needs_review`, `rejected` and `conflicted`. The conditional `version` makes a delete of a fact someone just edited fail with 409 instead of silently removing their change. Because the chunk and the fact go in the same transaction, the next visitor turn can't retrieve it (KB-07's 60 s, at commit). See D1 for why the delete is hard.

**Cursor.** The cursor is base64url of `"<updated_at as Postgres text, microseconds>|<id>"`. The list query adds `(updated_at, id) < (cursor)`. The text form keeps Postgres's microseconds, because a JS `Date` would round them and skip or repeat rows (D5). `nextCursor` is null when the page held fewer than `limit` rows.

## 4. Schema changes

Migration `0010_fact_types` (drizzle-kit DDL from `schema.ts`) and `0011_fact_types_rls` (hand-written views and grants), against 0000–0009.

| Change | Conceptual entity | Definition |
|---|---|---|
| `facts.type` check | FACT (KB-05 typed entities) | `type in ('product', 'faq', 'policy', 'promotion')`; `FACT_TYPES` gains `policy`, `promotion` |
| `facts.valid_from timestamptz null` | FACT (Promotion validity, KB-05) | Start instant (inclusive). `valid_until` already exists (end, exclusive) |
| `facts_gst_ck` replaced | FACT (KB-15) | `gst_treatment in (inclusive, exclusive, unknown)` or null, and `(type = 'product' and gst_treatment is not null) or (type in ('faq','policy') and gst_treatment is null) or (type = 'promotion' and (value ? 'priceCents') = (gst_treatment is not null))` |
| `facts_validity_ck` (new) | FACT | `(type <> 'promotion' or valid_until is not null) and (valid_from is null or valid_until is null or valid_from < valid_until)`. Products may carry validity in the database (extraction sets price validity later, §8); the API accepts manual validity for promotions only |
| index `facts_tenant_updated_idx` | FACT | `(tenant_id, updated_at desc, id desc)`: the list's order and cursor |
| `fact_versions.valid_from`, `fact_versions.valid_until timestamptz null` | FACT_VERSION (KB-14) | A version records the validity it had |
| View `visitor_facts` replaced | ADR-010 decision 2 | Same columns, plus `valid_from` and `valid_until` appended (so the renderer can say "until 31 Oct 2026"). Where clause: approved, `(valid_from is null or valid_from <= now())`, `(valid_until is null or valid_until > now())`, and not (`gst_treatment = 'unknown'` at a GST-registered tenant) for **any** priced type, not only products. Still `security_barrier`, still owned by `kaki_visitor_views` |
| Grants | ADR-005 | `GRANT DELETE ON facts, fact_versions, kb_chunks TO app_dashboard`. `app_agent_visitor` is unchanged (views only). `fact_versions` stays without `UPDATE` for every role |

`visitor_chunks` reads `visitor_facts` and needs no change: `CREATE OR REPLACE VIEW` can append columns to `visitor_facts` without dropping its dependants. `facts.value` shapes: policy `{ kind, title, details }`; promotion `{ title, details, priceCents?, currency?: 'SGD' }`. Rollback is forward-only, as in earlier migrations: a later migration would restore the 0003 view text and drop the new constraint, column and grants.

## 5. Component design

```mermaid
sequenceDiagram
    autonumber
    participant UI as "Dashboard (027 / 028)"
    participant API as "api /api/v1/kb/facts"
    participant KB as "kb.facts"
    participant DB as "Postgres (dashboard zone)"
    participant V as "Next visitor turn"
    UI->>API: "DELETE /:id?version=3"
    API->>KB: "deleteFact(ctx, id, 3)"
    KB->>DB: "lock fact where version = 3"
    KB->>DB: "delete chunk, versions, fact; audit fact.deleted"
    DB-->>API: "commit"
    API-->>UI: "204"
    V->>DB: "visitor_chunks k-NN (fact gone)"
```

**`packages/kb`:**
- `types.ts`: `PolicyValue`, `PromotionValue` and `Validity { validFrom: Date | null; validUntil: Date | null }`. `FactInput` gains the policy and promotion variants (promotion carries `validity`). `VisitorFact` gains them too, with `validUntil: Date | null` on the promotion.
- `dates.ts` (new): `sgDayStart('2026-10-31')` → `2026-10-30T16:00Z`; `sgDayAfter('2026-10-31')` → `2026-10-31T16:00Z`; and the inverses `sgDateOf(instant)` and `sgLastDayOf(exclusiveEnd)`. Pure, unit-tested across the SGT midnight boundary.
- `facts.ts`:
  - `listFacts(ctx, { status?, type?, gst?, q?, cursor?, limit })` → `{ facts, nextCursor }`, with the search fields and keyset cursor of §3.2. It throws `InvalidCursorError` for a cursor that doesn't decode.
  - `createFact` and `updateFact` write `valid_from` and `valid_until`, and the version row carries them.
  - `mergePatch` covers the four types and the cross-field rules (`InvalidFactError`).
  - `contentChanged` includes validity.
  - **`deleteFact(ctx, id, version)`**: `select … for update` on the fact (404 if missing), compare the version (409), then delete the chunk, the versions and the fact, and write the `fact.deleted` audit entry.
- `chunk.ts`: `chunkContent` for a policy is `"{title}\n{details}"` and for a promotion `"{title}\n{details}"`, so a question about "refunds" or "Deepavali" finds them.
- `visitor.ts`: selects `valid_until` and maps it onto promotion facts.
- `errors.ts`: `InvalidFactError` and `InvalidCursorError` (both 400).

**`packages/agent`:**
- `slots.ts`: `SLOT_FIELDS.policy = [title, details]`, `SLOT_FIELDS.promotion = [title, details, price, valid_until]`. `PROTECTED_FIELDS.policy = [title, details]` (policy terms are protected values, ADR-008 decision 2). `PROTECTED_FIELDS.promotion = [title, details, price, valid_until]` (titles like "Buy 2 get 1 free" carry offers).
- `render.ts`: `renderPrice` takes any priced fact (`{ value.priceCents, gstTreatment }`), so promotions get the same KB-15 GST rule. `valid_until` renders the last day as `31 Oct 2026` (NFR-10, design.md §6 date format). A promotion slot for `price` when it has no price is an `unknown_field` failure.
- `prompt.ts` `factLine`: `[f:ref] policy | kind: refund | title: … → [[…title]] | details: … → [[…details]]`, and `[f:ref] promotion | title: … → … | details: … → … | price: S$… → … | until: 31 Oct 2026 → [[…valid_until]]`. The static system text gains the new types in its list of protected fields; it stays the same for every tenant and turn (cache layout, FEAT-004 AC-3).
- `fake-responder.ts`: answers a policy with `[[f:ref.details]]`, and a promotion with `[[f:ref.title]]: [[f:ref.details]]`, followed by `([[f:ref.price]], until [[f:ref.valid_until]]).` when it has them.

**`apps/api` (`facts.ts`):** the list query (type, gst, cursor, limit), the create variants, PATCH for the new types and validity, and the DELETE route. Error mapping gains `InvalidFactError` and `InvalidCursorError` → 400, and `FactNotFoundError` on DELETE → 404. `toFact` maps the new types and the validity dates.

**`apps/dashboard`:** SCR-APP-027 gains the type and GST filters, "Load more", the GST-unknown flag and per-row actions (use in answers, stop using, delete). SCR-APP-028 gains the policy and promotion forms, the GST-unknown review prompt and Delete. A `ConfirmDialog` built on `@radix-ui/react-dialog` goes in `@kaki/ui` (design.md §4.3 `confirm-dialog`). The details are in ui-design.md.

**`evals`:** fixtures gain a bakery refund policy and a promotion (with price, GST exclusive, valid until a far date). `Fixture` accepts the new types. `renderedPrices` includes promotion prices. A new case file `feat-011-typed-facts.json` holds groundedness and price cases for both, plus adversarial recordings: a typed refund period, a typed promotion price, and a typed end date.

**Dev data:** the seed adds an approved bakery product whose GST treatment is unknown ("Ondeh ondeh box, 12 pieces — S$18", source `dev_seed`). It shows up in the GST filter and must not reach a visitor, because the bakery is GST-registered.

## 6. Acceptance criteria

- **AC-1 (KB-07; UC-13 1).** `GET /api/v1/kb/facts` filters by `type` (each of the four), `status`, `gst=unknown`, and `q` over every type's text fields, alone and combined. Results are newest change first. With 7 facts and `limit=3`, following `nextCursor` returns all 7 exactly once and ends with `nextCursor: null`, including facts whose `updated_at` share a millisecond. A malformed cursor and `limit=0` return 400.
- **AC-2 (KB-07; UC-13 2).** `DELETE /api/v1/kb/facts/:id?version=N` returns 204 and removes the fact, its chunk and all its versions in one transaction, with a `fact.deleted` audit entry carrying type and version and no fact text. A stale `version` returns 409 `version_conflict` and deletes nothing. A missing `version` returns 400. A second delete, or another tenant's fact ID, returns 404. An `agent`-role session gets 403.
- **AC-3 (KB-07, 60 s; UC-13 3).** After the DELETE returns, the very next visitor turn for that question cites neither the deleted fact ID nor its value. With RLS, `app_dashboard` in tenant B's context deletes 0 rows of tenant A's facts. `app_agent_visitor` has no `DELETE` (or `SELECT`) on `facts`, `fact_versions` or `kb_chunks`.
- **AC-4 (KB-05 p; KB-07).** Policies and promotions can be created by hand. They are `approved`, version 1, with a version row (validity included), a chunk and a `fact.created` audit entry. These are rejected with 400: a policy with a GST treatment; an unknown policy kind; a promotion without `validUntil`; `validFrom` after `validUntil`; a promotion price without a GST treatment, or a treatment without a price; validity on a product, FAQ or policy; a date that isn't a real calendar day (`2026-02-30`).
- **AC-5 (KB-05 p; ADR-010 d2).** Promotion validity is applied in Singapore time. A promotion with `validUntil = D` is in `visitor_facts` at 23:59 SGT on D and not at 00:00 SGT on D + 1. One with `validFrom = D` isn't visible before 00:00 SGT on D. Round trip: the API returns the same `validFrom` and `validUntil` days it was given.
- **AC-6 (AGT-02 with the new types; ADR-008).** A policy answer releases its details only through `[[f:…details]]`. A promotion renders `title`, `details`, its price under the KB-15 rule (exclusive S$20 at the GST-registered bakery → `S$21.80 incl. GST`) and `until 31 Oct 2026` from `valid_until`. Typed in by the model instead of slotted, the refund period ("within seven days"), the promotion price (`S$20`) and the end date (`31 Oct`) are each blocked by the verifier. The eval `groundedness` and `prices` subsets pass their thresholds with the new cases.
- **AC-7 (KB-15 p).** A product or promotion price with GST treatment `unknown` at a GST-registered tenant is listed by `gst=unknown` and never reaches `visitor_facts`. A PATCH that sets its treatment to `inclusive` or `exclusive` makes it visible to the next visitor turn (approving it if it was `needs_review`). An edit of another field keeps `unknown` and keeps it hidden.
- **AC-8 (KB-07; UC-13 2).** Disabling and re-enabling from the list uses the FEAT-022 PATCH (`status`) with the row's version. A disabled policy or promotion isn't retrieved by the next turn.
- **AC-9 (UC-13 main flow; E2E).** In the browser, the owner adds a refund policy on SCR-APP-028, finds it on SCR-APP-027 by filtering on Policies, and a visitor asking "can refund if I cancel?" sees the policy details in the reply. The owner then deletes the policy from its row menu, confirms the dialog, and sees the toast. The next identical visitor question doesn't contain the details. No serious axe violations on either screen or on the open dialog.

All criteria are verifiable in M1 on the fake provider. The real-model behaviour of the new slot fields (AC-6) is re-run at M1.5 with the rest of the eval set.

## 7. Decisions

- **D1 — Deletion is a hard delete of the fact, chunk and versions, with an audit entry.** Driver: KB-07 says "delete" (not "archive"), and GOV-05 requires KB data containing personal data to be removable, chunks included. KB-14 keeps versions of *edits*; a delete isn't an edit. The audit chain keeps the fact ID, type and last version (GOV-01 "KB edits"), and messages keep their `fact_ids`. So "which fact did this answer cite" stays answerable by ID, though not by content. Rejected: a soft delete (`deleted_at`). It would add a sixth lifecycle state to ADR-010's machine (an architecture amendment), and it would keep text a tenant asked to remove. Consequence: FEAT-021 (restore) can't restore a deleted fact; it restores earlier versions of live facts.
- **D2 — Policy and promotion are fact types; product doubles as service.** Driver: KB-05's typed entities and ADR-010's single `facts` table. A service differs from a product only in wording, so one type with the label "Product or service" avoids a fourth price-carrying shape. KB-03's Product and Service columns map to it. Business hours and location are BUSINESS_PROFILE (FEAT-009, ONB-03). Rejected: separate `service` and `price` types, which would duplicate the price and GST logic.
- **D3 — Validity as Singapore calendar days, stored as instants with an exclusive end.** Driver: owners think in days ("until 31 Oct"), and the view compares with `now()`. Storing the instant keeps the view a plain comparison with no time-zone maths in SQL. Rejected: `date` columns, which need `now() at time zone 'Asia/Singapore'` in the view and are easy to get wrong at midnight.
- **D4 — Promotion titles and details are protected slot fields.** Driver: ADR-008 decision 2 (dates, prices and policy terms come from slots), and D13–D15 of FEAT-022 (the model types no numbers). A promotion's wording is its offer ("Buy 2 get 1 free till Sunday"). Paraphrasing it is how an invented offer gets out. Cost: replies quote the owner's wording verbatim, which reads stiffer than a paraphrase.
- **D5 — Keyset pagination with a text timestamp cursor.** Driver: FEAT-012 will bring hundreds of extracted facts, so the FEAT-022 cap of 200 rows silently hides facts. An offset would skip rows while the owner edits (each edit moves a row to the top). The cursor carries Postgres's microsecond text, because a JS `Date` loses microseconds and two rows in one millisecond would be skipped or repeated.
- **D6 — DELETE takes the version as a query parameter.** Driver: the codebase's optimistic-concurrency convention (`version` on PATCH) and HTTP semantics (a DELETE body is unreliable through proxies). Rejected: an `If-Match` header, which would be the only header-based precondition in the API.
- **D7 — Promotion expiry needs no job here.** Driver: `visitor_facts` already hides a promotion after `valid_until`, at the moment it passes. UC-14 step 3 ("disables expired promotions automatically") changes the *status* for the re-crawl diff, and it belongs to FEAT-020 (KB-08). The list shows "Ended" for a past `validUntil` so the owner can see why it isn't used.

## 8. Escalations and open items

- No architecture amendment: every change is physical, within FACT and FACT_VERSION (architecture §5.3). D1 keeps ADR-010's five statuses.
- **KB-07 "documents"** (browse and delete sources) needs `kb_sources`, which FEAT-012 creates together with the source screens SCR-APP-023 and SCR-APP-024. The plan lists FEAT-011's data as facts, versions and chunks only. **Plan correction suggested:** credit document browse and delete to FEAT-012 (and FEAT-015 for files), with KB-07 staying "(partial)" in the RTM until then. Deleting a source must remove its facts' chunks the same way `deleteFact` does.
- **Price validity on products** (KB-05's Price "validity") uses the same columns, but no manual input is offered. Extraction (FEAT-012) sets it, and SCR-APP-028 can show it read-only then.
- **SCR-APP-028 sources, review interval and version history** remain FEAT-012, FEAT-018 and FEAT-021 (manifest gaps carried over).
- **Bulk disable or delete** from the list isn't built. KB-07 doesn't ask for it, and KB-16's bulk approval is FEAT-013.

## 9. Self-check

Requirement coverage: KB-07 → AC-1, AC-2, AC-3, AC-8, AC-9 (browse, search, edit via FEAT-022, disable, delete, manual FAQ as before); documents are deferred with a plan correction (§8). KB-05 (p) → AC-4, AC-5, AC-6. KB-15 (p) → AC-6 (promotion GST rendering) and AC-7. UC-13 steps 1–3 → AC-1, AC-2/AC-8, AC-3. NFR-10 → AC-6 (`S$21.80`, `31 Oct 2026`). NFR-11 → the AC-2 audit payload. E2E obligation: the new types reach visitors through UC-20, a critical flow (J2, architecture §8.7), and the delete path completes UC-13 steps 1–3, which FEAT-022 already covers end to end → T10 extends `facts.e2e.ts`. IDs checked: KB-05, KB-07, KB-14, KB-15, GOV-01, GOV-05, UC-13, UC-14, SCR-APP-027/028/023/024, ADR-005/008/010, NFR-10/11 all resolve. Every schema change is on FACT or FACT_VERSION. The contracts keep `/api/v1` and `{ error, message }`. The one breaking change, the `nextCursor` field and the default page size of 50 (was 200), is absorbed by the dashboard in the same PR. There is no other consumer.
