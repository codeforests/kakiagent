# Handoff: FEAT-061 — Data-subject requests: find, export, correct, delete across stores
Branch: feat/FEAT-061-data-subject-requests · PR: https://github.com/codeforests/kakiagent/pull/77 (draft) · Updated: 2026-11-20 by build (UI)
Stage done: build (T1–T11 of 12; status developer-done)
Next: verify — kickoff: "Verify FEAT-061 on branch feat/FEAT-061-data-subject-requests. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Screens: `pages/data-requests.tsx` (SCR-APP-048, `/settings/privacy/requests`), `pages/data-request.tsx` + `pages/data-request-act.tsx` (SCR-APP-049, `/settings/privacy/requests/:id`: verify, find, act, done), `pages/data-request-parts.tsx` (chips, breadcrumb, New/Edit `RequestFormDialog`, Privacy and data's `DataRequestsCard`); data, words and queries in `lib/data-requests.ts` (13 unit tests); API calls in `lib/api.ts` (`dataRequests`…`eraseDataRequest`); `dsr.*` texts in `lib/audit.ts`; CSS in the FEAT-061 block at the end of `app.css`.
- Export and erase run through `useReauthGuard().guard`; 409 `state_changed`/`wrong_type` and 422 `not_in_result` show a page alert with Reload / Search again; other errors stay in the dialog.
- The done state's chain result only exists in the erase response: after a reload it shows "Check it from the Audit log" (the outcome stores counts and `auditSeq`, not the chain).
- UI decisions D18 (audit link goes to the Contacts group; no `seq` filter in FEAT-060), D19 (find is read-only while Open and on correction requests), D20 (close reason: free text + quick fills); log rows 15–17.
- The Edit dialog has no Note field: `DsrPatchBody` takes no note.
- Stubbed-API Chromium check (T10) passed: Cancel focused in the delete confirm, Delete enabled only at "delete" (trimmed, any case), erase body, done state, 375 px no sideways scroll.

## Left to CI or later
- `e2e/tests/data-requests.e2e.ts` (T11) has not run: no Docker or local stack here. It relies on the dev tenant's lead capture (consent card, "Your details") as `consent-withdrawal.e2e.ts` does, and asserts "Chain verified" strictly (no other spec runs a verify within 30 s before it with `workers: 1`).
- Axe and screen renders at 1440/375 run in that spec in CI.
- From the backend sessions: terraform validate/test and `governance anchors.int.test.ts` (S3) in CI; `apps/api uploads.int.test.ts` needs LocalStack.

## Pending for Ken
- None blocking. Decision-log rows 15–17 added this session.

## Token use (build UI; /mnt/project-files missing, so noted here)
- ~60 tool calls; new context roughly 120k beyond the start. Most went to reading the dashboard patterns (leads, lead, audit, privacy-parts, ConfirmDialog/FormDialog, ~30k), the contracts' DSR section (~10k), and writing the four page files (~35k output). One fix round (unbuilt `@kaki/design-tokens` for typecheck).
- Modern Web Guidance: skill listed (y), but `pnpx modern-web-guidance@1.0.1 search` was refused twice by this session's command sandbox, so no guides were fetched in the build; the design stage's `dialog` and `required-field-feedback` guidance (ui-design.md) was applied: safe action focused in the delete confirm (Radix `ConfirmDialog` kept over native `<dialog>`), errors only after leaving a field or on submit with an `ErrorSummary`. No conflicts; ~0 tokens added by guides.
