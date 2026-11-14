# Acceptance report: FEAT-060 — Audit log viewer, chain verification and export

> Verifier: independent verify session, 2026-11-14 · Branch `feat/FEAT-060-audit-viewer` · PR #70

## Verdict summary

**Accepted.** All eight acceptance criteria are covered by tests that assert what the criterion says, every FEAT-060 suite passes on a fresh run, and the full local checks pass. E2E (AC-6–AC-8 in a real browser) and the S3 suites run in GitHub CI (see CI). Two small deviations from the ui-design are documented and accepted (Findings).

## Audit standard

Each AC was checked against its tests (does the assertion state the criterion, not just exercise the code), then against the code directly where the test is indirect. The test diff was reviewed for weakened or deleted tests, and the change against the `AGENTS.md` invariants.

## Audit table

| AC | Requirement | Tests | Result |
|---|---|---|---|
| AC-1 | GOV-02 viewer with filters; UC-32 1 | `governance/test/audit-read.int.test.ts` (newest first, keyset paging, SGT inclusive bounds 23:59/00:00, conversation, actor type, member, group incl. `other`, combined, tenant B); `api/test/audit.int.test.ts` (Owner/Admin 200, Agent 403 on all six routes, 404, 400, tenant B can't fetch A's seq) | Pass |
| AC-2 | GOV-01 references and masked values only; D5 | `audit-read.int` none → kept → erased after `erasePii`, PII text never in a row; code: `audit_pii` is only left-joined for existence (`audit-read.ts` SELECT), never selected | Pass |
| AC-3 | GOV-01 verification tool; ADR-014 d6 | `audit-verify.int` (intact → ok/checked to head; tamper seq 3 → `hash_mismatch` at 3; anchor beyond head → `truncated`; anchors throw → `unavailable` with DB result; `none_yet`; cooldown with seconds left; held lock → `VerifyRunning`; one PII-free `audit.verified`, lock released); api verify 200 then 429, `GET /audit/verification` | Pass (truncation simulated by an anchor past the head, which is how a deleted tail looks to the verifier; 409 mapping checked in code, `audit.ts:43–60`) |
| AC-4 | GOV-02 export; AUTH-03 | `audit-export.int` (conversation and date filters exact, appended-during-export excluded, cap with count, one `audit.exported` with IDs/codes after the snapshot); `audit-export.test.ts` (BOM, CRLF, `=SUM(1)` prefixed, round-trip, JSON recomputes `hash`); api 403 `reauth_required`, CSV/JSON `attachment` + `no-store`, filter honoured, 413 | Pass |
| AC-5 | GOV-02 30 days ≤ 1 min | `audit-export.int` 75,000 entries, re-run here: CSV 1.5 s (26.8 MB), JSON 0.7 s (41.9 MB), verify 2.2 s | Pass |
| AC-6 | SCR-APP-050 list, URL filters, detail, states | `lib/audit.test.ts` (URL round-trip, event texts, subject links); E2E `audit-log.e2e.ts` test 1 (filter in URL kept on reload, Load more, detail, focus return) | Pass (unit here; E2E in CI) |
| AC-7 | SCR-APP-050 verify states | unit verify/break-reason texts; E2E verify → "Intact" chip and last-verified line, accepts the LocalStack anchors-unavailable wording | Pass (E2E in CI) |
| AC-8 | Export dialog, re-auth, sidebar link, Agent, axe | unit 413 text; E2E CSV through re-auth, toast, `audit.exported` row, sidebar link → `?conversation=`, Agent sees no row or link, axe at 1440 and 375 × 5000 | Pass (E2E in CI); export dialog shows no count (Findings) |

## Changed existing tests (reviewed, not weakened)

The diff adds 12 test files and changes none of the existing assertions: `identity.test.ts` gains the `audit.read` rows (Agent lacks it), `api/test/support.ts` gains a fake anchors dependency. No test lines removed.

## Corrected tests

None.

## Independent execution

Fresh clone, `pnpm install`, `pnpm tokens`, then `scripts/test-env.sh scripts/check-summary.sh`:

- `pnpm format:check`, `pnpm lint` (ESLint, dependency-cruiser, check-rtm), `pnpm typecheck`: PASS.
- `pnpm test`: PASS, 170 files, 1925 tests. `@kaki/dashboard test` 311, `@kaki/identity test:coverage` 108, `@kaki/contracts test:coverage`: PASS.
- `@kaki/governance test:coverage`: 16/17 files, 136 tests pass; `@kaki/api test:coverage`: 49/50 files pass. The one failure in each is an S3 suite (`anchors.int`, `uploads.int` presigner) that needs Docker/LocalStack, unavailable in cloud sessions; both run in CI.
- FEAT-060 suites by name (verbose): governance 25/25 (unit + `audit-read/verify/export.int`), api `audit.int` 8/8.

## Direct verification

- Invariants: reads and verify run through `withTenant` on the dashboard zone and member names through the identity zone; tenant from the session only; `audit.exported`/`audit.verified` appended through `audit.append` in the same transaction; no provider SDK, no new table (so no RLS change); dependency-cruiser passes. Export is in-request download with `no-store` and a 100,000 cap (D1; deviation from ADR-014 §8 recorded for architecture §12).
- Verify takes a session advisory lock per tenant and releases it in `finally` (test asserts no advisory locks after a run).

## Findings

1. Export dialog shows no entry count (AC-8 says "format, count, filters"): there is no count endpoint, and the 413 answer names the count above the cap. Minor, accepted; a count could come from `auditCount` later.
2. "Show entry" and "Clear filters" are ghost buttons rather than the link style in ui-design (no link button exists in `@kaki/ui`). Cosmetic, accepted.
3. API test doesn't hit 409 `verify_running` end to end; the domain test covers `VerifyRunning` and the route maps it in `audit.ts`. Not blocking.

## RTM

`node scripts/check-rtm.mjs FEAT-060 --stage verify`: RTM check passed (FEAT-060).

Test refs appended to GOV-02, GOV-01 (partial: dashboard "Verify audit chain" action) and AUTH-03 (partial: audit export re-auth).

## CI

CI_LINE
