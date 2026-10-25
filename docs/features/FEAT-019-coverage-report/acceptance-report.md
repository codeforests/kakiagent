# Acceptance Report: FEAT-019 — Coverage report (template topics before go-live, gaps after)

> Verdict: **Accepted** (AC-10's E2E, renders and axe green in Ken's local CI, 2026-10-25) · Date: 2026-10-24
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-10) · Sources: SRS v0.4 (KB-09, KB-18), use-cases v0.4 (UC-03 step 7, UC-13 step 4, UC-16 3b), ADR-005, ADR-009, ADR-010, ADR-014, ADR-015
> Repo state audited: `56c63a7` (implementation head); one test correction, `1f211c0`

## Verdict summary

FEAT-019 is accepted. Each of AC-1..AC-10 has tests that assert what the criterion says; AC-10's renders, axe checks and the E2E path (`e2e/tests/coverage.e2e.ts`) run only in Ken's local CI and are pending. The feature's test diff only adds cases: no assertion was loosened, skipped or deleted. One AC-4 case was missing (a `refused` turn) and is added here.

This session didn't write the code. The standard was re-derived from KB-09, KB-18, UC-16 3b and design §6, not from tasks.md, and every green below was observed in this run.

## Audit standard

- **KB-09 (M):** "lists common customer topics for the industry that the KB cannot yet answer. Before go-live it uses the industry template's topic list (ONB-06). After go-live it shows the top gaps from escalated or unanswered questions." Encoded by AC-2, AC-3 (template topics), AC-4, AC-5, AC-6 (gaps), AC-9 (degraded matching), AC-10 (screens). Faithful. Go-live is "first conversation" until FEAT-034 (D4); only the F&B template exists (ONB-06, FEAT-009).
- **KB-18 (M), coverage-gap source:** gaps enter the one queue, and nothing changes the KB until the Owner or an Admin accepts. Encoded by AC-5, AC-7. Faithful; the rest of KB-18 is FEAT-018's.
- **UC-16 3b** (a coverage gap answered with an FAQ) → AC-7. **UC-03 7, UC-13 4** (coverage check during set-up and review) → AC-2, AC-3, AC-10.
- **Invariants:** ADR-005 → AC-1; ADR-009 (the visitor zone never writes the queue; grouping runs as a NOLOGIN definer) → AC-5, RLS cases; ADR-010 (accept is the only path to a fact) → AC-5, AC-7; ADR-014/015 → AC-8.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | KB-09, ADR-005 | api `coverage.int` "needs kb.manage and a session", tenants kept apart in the topic and gap cases; db `rls.int` "coverage gaps (FEAT-019)" (tenant B reads no gap messages or items; visitor role sets only the two gap columns of its tenant; dashboard skips topics on its own profile; only `app_outbox` runs the job) | faithful | green |
| AC-2 | KB-09 | kb `coverage.int` "covers by FAQ key and by a near visible fact; never by unreviewed, disabled or conflicted facts", "no template section…"; the topic query uses the same conditions as the `visitor_facts` view (0011) | faithful | green; render pending CI |
| AC-3 | KB-09 | tenancy `coverage.int` (skip/un-skip audited with the topic ID only, unknown topic refused); api "covers one after an FAQ is added, and skips per tenant", "404 for an unknown topic" | faithful | green; E2E pending CI |
| AC-4 | KB-09 | agent `turn.int` "marks an escalated, an unavailable and an unsure answer turn once" (redelivery included), "doesn't mark answered, out-of-scope, refused, paused or safety-ended turns", "doesn't mark a turn whose embedder failed"; inbox `markQuestionGap` once | **corrected**: `refused` was named by AC-4 but not exercised; added | green |
| AC-5 | KB-18, ADR-009/010 | db `gap-cluster.int` (near gaps join, far separate, no visitor text in the item; accepted or dismissed item not joined; 60-day window and tenant isolation; auto-close with no decider and no fact change; checks); scheduler `gap-cluster.test.ts` (log, survives an error) | faithful | green |
| AC-6 | KB-09 | kb `coverage.int` "lists open items by asks in 30 days, then the latest ask, at most 20, with the newest question"; stage before and after the first conversation; dashboard `lib/coverage.test.ts` | faithful | green; render pending CI |
| AC-7 | UC-16 3b, KB-18 | kb `coverage.int` "accepting with an FAQ creates an approved FAQ visitors get, edited_and_accepted, and drops it from the report", "refuses an accept without an FAQ, or with a fact edit; closing changes no fact"; api gap case; dashboard `lib/corrections.test.ts` `answer_gap` cases | faithful | green; E2E pending CI |
| AC-8 | ADR-014, ADR-015 | db and kb cases (no visitor text in `corrections` or audit payloads; the item closes when its messages are deleted); tenancy audit payload is the topic ID | faithful | green |
| AC-9 | KB-09, D7 | kb "falls back to key matching when the topics cannot be embedded"; api "still reports, by question only, when the embedder fails" | faithful | green |
| AC-10 | ui-design | `e2e/tests/coverage.e2e.ts` (pre-live topics, add FAQ, Doesn't apply, widget gap, job, answer from Coverage, leaves the queue; axe on Coverage, dialog, row and detail) | faithful as written | green (Ken's local CI) |

## Corrected tests

- `1f211c0` `packages/agent/test/turn.int.test.ts`: the AC-4 negative case adds an injection refusal (`refused` outcome) and asserts its message isn't marked. No production code changed.

## Independent execution

Through `scripts/test-env.sh` (local Postgres 16 + pgvector; no Docker), at `1f211c0`:

- `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser, 472 modules), `pnpm typecheck` (26 tasks), `pnpm test` (23 tasks, incl. dashboard 56 and scheduler-worker 4): green.
- `test:coverage` (unit + integration, per-package thresholds): `@kaki/db` 125/125, `@kaki/kb` 368/368, `@kaki/tenancy` 43/43, `@kaki/inbox` 9/9, `@kaki/agent` 397/397: green. `@kaki/api` 243 passed, 1 skipped; red only on `uploads.int` (FEAT-015's S3 presigner starts LocalStack, and there is no container runtime here; not touched by this feature).
- `pnpm db:generate`: no drift. Migrations through 0030 applied to a fresh database by the db suite.
- **CI:** not due (first feature since Ken's last local run on FEAT-018; no widget, `infra/`, `.github/` or lockfile change). E2E and renders run in Ken's next local CI, which FEAT-032 (widget) calls for anyway.

## Direct verification

- Coverage routes check `kb.manage` and take the tenant from the session; every query runs in `withTenant` on the dashboard zone. The turn marks only its own visitor message, through a column grant to `app_agent_visitor` (the visitor zone's role; the design text says `app_visitor`). Grouping is `kb_gap_cluster()`, SECURITY DEFINER owned by NOLOGIN `kaki_gap_cluster`, executable only by `app_outbox` (the 0029 pattern). The item's proposal is `{"kind":"answer_gap"}` with no visitor text (D3); the only path to a fact is accept with the owner's FAQ (ADR-010).
- Topic matching uses the `visitor_facts` conditions verbatim, so needs_review, disabled and conflicted facts can't cover a topic.

## Findings

**Rework:** none. **Design defect:** none.

**Minor:**

1. `packages/agent/src/turn.ts` ~l. 74: `GAP_OUTCOMES` was inserted between `runVisitorTurn`'s doc comment and the function, so the comment now documents the constant. Cosmetic; move the constant above the comment in a later touch of the file.
2. Topic vectors are embedded once per API process and metered to whichever tenant's request triggers it (`meta.tenantId`). At ≤ 12 short queries per process this is negligible, but the cost governor attributes it to one tenant.
3. AC-8 holds because erasure deletes message rows. The erasure feature (GOV) must delete the message or clear `gap_embedding` with the body; noted in pending-actions.

## RTM

Test ref appended (Test ref column only):

- KB-09: `features/FEAT-019-coverage-report/acceptance-report.md`
- KB-18: `features/FEAT-019-coverage-report/acceptance-report.md (partial: coverage-gap source)`

## CI

Ken's local CI (WSL) on 2026-10-25 at `b67335f`: every job green, including E2E (`coverage.e2e.ts`). AC-10 verified.
