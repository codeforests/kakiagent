# Tasks: FEAT-061 — Data-subject requests: find, export, correct, delete across stores

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-11-20 (design)

- [x] T1 — Schema: `0059_data_subject_requests.sql` + Drizzle `dsrRequests`, `TENANT_SCOPED_TABLES`, RLS case; grants and restrictive policies (visitor insert, dashboard `contact_identities` `lead_form` only, dashboard `contacts` update columns); notification kind `dsr_due_soon` and subject `data_request`; roles `kaki_dsr_erase`, `kaki_dsr_search`, `kaki_dsr_timer` with `dsr_erase()`, `dsr_search_hits()`, `dsr_queue_due_alerts()` (design §4; AC-1, AC-6, AC-8)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes, including the new RLS case (tenant B can't see or insert tenant A's request) and a check that `app_dashboard` can't DELETE from `messages` directly.
- [x] T2 — Contracts and capability: section "Dashboard API: data-subject requests" (§3 shapes, `DSR_*` lists, `DsrSelection` limits, `DsrError` codes); identity `dsr.manage` for Owner and Admin (design §3; AC-1)
      Done when: `pnpm --filter @kaki/contracts test` passes (create body refuses a future date and a requester with no identifier; phone normalised; selection caps) and `pnpm --filter @kaki/identity test` passes the capability table (Agent lacks `dsr.manage`).
- [ ] T3 — Governance requests and the store registry: `dsr/requests.ts`, `dsr/due.ts`, `dsr/stores.ts` (`DSR_STORES` + coverage test), notes through `piiMask`, audit `dsr.*` (design §5.1, §5.2; AC-1, AC-2, AC-10)
      Done when: unit tests pass (`dueState` at due − 8, − 7, due, due + 1 in SGT; every `TENANT_SCOPED_TABLES` entry classified) and `scripts/test-env.sh pnpm --filter @kaki/governance test:integration` passes `dsr-requests.int.test.ts` (create → due + 30; verify/unverified/close/complete transitions and 409 on stale version or wrong status; audit payload holds no requester value).
- [ ] T4 — Governance find, export and correction: `dsr/find.ts`, `dsr/export.ts`, `dsr/correct.ts` (design §5.2, §5.3; AC-3, AC-4, AC-5)
      Done when: `dsr-find.int.test.ts` passes: a contact seeded across every `find+erase` store (merged contact, email conversation with attachment, Telegram chat, lead, consent, approval, memory, tracking rows, audit PII, a fact and a staged fact mentioning the email, an anonymous widget conversation mentioning the phone) is found by each identifier kind, mentions are `match: 'mention'`, tenant B's identical email is not found; export holds the messages in order; correction updates fields, swaps the unverified identity and keeps the verified one.
- [ ] T5 — Governance erase: `dsr/erase.ts` with `dsr_erase()`, `audit.erasePii`, requester masking, `dsr_objects` outbox row (design §5.4; AC-6)
      Done when: `dsr-erase.int.test.ts` passes: after erase every store in `DSR_STORES` with `find+erase` has zero rows for the seeded subject, tenant B's rows are untouched, `verifyChain` for the tenant passes, the outbox row lists the attachment key, the request is `completed` with counts and masked requester, a selection ID outside find → 422, a non-deletion or unverified request → 409.
- [ ] T6 — Agent: `dataRequestHandler` opens a request through `ConversationPort.openDataRequest` and still escalates; `runVisitorTurn` port via governance `openFromConversation`; eval cases (design §5.5; AC-9)
      Done when: `pnpm --filter @kaki/agent test` passes; `scripts/test-env.sh pnpm --filter @kaki/agent test:integration` passes a case where "please delete all my data" opens one request (contact details copied) and escalates, and a second ask opens none; `pnpm eval --fast` passes at `evals/thresholds.json`.
- [ ] T7 — Workers and infra: agent-worker `dsr_objects` branch, scheduler `dsr-due.ts` + `notify` template and `linkFor`, `.env.example` entries, terraform S3 delete permission and env vars (design §5.6; AC-6, AC-8)
      Done when: agent-worker and scheduler integration tests pass (objects deleted on a fake S3 client, request `objects` → done, re-run idempotent; one alert per request at due − 7 to Owner and Admins, none for closed, none muted); `terraform fmt -check -recursive` passes (validate/test left to CI if the registry is unreachable).
- [ ] T8 — API: `apps/api/src/data-requests.ts` (all §3 routes, `requireReauth` on export and erase, names from identity, chain check after erase), wired in `app.ts`; `docs/operations/data-subject-requests.md` (design §3, §5.7, §5.9; AC-1–AC-7)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/api test:integration` passes `data-requests.int.test.ts`: Owner and Admin 200, Agent 403 on every route, tenant B 404; export and erase 403 `reauth_required` with `staleReauth` then 200; erase result has counts, `auditSeq` and `chain: 'intact'`; `backupsClearBy` = completed + 35 days; then `pnpm typecheck` and `pnpm lint` for the touched packages.

## Build session 2 (UI)

- [ ] T9 — Data requests list (SCR-APP-048) and the Privacy and data row (SCR-APP-047 p): route, `lib/data-requests.ts` (`dueText`, `requesterLabel` unit-tested), New request dialog (ui-design.md; AC-1, AC-11)
      Done when: `pnpm --filter @kaki/dashboard test` passes (`dueText` for ok/due soon/overdue/closed) and `pnpm --filter @kaki/dashboard typecheck` passes.
- [ ] T10 — Data request page (SCR-APP-049): details, verification card, find results with selection, export, correction dialog, delete with type-to-confirm and re-auth, done state (ui-design.md; AC-2–AC-7, AC-11)
      Done when: `pnpm --filter @kaki/dashboard typecheck` and unit tests pass; a stubbed-API Playwright script in Chromium checks focus goes to Cancel in the delete confirm and the Delete button stays disabled until "delete" is typed.
- [ ] T11 — E2E `e2e/tests/data-requests.e2e.ts`: create → verify → find → export → delete → done with chain intact, as Owner; Agent sees no-permission; axe at 1440 and 375 × 5000 (AC-1–AC-7, AC-11)
      Note: runs in GitHub CI (no Docker in cloud sessions); the spec creates its own contact and conversation through the widget API.
- [ ] T12 — Verify: full local checks, RTM, acceptance report (verify stage)
      Verification evidence: one bullet per AC-1–AC-11.
