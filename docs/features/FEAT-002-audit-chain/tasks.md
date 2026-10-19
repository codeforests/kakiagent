# Tasks: FEAT-002 — Audit chain

> Executes: [technical-design.md](technical-design.md) (no screens: [ui-design.md](ui-design.md))
> Status: pending | in-progress | done per task · Last updated: 2026-10-19

- [x] T1 — Migration: drop `audit_events`; add `audit_entries`, `audit_heads`, `audit_pii` (0004, drizzle-kit); roles `kaki_audit_chain` and `kaki_audit_anchor`, `audit_head_lock()`, the link and immutability triggers, the anchor functions, RLS and grants (0005, hand-written); `TENANT_SCOPED_TABLES` (design §4)
      Done when: `setupDatabase` applies 0000–0005 cleanly on a fresh database and the RLS suite passes with the new tables listed.
- [x] T2 — RLS, grant and trigger tests for the new tables and functions (design §4; AC-3, AC-9; GOV-03)
      Done when: `rls.int.test.ts` covers cross-tenant reads and writes on all three tables, the visitor role's denied reads, no direct access to `audit_heads`, UPDATE/DELETE/TRUNCATE rejected for the owner and app roles, and hand-written inserts with a wrong `seq` or `prev_hash` rejected; it passes.
- [x] T3 — Domain, pure: `canonical.ts` (RFC 8785), `payload.ts` (branded constructors and `assertAuditEntry`), `chain.ts` (hash input, entry hash, PII commitment) (design §5; AC-1, AC-7)
      Done when: unit tests pass for JCS key order, numbers and escapes (RFC 8785 examples), rejected values, every AC-7 rejection plus a `@ts-expect-error` for a plain string, and hash determinism.
- [x] T4 — Domain, database: `audit.append` (head lock, PII row, hash, insert) and `audit.erasePii`, replacing the skeleton body (design §3.1, §5; AC-1, AC-2, AC-6, AC-9)
      Done when: `audit.int.test.ts` covers an interleaved two-tenant chain recomputed independently, 20 concurrent appends with no gap, rollback leaving no gap, cross-tenant append rejected, a PII entry whose data is only in `audit_pii`, and erasure; all pass.
- [x] T5 — Domain: `verifyChain` with its pure core (design §3.2; AC-4, AC-6)
      Done when: unit tests over fixture chains and integration tests on the database report the first broken `seq` for each AC-4 tamper and for an altered PII row, and `ok: true` for an intact chain and after erasure.
- [x] T6 — Anchors: `AnchorStore`, `createS3AnchorStore`, `anchorHeads`, the `startTestS3()` helper (design §3.3; D9, D10; AC-5, AC-11)
      Done when: integration tests against LocalStack (or `KAKI_TEST_S3_ENDPOINT`) show one object per moved head, nothing on a quiet second run, Object Lock retention on the objects, and `anchor_mismatch` after a consistent rewrite of an anchored chain.
- [x] T7 — Callers: payloads for `tool.lookup_kb`, `guardrail.segment_blocked`, the new `agent.decision`, related conversation refs in `inbox`, `{ version }` on `fact.updated`; move the tests that read `audit_events` (design §5; D1; AC-8)
      Done when: the agent, inbox, kb and api integration tests pass reading `audit_entries`, and the turn test asserts the AC-8 payloads and the absence of message text.
- [x] T8 — Wiring: scheduler-worker `audit-anchor` loop and config; LocalStack bucket script and health check; `gen-local-env.mjs` and `.env.example` files; Terraform env var, S3 and KMS task policy (design §5)
      Done when: `pnpm dev`'s scheduler logs an anchor run against LocalStack (or the stand-in), typecheck and lint are clean, and `terraform validate` and `terraform test` pass where Terraform is available (CI runs both).
- [x] T9 — CLI: `pnpm audit:verify` (design §3.4; AC-10)
      Done when: on the local database it prints `ok: true` and exits 0, exits 1 after a tamper with the broken `seq`, and exits 2 for an invalid tenant ID.
- [x] T10 — Docs: scaffold-notes §4 stub row, AGENTS.md command list (design §5)
      Done when: both name the chain, the anchor job and the CLI.
- [x] T11 — Verify: every acceptance criterion (design §6) demonstrably passes; format, lint (with boundaries), typecheck, unit, integration and coverage green; E2E skeleton and facts flows still pass
      Done when: the commands in AGENTS.md "Checks" pass and each AC is mapped to the test or run that shows it.
      Evidence (2026-10-19, no Docker: local Postgres 16 + pgvector via `KAKI_TEST_DATABASE_URL`, moto S3 with Object Lock via `KAKI_TEST_S3_ENDPOINT`; CI runs Testcontainers and LocalStack): format, lint and boundaries, typecheck, unit (21 tasks), integration (db 40, platform 4, governance 19, kb 9, inbox 5, api 11, agent 10), coverage (governance 99% lines), build, size, `eval --fast`, and E2E chromium 4/4 against `pnpm dev` all pass. `pnpm audit:verify` on the bakery after the E2E run: `ok: true`, 17 entries, 1 anchor, exit 0; after a hand tamper of seq 3: `hash_mismatch` at 3, exit 1; an invalid tenant ID: exit 2. `terraform fmt` is clean; `terraform validate` and `terraform test` could not run here (the provider registry is unreachable) and run in CI.
