# Handoff: FEAT-056 — Signed mobile approval links
Branch: feat/FEAT-056-approval-links · PR: none · Updated: 2026-11-06 by build (backend)
Stage done: build (T1–T5 of 8)
Next: build (UI, T6–T8) — kickoff: "Build FEAT-056 (UI) on branch feat/FEAT-056-approval-links. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Route: `POST /api/v1/approval-links/open` body `ApprovalLinkBody { token }` → 200 `ApprovalLinkOpened` (`opened {approvalId, switched}` | `sign_in` | `two_step` | `two_step_setup`), or `{ error, message }` with `APPROVAL_LINK_ERRORS` status: `link_invalid` 400, `link_expired` 410, `link_used` 409, `wrong_account` 403, `not_member` 403. Never 401. Rate limit 30/10 min per IP → the existing `RateLimitedError` (429).
- `POST /api/v1/auth/magic-link` takes `approvalLink` (the landing's token; 400 `link_invalid` if forged or sent with `invitation`); `…/verify` returns `{ next, approvalLink? }`. The dashboard's `verify.tsx` stores it under `LINK_KEY` and goes to `afterSignIn(next)`.
- Google: `/api/v1/auth/google/start?next=approve` → callback redirects to `/approve`, or `/two-step?next=%2Fapprove` / `/two-step/setup?next=%2Fapprove` when owed.
- Email link: `${PUBLIC_APP_URL}/approve#token=<~230 chars>`; button "Review and approve".
- Contracts are in `packages/contracts/src/index.ts`, section "Approval links"; `ApprovalLinkError` type there is the code union (approvals' class of the same name is server-side only).
- For a stubbed Playwright check, any token string works against `page.route('**/api/v1/approval-links/open', …)`.

## Deviations (recorded in tasks.md notes)
- Platform can't import approvals, even in tests: the platform suite uses a fake `linkOf`; real tokens are checked in `apps/scheduler-worker/src/alert-links.test.ts` (`alertLinkOf`).
- The auth.ts cases are in `apps/api/test/approval-links.int.test.ts`, not `auth.int.test.ts`.
- `openApprovalLink`'s deps carry the derived `key` too (`{ dashboardDb, idDb, key }`).
- Not run here (no containers): `platform/rate-limit.int` (Valkey), `api/uploads.int` (LocalStack). All other db, approvals, platform, identity and api integration suites pass.

## Left to CI or later
- E2E (T7) and screen renders run in the verify stage's GitHub CI (no Docker in cloud sessions).

## Pending for Ken
- None.
