# Tasks: FEAT-056 — Signed mobile approval links

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: developer-done · Last updated: 2026-11-06 (build, UI)

- [x] T1 — Schema: `0050_approval_links.sql` and `schema.ts` (`used_link_nonces` with composite FK to `approvals`, primary key `(tenant_id, nonce)`, forced RLS, `app_dashboard` select/insert/delete only; `magic_links.approval_link` with its two checks), name in `TENANT_SCOPED_TABLES`, cases in `rls.int.test.ts` (design §4; AC-8)
      Done when: `drizzle-kit generate` reports no drift after 0050; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with tenant-B-can't-see-or-insert-A for `used_link_nonces`, a duplicate nonce refused, `app_visitor` refused a select, and a `reauth` magic link with `approval_link` refused.
- [x] T2 — Contracts: section "Approval links" (`ApprovalLinkBody`, `ApprovalLinkOpened`, `APPROVAL_LINK_ERRORS`), `MagicLinkRequest.approvalLink`, `MagicLinkVerifyResponse.approvalLink` (design §3)
      Done when: `pnpm --filter @kaki/contracts test` passes (round-trips; `ApprovalLinkOpened` refusing `opened` without `approvalId`; a 1001-character token refused); `pnpm --filter @kaki/api --filter @kaki/dashboard typecheck` passes.
- [x] T3 — Approvals `links.ts`: `approvalLinkKey`, `signApprovalLink`, `readApprovalLink`, `approvalLinkUrl`, `openApprovalLink`, `ApprovalLinkError`; exported from `src/index.ts` (design §5.1; D2, D4–D7; AC-2, AC-3, AC-5, AC-6, AC-8)
      Done when: unit tests (`links.test.ts`) pass for sign/read round trip, each changed character, another key, `v: 2`, bad JSON, forged `e` → invalid, exp boundary (24 h − 1 s ok, + 1 s expired); `scripts/test-env.sh pnpm --filter @kaki/approvals test:integration` passes for opened (nonce row + one `approval.link_opened` entry, payload without token/nonce), reuse → `link_used`, two concurrent opens → one `opened`, no session → `sign_in` with nothing stored, wrong user → `wrong_account` then the recipient opens, deactivated member → `not_member`, other active tenant → `switched: true` and `sessions.active_tenant_id` moved, expired rows deleted on the next open.
- [x] T4 — Alerts: platform `SendOptions.linkOf` (falls back to `linkFor`), `templates.ts` copy for `approval_pending` (button "Review and approve", the once-for-24-hours line; digest line once); scheduler wires `linkOf` with `approvalLinkUrl` for `approval_pending` only (design §5.2; D3; AC-1)
      Done when: `pnpm --filter @kaki/platform test` passes (template copy; `linkOf` null → `linkFor`); `scripts/test-env.sh pnpm --filter @kaki/platform test:integration` passes with an `approval_pending` alert for two recipients whose emailed links carry different tokens that `readApprovalLink` accepts for each user, a held digest whose approval item has its own token, and `approval_undeliverable` keeping `/approvals/{id}`; `pnpm --filter @kaki/scheduler-worker typecheck` passes.
      Note (build): platform can't import approvals even in tests, so the platform integration test uses a fake per-recipient `linkOf` (two recipients, held digest, `approval_undeliverable` fallback), and the real tokens are checked in the scheduler's `alert-links.test.ts` (`alertLinkOf` → `readApprovalLink` per user). The fallback is `alertLink` in `links.ts`, unit-tested in `templates.test.ts`. `rate-limit.int.test.ts` needs Valkey (no container here); the notifications and outbox suites ran.
- [x] T5 — API: `approval-links.ts` (`POST /api/v1/approval-links/open`, cookie read with `authenticate`, IP rate limit), wired in `app.ts`; `auth.ts` magic-link `approvalLink` (signature check, not with `invitation`), verify returning it, Google `next=approve`; identity `requestMagicLink`/`consumeMagicLink` carrying `approval_link` (design §5.3; D1, D6; AC-3–AC-7)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/api test:integration` passes a new `approval-links.int.test.ts`: tampered → 400, expired → 410 without a cookie, no cookie → `sign_in`, signed-in recipient → `opened`, again → 409, other member → 403 `wrong_account`, a two-step-pending session → `two_step`; and in `auth.int.test.ts`: a magic link requested with `approvalLink` returns it on verify, a forged one is 400, with `invitation` too is 400, Google start with `next=approve` then callback redirects to `/approve`.
      Note (build): the auth cases (approvalLink on verify, forged 400, with invitation 400, Google `next=approve`) live in `approval-links.int.test.ts` beside the open route's, not in `auth.int.test.ts`; `auth.int` and `team.int` still pass. Full api integration: 35/36 files pass; `uploads.int` needs LocalStack (no container here).

## Build session 2 (UI)

- [x] T6 — Dashboard: `/approve` route outside the shell, `pages/approval-link.tsx` (every state in ui-design), `lib/approval-link.ts` (`takeLinkToken`, `linkState`, `afterSignIn`) with `lib/approval-link.test.ts`; `verify.tsx` continuation; `lib/api.ts` calls (design §5.4; ui-design SCR-APP-018 link landing; AC-4, AC-9)
      Done when: `pnpm --filter @kaki/dashboard test` passes (`linkState` per response and error code, `afterSignIn` per `next`, `takeLinkToken` fragment-then-storage and storage throwing); `pnpm --filter @kaki/dashboard typecheck` passes; a stubbed-API Playwright check of `/approve` (routes for `/api/v1/approval-links/open` per state) logs each state's `h1` and focus target.
- [x] T7 — E2E `e2e/tests/approval-link.e2e.ts`: from an `approval_pending` alert in Mailpit (as `approvals.e2e.ts` raises one) open the link signed out at phone width (tall viewport), sign in by the Mailpit sign-in link, land on the approval, approve, see "Quote sent to the visitor"; open the same link again → "This link has already been used"; a tampered token → "This link isn't valid"; axe on the sign-in and used states (AC-1, AC-4, AC-5, AC-7, AC-9)
      Done when: the spec type-checks (`pnpm --filter @kaki/e2e typecheck` or `pnpm typecheck`); it runs in the verify stage's GitHub CI (no Docker here).
      Note: E2E run tags must have no digits (fake triage reads the first number as quantity); use the per-run tag pattern from `approvals.e2e.ts`.
- [x] T8 — Verify: full `pnpm format:check`, `pnpm lint` (includes `check-rtm`), `pnpm typecheck`, `pnpm test`; the integration suites of db, approvals, platform, api; tick the evidence below; status `developer-done`; draft PR (AC-1–AC-9)
      Done when: `scripts/test-env.sh scripts/check-summary.sh` all PASS plus `'pnpm --filter @kaki/approvals test:coverage'`; draft PR open.

T6 evidence (2026-11-06): dashboard unit 232 passed (incl. `approval-link.test.ts`), typecheck and eslint pass. Stubbed Playwright at 390 px: sign_in, check email (request body carries `approvalLink`), expired, used, invalid, wrong account, not member, can't check each show their `h1` and focus it; one open per load; `two_step` and `opened` leave `/approve`. `AuthLayout` gained `focusOnMount` (sign-in and wrong-account states mount their own layout).
T7 evidence: `e2e/tests/approval-link.e2e.ts` type-checks; `support.ts` exports `resetSignInLimits` and `magicLinkFor(…, 'approve')`. Runs in the verify stage's GitHub CI.

T8 evidence (2026-11-06, `scripts/test-env.sh scripts/check-summary.sh`): format:check, lint (incl. check-rtm), typecheck, test (1600 passed) PASS; db integration 206 passed; approvals test:coverage 50 passed; api integration 35/36 files and platform integration 2/3 files pass, the failing files being `uploads.int` (LocalStack) and `rate-limit.int` (Valkey), which need containers this session lacks (as in the backend build); CI runs them.

## Verification evidence

- AC-1 — `apps/scheduler-worker/src/alert-links.test.ts`, platform notifications suite (fake `linkOf`); E2E reads the link from the Mailpit alert (CI).
- AC-2 — `packages/approvals` links unit and integration tests; E2E tampered token → "This link isn't valid" (CI).
- AC-3 — `apps/api/test/approval-links.int.test.ts` (410, nothing consumed).
- AC-4 — `approval-links.int.test.ts` (sign_in, two_step, magic-link `approvalLink` round trip, Google next=approve); `approval-link.test.ts` (`afterSignIn`); E2E sign-in from the landing (CI).
- AC-5 — `approval-links.int.test.ts` (nonce, audit entry, reuse 409, concurrent opens); E2E reopen → "already used" (CI).
- AC-6 — `approval-links.int.test.ts` (wrong_account consumes nothing, not_member).
- AC-7 — `approval-links.int.test.ts` (switched); E2E approve at phone width → "Quote sent to the visitor" (CI).
- AC-8 — `packages/db/test/rls.int.test.ts` used_link_nonces cases; audit payload checks in approvals integration.
- AC-9 — stubbed Playwright of every state (T6 evidence); E2E axe on sign-in and used states at 375×5000 (CI).
