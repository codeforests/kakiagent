# Acceptance Report: FEAT-011 — KB manager

> Verdict: **Accepted** (first verification; KB-07 documents deferred to FEAT-012 per design §8, so KB-07, KB-05 and KB-15 stay partial) · Date: 2026-10-20
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-9) @ `f0ba241` · Sources: SRS v0.4 (KB-05, KB-07, KB-15, NFR-10, NFR-11), use-cases v0.4 (UC-13 steps 1–3, UC-20), ADR-005, ADR-008, ADR-010
> Repo state audited: `93b6203` (implementation head), plus this verification's test corrections in `7a185f5`

## Verdict summary

FEAT-011 is accepted. Each of AC-1..AC-9 has tests that assert what the criterion says. Two tests asserted less than their criterion: AC-1's "newest change first" was never checked, and AC-9's axe check skipped the list screen. This verification corrected both, and both pass against the code. Every suite was run in this session from the repo state and was green: format, lint and module boundaries, typecheck, unit, integration with coverage, build and widget size, 16 Chromium E2E specs, both eval modes, and the dependency audit. There are no rework or design-defect findings. KB-07's document browse and delete is deferred to FEAT-012 by design §8, so the RTM marks this report as partial for KB-07, as well as for KB-05 and KB-15.

## Audit standard

- **KB-07** (M): browse, search, edit, disable and delete entities and documents; manual FAQ entry; edits live within 60 s; hand edits count as approved. FEAT-011 covers entities (browse, search, edit, disable, delete, plus manual policies and promotions). Documents need `kb_sources`, which FEAT-012 creates (design §8, plan correction suggested). This is partial by design, not a gap.
- **KB-05** (M, partial): the Policy and Promotion (with validity dates) entity types are covered. Extraction itself is FEAT-012.
- **KB-15** (M, partial): prices with unknown GST treatment are flagged and not quoted until reviewed, and promotion prices follow the GST-inclusive rule.
- **UC-13** steps 1–3 map to AC-1, AC-2/AC-8 and AC-3. Steps 2a, 2b and 4 belong to FEAT-021, FEAT-018 and FEAT-019.
- **NFR-10**: `S$21.80`, `31 Oct 2026` (AC-6). **NFR-11**: the audit payload holds IDs and codes only (AC-2).

The criteria were cross-checked against these sources. Each FR statement in FEAT-011's scope is covered by at least one criterion, and none is misencoded.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | KB-07; UC-13 1 | kb `manager.int.test.ts` "filters by type, status, GST and text across every type", "pages through every row exactly once, even within one millisecond" (7 rows, limit 3, 3 pages, microsecond-distinct `updated_at` within one ms), "refuses a malformed cursor"; api `kb-manager.int.test.ts` "filters by type, GST and text, and pages with nextCursor" (`limit=0`, `limit=201`, bad cursor, bad type, bad gst → 400; default page `nextCursor: null`) | **was weak → corrected**: nothing asserted "newest change first". The API paging test now asserts the order across pages equals creation order reversed | green |
| AC-2 | KB-07; UC-13 2; NFR-11 | api "deletes with the current version: 204, then 404" (missing and zero version → 400; stale → 409 `version_conflict` with the fact still readable; 204 with empty body; second delete → 404; audit `fact.deleted` payload exactly `{type, version}`); api "refuses another tenant's fact, a malformed ID and a staff session" (404, 403 for `agent`, 404); kb "removes the fact, chunk and versions, audits it…" (0 rows left in all three tables; actor recorded) | faithful | green |
| AC-3 | KB-07 (60 s); UC-13 3; ADR-005 | agent `turn.int.test.ts` "never uses a deleted, disabled or ended fact on the next turn"; db `rls.int.test.ts` "the dashboard role deletes its own fact, chunk and versions, and nothing of another tenant" ([0,0,0] cross-tenant, [1,1,1] own), "the visitor role cannot delete from %s" ×3, existing "the visitor role cannot read the base table %s" (SELECT) | faithful. The next turn is checked straight after the delete, well inside the 60 s bound | green |
| AC-4 | KB-05 p; KB-07 | api "creates a policy and a promotion with their validity days round-tripped" and the `it.each` rejection table; kb "creates both by hand as approved, with validity in the version row", "a promotion's GST follows its price; validity is for promotions only"; db schema-check `it.each` (the database refuses the same combinations) | faithful: each listed rejection has a case, including `2026-02-30` | green |
| AC-5 | KB-05 p; ADR-010 d2 | kb `dates.test.ts` (00:00 SGT on D and on D + 1 both ways, invalid days); kb "applies validity in Singapore days: today is in, yesterday ended, tomorrow not yet"; db "visitor_facts applies promotion validity…" (±1 h around both bounds); api round trip of `validFrom`/`validUntil` | faithful. The 23:59/00:00 boundary is proved in two steps: the day-to-instant mapping in the unit tests, then `valid_until > now()` in the view, tested an hour either side. The view uses `now()`, so the exact instant can't be pinned in SQL (minor, below) | green |
| AC-6 | AGT-02; ADR-008; NFR-10 | agent `typed-facts.test.ts` (policy details through the slot; promotion `S$21.80 incl. GST` and `until 31 Oct 2026`; `S$20.00` unregistered; price slot on an unpriced promotion fails; typed "within seven days", "2 days", `S$20`, "31 Oct" and "money-back guarantee" all blocked; fact lines; system text constant); agent turn "answers from a policy and a priced promotion, rendered and cited"; `pnpm eval` with `feat-011-typed-facts.json` | faithful. The T6 mutation check (a wrong recorded output drops prices below threshold) is recorded in tasks.md; the eval was re-run green here | green |
| AC-7 | KB-15 p | kb "stay hidden through unrelated edits and appear once the treatment is chosen" (`needs_review` → an edit approves it and keeps `unknown` hidden; choosing `inclusive` makes it searchable); api "lists GST-unknown prices for review…"; db "a GST-unknown promotion price is hidden at a registered tenant only" | faithful | green |
| AC-8 | KB-07; UC-13 2 | agent turn "never uses a deleted, disabled or ended fact on the next turn" (disabled policy); the list toggle uses the FEAT-022 PATCH with the row's `version` (`facts.tsx` `toggle`), covered by FEAT-022's API version tests | faithful. No E2E drives the list toggle itself (minor, below) | green |
| AC-9 | UC-13 main; UC-20; E2E | `e2e/tests/facts.e2e.ts` "a policy is answered, then deleted from the list and no longer used" | **was weak → corrected**: axe ran on the form and the open dialog but not on SCR-APP-027. Added after the Type filter. The visitor question is "what is your cake order refund policy?" rather than the AC's example wording, which is equivalent for the criterion | green |

## Corrected tests

Commit `7a185f5` (`FEAT-011 acceptance: correct tests for AC-1 and AC-9`). Test files only; no production code changed.

- **AC-1**, `apps/api/test/kb-manager.int.test.ts`: the paging loop now keeps the created IDs and asserts `seen` equals `created.toReversed()`. This replaces the count-and-uniqueness check, and is strictly stronger. Not mutation-checked.
- **AC-9**, `e2e/tests/facts.e2e.ts`: `expectNoSeriousA11yViolations(owner)` on the filtered list before the visitor asks.

## Independent execution

Run in this session on the local stack (Postgres 16 + pgvector, Valkey, LocalStack, Mailpit) at `93b6203`. After the corrections, the two changed suites were run again at `7a185f5`.

| Command | Result |
|---|---|
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | green (26 typecheck tasks) |
| `pnpm test` | green (21 tasks) |
| `pnpm test:coverage` (Testcontainers, fresh Postgres: every migration 0000–0011 applied from empty) | green, thresholds met: db 70, kb 30, api 44, agent 203, governance 93, platform 265, identity 30, llm-gateway 36, analytics 7, inbox 5, channels 2 |
| `pnpm build && pnpm size` | green: loader 1.75 KB gz, panel 9.34 KB gz, initial 1.75 KB gz; no dev sign-in in any bundle |
| `pnpm test:e2e --project=chromium` | 16/16 green; after the correction, `facts.e2e.ts` 2/2 green |
| api `kb-manager.int.test.ts` after the correction | 16/16 green |
| `pnpm eval` / `pnpm eval --fast` | 73 / 61 cases, every threshold met; S$0.00136 per conversation on the fake provider |
| `pnpm audit --prod --audit-level=high` | no known vulnerabilities |

Firefox and WebKit E2E are not installed locally. They run in CI, and their results are on the PR. No flakiness was seen.

## Direct verification

- **Audit (NFR-11)**: the `fact.deleted` entry was inspected through the tests' query of `audit_entries`. The payload is `{type: 'policy', version: 2}`, with the actor reference and no fact text.
- **Hard delete (D1)**: after a delete, no row remains in `facts`, `fact_versions` or `kb_chunks`, checked as the table owner (bypassing RLS).
- **KB-15**: the seeded "Ondeh ondeh box" (GST unknown) shows the "GST to check" chip on SCR-APP-027 and the review alert on SCR-APP-028, and it is absent from `visitor_facts`.
- **Screens**: SCR-APP-027 and SCR-APP-028 were checked in the browser at 1280 px and 390 px against the manifest states: the filters, the row menu, the ended and upcoming promotion chips, the GST chip and alert, promotion form validation, the Delete button, and the delete dialog as a bottom sheet with Cancel focused. Only design tokens are used.
- **Pending environment**: none specific to this feature. Real-model behaviour of the new slot fields is re-run at M1.5 with the whole eval set (design §6).

## Findings

- **Rework**: none.
- **Design defect**: none.
- **Minor**:
  1. AC-5's exact 23:59/00:00 SGT instant is proved in two steps (the mapping unit tests plus the view tested ±1 h), because `visitor_facts` uses `now()`. A test that sets `valid_until` 1 s either side of `now()` would tighten it. Not blocking.
  2. AC-8's list toggle is not driven in an E2E. The PATCH it uses is the FEAT-022 endpoint, with that feature's version-conflict tests. Not blocking.
  3. Plan correction carried from design §8: credit KB-07 document browse and delete to FEAT-012 and FEAT-015.

## RTM

Test ref appended for KB-05, KB-07 and KB-15: `features/FEAT-011-kb-manager/acceptance-report.md (partial)`.
