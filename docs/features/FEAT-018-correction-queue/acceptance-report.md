# Acceptance Report: FEAT-018 — Correction queue, stale-fact scan and old-versus-new replay

> Verdict: **Accepted** (E2E, screen renders and axe for AC-11 pending CI; see Independent execution) · Date: 2026-10-24
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-12) · Sources: SRS v0.4 (KB-17, KB-18; NFR-01), use-cases v0.4 (UC-16 main flow, 3a), ADR-005, ADR-009, ADR-010, ADR-014, ADR-015, ADR-027
> Repo state audited: `77071d3` (implementation head); one test correction, `33a1561`

## Verdict summary

FEAT-018 is accepted. Each of AC-1..AC-12 has tests that assert what the criterion says; the E2E and axe half of AC-11 (and the E2E halves of AC-3, AC-6, AC-7) runs only in CI and is pending. The feature's test diff adds cases and changes only lines the new schema requires (`replay_conversation_id` on seeded replay rows in the RLS suite) and one E2E text match for the renamed nav pill (`review.e2e.ts`, same assertion strength): no skips, no loosened assertions, no thresholds changed. One gate was red when audited: `@kaki/inbox` line coverage 67.69% against its 70% threshold (main passes), because the two functions FEAT-018 added there were tested only from `@kaki/agent`. This session added the missing inbox tests (Corrected tests). Two mutation checks went red as they should.

This session didn't write the code. The standard was re-derived from KB-17, KB-18, UC-16 and design §6, not from tasks.md, and every green below was observed in this run.

## Audit standard

- **KB-18 (M):** one queue of signals; each item links to the conversation and the facts and proposes a fix (edit a fact, add an FAQ, no change). Acceptance: "Nothing in the queue changes the KB until the Owner or an Admin accepts it. After a fix is accepted, the system re-runs up to 20 past questions that used the changed facts and shows the old and new answers side by side. The number of open items is shown on the home dashboard." Encoded by AC-1..AC-4, AC-7..AC-10. Faithful. The other producers (FEAT-019, 031, 045, 064) and the Home tile (FEAT-065) are later features (design §8), so the RTM ref is partial.
- **KB-17 (M):** facts not confirmed within the per-type interval (default 6 months) are flagged into the queue, stay in use, and can be re-confirmed in one tap; the overdue count shows in KB health. Encoded by AC-5, AC-6, AC-10. Faithful; the Home tile is FEAT-065's, and FEAT-014 already covered the "newer source" clause, so partial.
- **UC-16:** 1–2 → AC-2; 3 → AC-3, AC-4; 3a → AC-6; 4 → AC-3, AC-7; 5 → AC-9. 3b (coverage gap) is FEAT-019's. Faithful.
- **Binding NFRs:** NFR-01 → AC-12 (indicative, fake provider). ADR-005 → AC-1; ADR-009/015 → AC-8; ADR-014 → AC-9.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | KB-18, ADR-005 | api `corrections.int` "needs kb.manage and a session; tenant B sees none of A"; db `rls.int` FEAT-018 block (stale item, correction session, checks) | faithful | green |
| AC-2 | KB-18, UC-16 1–2 | kb `queue.int` list (newest first, by source, closed by decision, tenant B none; paging); api list/detail with facts, proposal, coaching context; dashboard `lib/corrections.test.ts` | faithful | green; render pending CI |
| AC-3 | KB-18, UC-16 3 | kb `queue.int` "an open item leaves the fact alone; accepting applies it" (`visitor_facts` v1 while open, v2 after), "a fact changed since gives stale; closing changes nothing"; api 409s | faithful | green |
| AC-4 | UC-16 3 | kb `queue.int` edit-and-accept, no-op edit, invalid/mismatched/hours edits, edited re-confirm; api 422 `invalid_correction`/`not_editable` | faithful | green |
| AC-5 | KB-17 | db `stale-scan.int` (flag once and stays visible; skips needs_review, disabled, expired promotions; per-tenant months; auto-close; re-flag at a new version); tenancy `review-intervals.int`; scheduler `stale-scan.test.ts` | faithful | green |
| AC-6 | KB-17, UC-16 3a | kb `queue.int` "makes a new version with the same value, stays searchable, and the next scan skips it"; api re-confirm in one call | faithful | green; E2E pending CI |
| AC-7 | KB-18, UC-16 4 | agent `correction-replay.int` (newest 20 of 25 before acceptance, `matched` 25, idempotent start, one per call with the new value, complete after the last, no replay for other kinds); api start on accept, lazy start, coach confirm start, 409; inbox `pastQuestionsUsing` (added here) | faithful; mutation (order asc) → red in agent and inbox | green |
| AC-8 | ADR-009, ADR-015 | agent `correction-replay.int` (no conversation/message/outbox rows; usage `coaching_session_id`; deleted conversation drops its question and answer); db cascade case | faithful | green |
| AC-9 | UC-16 5, ADR-014 | kb `queue.int` "audit payloads carry codes and IDs only"; agent replay-started audit once | faithful | green |
| AC-10 | KB-18, KB-17 | api review summary `openCorrections`, `overdueFacts`; `nav-counts.ts` and `ReviewTabs` wiring | faithful | green; render pending CI |
| AC-11 | ui-design | `e2e/tests/corrections.e2e.ts` (J11 flow, stale re-confirm, axe on both screens) | faithful as written | **pending CI** |
| AC-12 | NFR-01 | api "answers one question per call within 8 s" | faithful; indicative only | green |

## Corrected tests

- `33a1561` `packages/inbox/test/inbox.int.test.ts`: a case for `pastQuestionsUsing` (newest first, limit, `matched`, the `before` cut-off, empty IDs, tenant B) and `messagesUpTo`. Brings `@kaki/inbox` back over its 70% line threshold. No production code changed.

## Independent execution

Through `scripts/test-env.sh` (local Postgres 16 + pgvector; no Docker), at `77071d3` plus `33a1561`:

- `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser), `pnpm typecheck` (26 tasks), `pnpm test` (23 tasks, incl. dashboard and scheduler-worker units): green.
- `test:coverage`: `@kaki/db` 116/116, `@kaki/kb` 362/362, `@kaki/tenancy` 40/40, `@kaki/agent` 394/394, `@kaki/inbox` 8/8 after the correction (red at 67.69% before it): green. `@kaki/api` 236 passed, 1 skipped; red only on `uploads.int` (FEAT-015's S3 presigner needs LocalStack, not touched here).
- `@kaki/api` first run: FEAT-027's `coach.int` "proposes, then a confirm…" failed once because its audit check `not.toMatch(/fudge|58/i)` matched a random fact UUID containing `5858`; green on the rerun. A pre-existing flake (about one run in eight), not FEAT-018's; see Findings.
- `drizzle-kit generate`: no drift. Migrations through 0029 applied to a fresh database by the db suite.
- **CI:** run 40078002590 (workflow_dispatch, needed because `pnpm-lock.yaml` changed) failed on every job in ~3 s, twice, with no runner assigned: an Actions minutes or billing block, not code. E2E (`corrections.e2e.ts`, `review.e2e.ts`, FEAT-028's `replay.e2e.ts`) is still to pass before merge.

## Direct verification

- Invariants: queue routes check `kb.manage` and take the tenant from the session; every query runs in `withTenant` on the dashboard zone. The stale scan is a SECURITY DEFINER function owned by NOLOGIN `kaki_stale_scan`, executable only by `app_outbox` (cost-governor pattern, D1). Stale items never touch `facts`; re-confirm is a new version (ADR-010). Replayed answers are stored per question with `replay_conversation_id` cascading on erasure (D9); visitor text is read from `messages`, not copied into `coaching_*`. No provider SDK outside `llm-gateway`.
- A promotion always has `valid_until` (facts check), so the scan's `valid_until > now()` filter skips only expired ones.

## Findings

**Rework:** none. **Design defect:** none.

**Minor:**

1. Flaky FEAT-027 test: `apps/api/test/coach.int.test.ts:270` checks audit payloads with `/fudge|58/i`, which a random UUID can match. Proposed fix: strip UUIDs from the payload before the match. Not changed here (a FEAT-027 test, and an edit to a PII assertion should be Ken's call); in pending-actions.
2. Build deviations accepted: the closed banner shows the decision and time but not the decider's name (the contract carries none); the coach card's "See {n} past answers" link doesn't survive a reload; "Was" captions sit above the edit fields.

## RTM

Test ref appended (Test ref column only):

- KB-17: `features/FEAT-018-correction-queue/acceptance-report.md (partial)`
- KB-18: `features/FEAT-018-correction-queue/acceptance-report.md (partial)`
