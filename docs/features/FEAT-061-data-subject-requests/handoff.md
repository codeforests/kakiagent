# Handoff: FEAT-061 — Data-subject requests: find, export, correct, delete across stores
Branch: feat/FEAT-061-data-subject-requests · PR: none · Updated: 2026-11-20 by build (backend, part 1)
Stage done: build (T1–T6 of 12)
Next: build (backend, T7–T8) — kickoff: "Build FEAT-061 (backend) on branch feat/FEAT-061-data-subject-requests. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build." (resume at T7; then the UI session T9–T11)

## What the next stage needs
- Governance exports (`packages/governance/src/index.ts`): `createRequest`, `updateRequest`, `verifyRequest`, `markUnverified`, `closeRequest`, `completeRequest`, `listRequests`, `getRequest`, `requestEvents`, `memberIdsOf`, `toDetail(row, events, nameOf, { backupRetentionDays })`, `findSubject(tx, tenantId, identifiersOf(row))` (→ `.result` is `DsrFindResult`), `exportSubject(tx, t, user, id, version, sel)` (→ `{ file, fileName }`), `correctSubject`, `eraseSubject(tx, t, user, id, version, sel)` (→ `{ request, counts, auditSeq, objectKeys }`), `openFromConversation`. Errors are `DsrError` with `.code` in contracts `DSR_ERRORS`: map `not_found` 404, `state_changed`/`wrong_type` 409, `not_in_result`/`nothing_selected` 422, `too_large` 413.
- `find` on an `open` request (D9 preview) isn't gated in governance: the API checks status (`open` or `verified`); export/correct/erase call `requireVerified` themselves.
- After `eraseSubject` commits, the API calls `verifyForDashboard` (D11) for `chain`; `VerifyCooldown`/`VerifyRunning` → `not_checked`. `toDetail` gives `backupsClearBy` = completed day + `backupRetentionDays` (api config `BACKUP_RETENTION_DAYS`, default 35, D12).
- Contracts: section "Dashboard API: data-subject requests" (end of `contracts/src/index.ts`); `DsrFindResult.contacts[].leads` is an array (lead IDs for correction), and `other` has no `handoffLinks` (the dashboard may not read `handoff_links`, FEAT-038's RLS test). `DsrObjectsJob` is in `TurnQueueJob`; the agent-worker branch for `kind: 'dsr_objects'` (T7) deletes `keys` from the attachments bucket, then sets `objects_pending = 0, objects_done_at = now()` (visitor-zone grant on those columns + `updated_at`) and audits `dsr.objects_removed`.
- Scheduler T7: `select tenant_id, id from dsr_queue_due_alerts()` as `app_outbox`; then per row `notify` kind `dsr_due_soon`, subject `{ type: 'data_request', id }`, recipients Owner + Admins. Templates and `linkFor` (`/settings/privacy/requests/:id`) are done (T1); `muteEvent('dsr_due_soon')` is null.
- Build deviations, logged as M5 decisions 12–14: `dsr_correct()` instead of new dashboard grants (D15); deletion also removes corrections from the deleted conversations and their coaching replays (D16); no requester values in `audit_pii` (D17). `dsr_erase()` takes 5 arguments (no actor).
- Audit event codes: `dsr.opened|updated|verified|unverified|closed|completed|exported|corrected|erased` (+ `audit.pii_erased` per contact); the contacts audit group now includes `dsr.` (contracts `audit.ts`). The dashboard's `lib/audit.ts` event texts need these (UI session).

## Left to CI or later
- E2E (T11) and renders run in GitHub CI. `anchors.int.test.ts` needs S3 (no `KAKI_TEST_S3_ENDPOINT` here), so `governance test:integration` shows that one file failing locally; the DSR suites pass.

## Pending for Ken
- None blocking. M5 decision log rows 12–14 added by this session.

## Token use (build part 1; /mnt/project-files missing, so noted here)
- ~95 tool calls; new context roughly 190k beyond the ~85k start. Most went to schema/grant discovery (psql against a scratch test DB was cheaper than reading schema.ts, ~15k), the 0059 functions (~20k output) and test seeding (~15k). The two RLS invariants found by running the RLS suite (dashboard writes on contacts/leads, reads of handoff_links) cost two fix rounds (~10k); a design read of `rls.int.test.ts` for "dashboard can't" lines would have caught them earlier.
