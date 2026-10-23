# Acceptance Report: FEAT-014 — Conflict detection and side-by-side resolution

> Verdict: **Accepted** (first verification; KB-06 gets a full Test ref, KB-17 a partial one) · Date: 2026-10-23
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-11) @ `55b3a90` · Sources: SRS v0.4 (KB-06; KB-17 in part; KB-07, GOV-01 in part; NFR-09, NFR-19), use-cases v0.4 (UC-12 1–3, 2a), ADR-005, ADR-008, ADR-010, ADR-014
> Repo state audited: `5f21bab` (implementation head `f9a2213` plus two test-correction commits)

## Verdict summary

FEAT-014 is accepted. Every criterion from AC-1 to AC-11 has a test that asserts what the criterion says, and all suites were observed green after a cold start.

Four test artifacts asserted less than their criteria, or were unreliable, and are corrected:

- **AC-3:** the test compared statuses by row position, but two facts written in one run share a `created_at`, so their order was random. It failed 1 run in 3 here.
- **AC-8:** no test covered "a fact that is no longer conflicted".
- **AC-11:** axe never ran with the enter dialog or the disable confirm open, and the website's date was never asserted.
- **AC-1:** no browser-level check that a visitor gets no price while the sources disagree.

The corrected tests pass against the code. The new AC-8 test went red when resolve's status and membership checks were removed. There are no rework or design-defect findings.

This verification ran in the same session as the implementation. Its standard was re-derived from the SRS, UC-12 and design §6, not from tasks.md. Every green below was observed in this run, after a `pnpm stack:reset` (volumes wiped, fresh migrations and seed).

## Audit standard

- **KB-06 (M):** "the same entity with different values from different sources (such as two prices for one SKU) is flagged and blocked from use until resolved." Acceptance: "Conflicting prices are never quoted. The owner sees a 'Resolve' list with both sources side by side."
  - Encoded by AC-1 to AC-10 (detection, blocking, the list, the resolutions) and AC-11 (the browser).
  - Faithful, with one recorded widening. Two different values found within one run (two pages of one site) are a conflict too (AC-2, design D3). KB-06 says "different sources", but a site stating two prices is the same risk, and blocking it is stricter, not looser.
  - "Never quoted" is enforced by ADR-010's `visitor_facts` view, which admits only approved facts. AC-1 checks the view, the chunks and visitor search in the same transaction, and (after correction) the widget itself.
- **KB-17 (M), partial:** "When sources disagree (KB-06), the review shows each source's date and suggests the newer one." Encoded by AC-4 (the dates, the strictly newer `suggestedId`, no suggestion on a tie, a manual fact dated by `last_confirmed_at`) and AC-11 (the date line and the Newer tag). The review interval, the stale flag and the correction queue are FEAT-018's (plan §4: "KB-17 (p)").
- **UC-12:**
  - 1 (the Resolve list, side by side) → AC-4, AC-11.
  - 2 (pick one value, or enter one) → AC-5, AC-6.
  - 3 (activate the value, record the decision) → AC-5, AC-6 (visitor visibility and the audit entries).
  - 2a (disable the entity) → AC-7.
  - Postcondition "the conflict is closed and audited" → AC-5 to AC-7 (`kb.conflict.resolved`), AC-8 (staleness), AC-10 (a conflict that ends when a member goes).
- **Binding constraints:** ADR-005 tenant isolation → AC-9. NFR-19 and NFR-09 (accessibility, WCAG 2.2 AA) → AC-11's axe checks. ADR-014 (audit with no PII) → the audit payloads in AC-1, AC-5 and AC-7 carry IDs, codes and counts only.

No criterion is missing and none misencodes its source.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | KB-06; UC-12 precondition | kb `conflicts.int` "flags an approved and a needs_review fact…", "flags a needs_review fact from another source…"; E2E `conflicts.e2e` (widget while conflicted) | kb faithful; E2E widget check added | green |
| AC-2 | KB-06 | kb "writes both of two prices one run finds…" | faithful | green |
| AC-3 | KB-06; D2, D3 | kb unit `conflicts.test.ts` (`sameValue`, `planPromotion`, 17); kb int "agreeing findings…" ×4, "inclusive against exclusive…", "never joins rejected or disabled facts"; FEAT-012 promote tests unchanged | position-dependent → corrected | green ×3 |
| AC-4 | KB-06, KB-17 (p); UC-12 1 | kb "groups by entity…", "suggests nothing when no source is strictly newer…"; api `conflicts.int` list, access and tenant tests | faithful | green |
| AC-5 | UC-12 2–3; KB-07 | kb "use: keeps one value…", "use with a GST choice…"; api use and `gst_required`; E2E use and widget answer | faithful | green |
| AC-6 | UC-12 2 | kb "enter: stores and re-embeds…"; api enter with 400 cases; E2E enter dialog | faithful | green |
| AC-7 | UC-12 2a | kb "disable: … Knowledge re-enables it"; api disable; E2E disable after a cancel | faithful | green |
| AC-8 | UC-12 postcondition | kb "refuses a stale, partial or foreign request…", "refuses a request naming a fact that is no longer conflicted…" (added), "a rejected value is not proposed again…"; api 409 cases; E2E stale toast | gap → test added | green |
| AC-9 | ADR-005 | db `rls.int` "the ingest role moves facts to conflicted in its own tenant only", the ingest-role denial list, the visitor-role cases; api tenant-B test; kb foreign-tenant case | faithful | green |
| AC-10 | KB-06 | kb "deleting the source behind one side…", "a fact written conflicted goes back to review; three … stay open" | faithful | green |
| AC-11 | UC-12, J1; NFR-09, NFR-19 | E2E `conflicts.e2e` | axe on dialogs and the date added → corrected | green |

## Corrected tests

- **AC-3** (`d66320c`): `packages/kb/test/conflicts.int.test.ts` "treats inclusive against exclusive…". The run's two facts are now matched by price, not position; the owner's two facts are still checked in order. Same claim, no longer random. Observed green three runs in a row.
- **AC-8** (`d66320c`): added "refuses a request naming a fact that is no longer conflicted, and writes nothing". Every app path that moves a status also moves the version, so the test changes only the status (owner SQL) to isolate the check. Mutation check: with resolve's `status === 'conflicted'` and membership checks removed, it goes red; restored, green.
- **AC-11 and AC-1** (`5f21bab`): `e2e/tests/conflicts.e2e.ts` now runs axe with the enter dialog open and with the disable confirm open, asserts the website column's "read <date>" line, and asks the widget about the pandan cake before resolving, asserting that neither S$28.50 nor S$27.00 appears.

## Independent execution

On `5f21bab`, after `pnpm stack:reset`:

| Command | Result |
| :-- | :-- |
| `pnpm format:check` | exit 0 |
| `pnpm lint` (ESLint, then depcruise) | exit 0, no dependency violations |
| `pnpm typecheck` | exit 0 |
| `pnpm test:coverage` (unit and integration, per-package thresholds) | exit 0; kb 175, api 127, db 95, agent 345, platform 266 among them |
| `pnpm build && pnpm size` | exit 0; widget loader 9.6 kB gz, initial load within the 30 kB budget |
| `pnpm eval --fast` | exit 0; extraction precision and recall 1.000, prices 1.000 |
| `pnpm test:e2e --project=chromium` | 35 passed, no retries |

Migration `0022` applied cleanly on the wiped database through `pnpm db:setup`.

**Anti-fake-green review.** Test-file diff from before T1 to the head: one removed line, FEAT-012's `update facts set status = 'approved'` in the ingest-role denial list. D8 now allows status and version on purpose. The line was replaced by four still-denied writes (value, GST, provenance, chunk content), and the change is recorded in tasks.md T1. Two FEAT-013 summary tests gained the additive `conflicts` field. `facts.e2e.ts` gained a cleanup of the facts it creates, with no assertion changed (tasks.md T7). No skips, no widened tolerances, no new mocks. Coverage configuration is unchanged over the range.

## Direct verification

- **Audit entries** (GOV-01 in part, ADR-014): the kb tests compare whole entries — `fact.conflicted` (actor `system`/`ingest-worker`, `from`, `version`, `source`), `fact.approved`/`fact.rejected`/`fact.disabled` with `mode: conflict` and one batch, `kb.conflict.resolved { resolution, kept, facts, type, suggested }`, `fact.conflict_cleared { version, to }`. The payloads carry IDs, codes and counts only.
- **Visitor blocking** (KB-06): seen at the view, chunk and search level (kb), and at the widget (E2E, after correction).
- **Screens:** SCR-APP-020 looked at in the browser at 1280 px and 390 px against ui-design.md: side-by-side columns from 640 px and stacked below, the Newer chip and primary button on the newer column only, the GST choice inside the website column, full-width 44 px buttons on mobile, tokens only in the CSS. SCR-APP-019's Conflicts pill and SCR-APP-008's alert render as specified (E2E). The loading skeleton and the permission state were checked in code only.
- **NFRs:** none with a time or load bound applies to this feature. Pending environment: none.

## Findings

- **Rework:** none.
- **Design defect:** none.
- **Minor:**
  - The 390 px axe check uses a tall viewport. At 844 px the fixed bottom tab bar covers a button, and axe reports `target-size` for that overlay. This affects every scrolling dashboard screen, not this one. A shell-level fix (padding the content above the tab bar for axe, or treating the bar as non-obscuring) is worth considering separately.
  - `factsOf`-style helpers that order by `created_at` can tie for rows written in one transaction. The AC-3 test was fixed; other suites weren't audited for the same pattern.

## RTM

Test ref appended:

- KB-06 → `features/FEAT-014-conflicts/acceptance-report.md`
- KB-17 → `features/FEAT-014-conflicts/acceptance-report.md (partial)` (FEAT-018 completes it)
