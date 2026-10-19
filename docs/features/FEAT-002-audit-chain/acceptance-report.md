# Acceptance Report: FEAT-002 — Audit chain

> Verdict: **Accepted** · Date: 2026-10-19
> Standard: technical-design.md §6 (AC-1..AC-11) @ `a3cc5d0` · Sources: SRS.md v0.4 (GOV-01, GOV-03, NFR-07, NFR-12, D7), use-cases.md v0.4 (UC-32 step 2), ADR-014
> Repo state audited: `a3cc5d0` on `claude/project-thread-fty1bc` (clean tree), plus this audit's two test corrections (`85f838a`, `179be4a`)

## Verdict summary

FEAT-002 meets its criteria. The per-tenant SHA-256 chain, the database link and immutability triggers, `audit_pii` with salted commitments and erasure, S3 Object Lock anchors, and the `pnpm audit:verify` CLI all behave as technical-design §3–§5 describes. Every check below was run by this audit, and the AC-4 tamper set was confirmed on the live local stack as well as in the tests. Two tests asserted less than their criteria said (AC-3 left out TRUNCATE for app roles and INSERT/DELETE on `audit_heads`; AC-8 checked only that a violation kind was "some string"). I corrected both, and both pass against the code unchanged. The remaining findings are minor and don't block. The RTM Test ref for GOV-01 is appended and marked partial: the platform chain, the retention checkpoint and the model/prompt version are deferred to later features (design §8), and later features add the other human-action entries.

## Standard re-derived (Phase 2)

- **GOV-01** (Must): "append-only, hash-chained entries for agent decisions (summary of reasoning, KB IDs retrieved, tool calls, guardrail results), human actions … and admin events. Entries hold references and masked values only; any personal data … in a separate store that can be deleted without breaking the chain (D7)." Acceptance: "Any tampering breaks the hash-chain check. A verification tool is provided. Deleting a contact (GOV-05) leaves the chain verifiable."
  - append-only and hash-chained → AC-1, AC-2, AC-3; references and masked values only → AC-7; agent decisions → AC-8; separate deletable store and deletion keeps the chain verifiable → AC-6; tampering breaks the check → AC-4, AC-5; a verification tool → AC-10. Every clause has a criterion.
  - **Partial by design:** human-action entries for takeover, approval, rule edits and exports come with FEAT-010+, FEAT-060 and later. The model and prompt version in `agent.decision` come with FEAT-004, the platform chain with FEAT-070/072, and the retention checkpoint with FEAT-059 (design §8). The standard covers what this feature delivers.
- **UC-32 step 2** (verify the chain): AC-4 and AC-10 cover it as a CLI. The viewer and the in-app action are FEAT-060.
- **GOV-03 / ADR-005** tenant isolation → AC-9. **NFR-07** residency → AC-11. **NFR-12** coverage → governance keeps its 70% line threshold.
- The criteria are faithful to their sources. I found no design defect.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | GOV-01 hash-chained | `governance/test/audit.int.test.ts` "builds one gap-free, linked chain per tenant across interleaved transactions" (independent sorted-key SHA-256 recompute, no shared code); `chain.test.ts` (exact hash input string) | faithful; mutation check: dropping `‖ prev_hash` from `entryHash` turns 5 tests red | green |
| AC-2 | GOV-01 concurrency | `audit.int.test.ts` "serialises 20 concurrent appends…", "a rolled-back transaction leaves no entry and no gap" | faithful | green |
| AC-3 | GOV-01 append-only | `db/test/rls.int.test.ts` "audit chain": owner UPDATE/DELETE/TRUNCATE, app-role UPDATE/DELETE/**TRUNCATE**, wrong `seq` / `prev_hash` hand inserts, no-head insert as owner, visitor cannot read entries/PII, no app role reads or **writes** `audit_heads` | **was incomplete → corrected** (see below) | green (db 40/40) |
| AC-4 | GOV-01 "any tampering breaks the check"; UC-32 2 | `verify.int.test.ts` (12-entry chain on Postgres: payload, actor, ts, deleted middle, swapped pair, deleted tail via anchor `truncated`, intact `checked = N`); `verify.test.ts` (same, plus re-hashed entry → `link_mismatch` at the next seq) | faithful; mutation check: disabling the `truncated` branch turns the unit and integration tail tests red | green; also observed live (CLI below) |
| AC-5 | GOV-01 anchors; ADR-014 d5 | `anchors.int.test.ts` (one object per moved head, quiet second run writes 0, +1 after a new entry, `COMPLIANCE` retention and Object Lock on the bucket, consistent rewrite → `anchor_mismatch` at seq 3); `verify.test.ts` rewritten-chain case | faithful | green against moto S3 (stands in for LocalStack) |
| AC-6 | GOV-01, D7 | `audit.int.test.ts` "audit PII" (data only in `audit_pii`, 32-byte salt, row JSON contains neither the data nor the salt; erasure deletes rows and records `{count: 1}`, chain recomputes); `verify.int.test.ts` altered PII → `pii_commitment_mismatch` at 4, then erasure → `ok: true, piiChecked: 0` | faithful | green |
| AC-7 | GOV-01, D7 no personal data | `payload.test.ts` (20 rejections incl. `'Tan Ah Kow'`, `'tan@example.com'`, `'S1234567D'`, actor ID with space and with `@`, nested raw string, masked > 500; `@ts-expect-error` for a plain string and for a hand-made `{masked}`); `audit.int.test.ts` "rejects free text before writing anything"; existing callers pass in every integration suite | faithful to the AC's listed values (minor M1 on lowercase codes) | green; `pnpm typecheck` 26/26 enforces the `@ts-expect-error` |
| AC-8 | GOV-01 agent decisions | `agent/test/turn.int.test.ts` grounded turn (`tool.lookup_kb` with retrieved IDs, excludes `needs_review` and other-tenant facts; `agent.decision` `{answered, factIds = cited, attempts 1, violations 0}`); blocked turn (**exact kinds**, no `S$50`/`$45`/`fudge` in any row); kb `facts.int.test.ts` `fact.updated {version: 2}`; api `facts.int.test.ts` `fact.created` | **was weak → corrected** (see below) | green (agent 10/10, kb 9/9, api 11/11) |
| AC-9 | GOV-01, GOV-03 | `audit.int.test.ts` "cannot append into another tenant's chain"; `rls.int.test.ts` cross-tenant reads on entries and PII, cross-tenant insert, no-context read, no-context head lock fails closed, no direct `audit_heads` access; `verify.int.test.ts` "reads only the tenant's own chain"; `TENANT_SCOPED_TABLES` lists all three tables and the suite's forced-RLS sweep covers them | faithful | green |
| AC-10 | GOV-01 "a verification tool is provided" | no automated test (minor M3); verified directly | n/a | observed: exit 0 / 1 / 2 as specified (below) |
| AC-11 | NFR-07 | code inspection: anchors go only to `AUDIT_ANCHOR_BUCKET` in `AWS_REGION` (Terraform `local.region = "ap-southeast-1"`); body is `{tenantId, seq, hash, anchoredAt}`; task policy is `s3:PutObject` on `audit-anchors/audit/*` plus `kms:GenerateDataKey` | faithful | inspected; `terraform validate`/`test` **pending CI** |

## Corrected tests

1. **AC-3** (`85f838a`, `packages/db/test/rls.int.test.ts`). AC-3 says UPDATE, DELETE **and TRUNCATE** fail as `app_dashboard`, and that no app role can **read or write** `audit_heads`. The role test exercised only UPDATE and DELETE, and the `audit_heads` test only SELECT and UPDATE. I added TRUNCATE for `app_dashboard` and `app_agent_visitor`, and INSERT and DELETE on `audit_heads` for all three app roles. Green.
2. **AC-8** (`179be4a`, `packages/agent/test/turn.int.test.ts`). AC-8 says the blocked segment's entry carries "the violation kind". The test asserted `typeof payload.kind === 'string'`, which a constant or a wrong kind would also pass. It now asserts the exact payloads `[{kind: 'currency'}, {kind: 'currency'}]` for the two scripted literal prices. Green.

## Independent execution

All runs were made by this audit, with turbo `--force` so no cached result was replayed. Unit, lint and typecheck ran at `a3cc5d0`. Integration ran with the two corrections applied, and the corrected files are test-only.

| Check | Command | Result |
| :- | :- | :- |
| Format | `pnpm format:check` | pass |
| Lint + boundaries | `pnpm turbo run lint --force`; `pnpm lint` | 24/24; depcruise: no violations (200 modules, 430 deps) |
| Typecheck | `pnpm turbo run typecheck --force` | 26/26 |
| Unit | `pnpm turbo run test --force` | 21/21 tasks (governance 63, agent 131, llm-gateway 12, platform 7, widget 6, …) |
| Integration | `KAKI_TEST_DATABASE_URL=… KAKI_TEST_S3_ENDPOINT=http://127.0.0.1:4566 pnpm turbo run test:integration --force --concurrency=1` | 14/14 tasks: db 40, platform 4, governance 19, inbox 5, kb 9, api 11, agent 10. All pass |
| Coverage gate | same env, `pnpm turbo run test:coverage --force --concurrency=1` | 15/15; governance 99% lines, 97.48% statements, 90.8% branches (threshold 70% lines) |
| Build / size | `pnpm turbo run build --force`; `pnpm size` | 9/9; loader 1.75 kB gz (≤ 14), panel 9.34 kB (≤ 35), initial 1.75 kB (≤ 30) |
| Eval | `pnpm eval --fast` | 52 cases; groundedness 8/8, prices 44/44; exit 0 |
| E2E | `pnpm db:setup`, then a fresh `pnpm dev` started by this audit, then `E2E_REUSE_SERVERS=true pnpm test:e2e --project=chromium` | 4/4 pass (facts 4.4 s, skeleton ×3) |
| Terraform | `terraform fmt -check -recursive infra/terraform` | clean. `validate` and `test` **pending CI** (provider registry unreachable here) |

- **Mutation checks** (temporary edits, restored, `git status` clean afterwards): (1) `entryHash` without `‖ prev_hash` → 5 governance tests red; (2) `ChainVerifier` with the `truncated` branch disabled → the unit and integration tail tests red.
- **Migrations on a fresh store:** every integration suite builds a fresh database through `startTestDatabase` (roles, 0000–0005, RLS, seeds). `pnpm db:setup` also applied cleanly to the dev database. Migrations are forward-only (design §4 rollback note).
- **Flakiness:** none observed.
- **Test-diff review (`origin/main...HEAD`, 51e0d06..a3cc5d0):** no `.skip`, `.only` or `.todo` added. No `vitest.config.*`, coverage threshold or CI workflow changed. Changes to pre-existing tests:
  - `apps/api/test/facts.int.test.ts`, `packages/inbox/test/inbox.int.test.ts`, `packages/kb/test/facts.int.test.ts` and `packages/agent/test/turn.int.test.ts` now query `audit_entries` instead of `audit_events`, with the same expected values. Declared in D1. Accepted.
  - `turn.int.test.ts`: the expected action lists gained `agent.decision`, a new entry per design §5, and new payload assertions were added. Nothing was removed.
  - `governance/test/audit.int.test.ts`: the skeleton's single IDs-only test was replaced by the full suite. Its cross-tenant rejection now matches `/row-level security|no chain head/`. Accepted: the link trigger runs before the RLS `WITH CHECK` and rejects the foreign tenant's row first (design §4). The test still asserts a rejection. The skeleton's IDs-only assertion is covered more strictly by AC-7.

## Direct verification

- **Live chain (bakery dev tenant, after E2E):** 29 entries. Inspected as the owner: actors are pseudonymous IDs or `dev-owner`. `tool.lookup_kb` carries `{tool, factIds}`, `agent.decision` carries `{outcome, factIds, attempts, violations}`, and the subject refs put the primary first and include the conversation. No message text, name or email appears in any row. `audit_pii` is empty, since no caller writes PII yet.
- **Anchor job:** the fresh `pnpm dev` scheduler logged `audit anchor run {anchored: 1}` at start-up. `audit_heads.anchored_seq` = 17. The moto bucket `kaki-local-audit-anchors` reports Object Lock `Enabled`, `COMPLIANCE`, 1 day.
- **CLI (AC-10):**
  - `pnpm -s audit:verify --tenant 11111111-…` → `ok: true, checked: 29, headSeq: 29, anchorsChecked: 2`, exit 0.
  - After a hand tamper of seq 17's payload (`attempts` 1 → 2) as the owner, with `audit_entries_immutable` disabled and then re-enabled → `ok: false, broken: {seq: 17, reason: "hash_mismatch"}`, exit 1. Restored to the original payload; all three triggers back to enabled (`O`); re-verified `ok: true`, exit 0.
  - `--tenant not-a-uuid` → exit 2. A wrong database password → exit 2. `--from 5 --to 10 --no-anchors` → `checked: 6`, exit 0.
- **Contracts vs design §3:** `audit.append` / `erasePii` signatures, `VerifyResult` shape, `AnchorStore`, the anchor key format and the CLI flags match. No HTTP surface.
- **Screens:** none (ui-design.md); `docs/design-manifest.json` unchanged.
- **NFRs:** NFR-07 inspected (AC-11). NFR-12 measured (coverage gate). NFR-06 is served by the chain itself.
- **Pending environment:** `terraform validate` and `terraform test` (CI); running against real LocalStack in Testcontainers (CI; moto stood in here); the production `audit_anchor_retention_days` and running verify in the launch environment (milestone MD, design §8).

## Findings

**Rework:** none.

**Design defect:** none.

**Minor** (non-blocking, recorded for the owners named):
- **M1** (AC-7, `packages/governance/src/payload.ts:45` and `:54`). The runtime check accepts any lowercase code (`/^[a-z0-9][a-z0-9_.:-]{0,63}$/`) as an ID, so PII-shaped values such as a lowercased NRIC (`s1234567d`), a phone number (`91234567`) or a one-word lowercase name pass in `actorId`, `subjectId` and payload strings. AC-7's listed examples are all rejected, and payload values must be wrapped in `auditCode()` on purpose (D6), so this is within the design. `actorId` and `subjectId` are plain `string` with no brand, though. Suggest that FEAT-003 (PII masking) or FEAT-060 consider branding `actorId`/`subjectId` or running `piiMask` detection over codes.
- **M2** (AC-4/AC-5, `packages/governance/src/verify.ts:151`). `verifyChain` doesn't compare the tail with `audit_heads` (the dashboard role can't read it), so tail entries deleted by the database owner after the last anchor go undetected until the next anchor run (≤ 15 min). This is what ADR-014 decision 5 accepts, and it's recorded here so FEAT-060's verify action can show the time of the last anchor.
- **M3** (AC-10, `packages/governance/scripts/verify-audit.ts`). The CLI has no automated test. Its exit codes were verified directly (above). A small integration test would keep them from regressing.
- **M4** (AC-3, AC-8). Two tests were weaker than their criteria. Both were corrected by this audit (`85f838a`, `179be4a`).

## RTM

Appended to the GOV-01 Test ref: `features/FEAT-002-audit-chain/acceptance-report.md (partial)`. Partial because the platform chain (FEAT-070/072), the retention checkpoint (FEAT-059) and the model/prompt version in agent decisions (FEAT-004) are deferred per design §8, and the human-action entries for takeover, approval, rule edits and exports arrive with their own features.
