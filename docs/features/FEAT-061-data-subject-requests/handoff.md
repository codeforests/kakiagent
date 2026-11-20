# Handoff: FEAT-061 — Data-subject requests: find, export, correct, delete across stores
Branch: feat/FEAT-061-data-subject-requests · PR: none · Updated: 2026-11-20 by build (backend, part 2)
Stage done: build (T1–T8 of 12; backend complete)
Next: build (UI, T9–T11) — kickoff: "Build FEAT-061 (UI) on branch feat/FEAT-061-data-subject-requests. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (`apps/api/src/data-requests.ts`, all `dsr.manage`, Agent 403, other tenant 404, a non-UUID ID 404): `GET /api/v1/data-requests?view=open|closed&cursor` → `DsrList`; `POST /api/v1/data-requests` `DsrCreateBody` → 201 `DsrDetail`; `GET|PATCH /:id` (`DsrPatchBody`, open only); `POST /:id/verify` `DsrVerifyBody`; `/:id/unverified` and `/:id/close` `DsrReasonBody`; `/:id/complete` `DsrCompleteBody` (access/correction only); `GET /:id/find` → `DsrFindResult` (open or verified, else 409); `POST /:id/export` `DsrExportBody` → JSON attachment (`Content-Disposition` filename `data-request-DSR-XXXXXXXX-YYYY-MM-DD.json`); `POST /:id/corrections` `DsrCorrectionBody` → `DsrDetail`; `POST /:id/erase` `DsrEraseBody` (`confirm: 'delete'`) → `DsrEraseResult` (`chain` `intact|broken|not_checked`).
- Errors are `{ error, message }` with `error` in contracts `DSR_ERRORS`: 404 `not_found`, 409 `state_changed`/`wrong_type`, 422 `not_in_result`/`nothing_selected`, 413 `too_large`; Zod body errors 400 `bad_request` (so a future date or no identifier arrives as 400 `bad_request`; show the client-side messages from ui-design). Export and erase answer 403 `reauth_required` (`ReauthRequired`): wrap both in `useReauthGuard().guard`. Correction has no re-auth (D13).
- `chain: 'not_checked'` means the 30 s verify cooldown or a running check (D11): show "Verify from the Audit log". `backupsClearBy` = completed day + `BACKUP_RETENTION_DAYS` (35).
- After an erase, `detail.objects` is `pending` until the agent-worker's `dsr_objects` job runs, then `done` (refetch to see it).
- The dashboard's `lib/audit.ts` needs event texts for `dsr.opened|updated|verified|unverified|closed|completed|exported|corrected|erased|objects_removed` and `audit.pii_erased` (contacts group already includes `dsr.`).
- `docs/operations/data-subject-requests.md` is written (T8); link it from the page's help text if ui-design asks for one.
- Build changes this session: 0059 now also grants the visitor zone SELECT on `objects_pending, objects_done_at` (idempotent job); the worker logic lives in governance `dsr/workers.ts` so its integration test is in governance; terraform `dsr_object_remover` policy and the env vars are in `envs/prod/main.tf`.

## Left to CI or later
- E2E (T11), renders and axe run in GitHub CI (no Docker here). Terraform `validate`/`test` in CI (the provider registry was unreachable; `fmt -check` passed). `governance anchors.int.test.ts` needs S3 and fails locally without `KAKI_TEST_S3_ENDPOINT`; the DSR suites pass.

## Pending for Ken
- None blocking. No new M5 decision rows this session (rows 12–14 from part 1 stand).

## Token use (build backend part 2; /mnt/project-files missing, so noted here)
- ~60 tool calls; new context roughly 110k beyond the ~85k start. Most went to reading the worker `main.ts` files and the notification/recipient grants (~25k), the API's audit routes as the pattern (~8k), and the API test (~10k output). Nothing needed a fix round beyond two wrong test column names (audit table is `audit_entries`/`subject_refs`). Part 1 took ~95 calls and ~190k; splitting the backend in two kept both sessions under 200k.
