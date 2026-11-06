# Acceptance report: FEAT-056 — Signed mobile approval links (verified)

> Feature: FEAT-056 · Implements: APR-03 · Realizes: UC-22 4, 5, 5b · Screen: SCR-APP-018 (link landing) · Verifier: independent verify session, 2026-11-06 · Branch: `feat/FEAT-056-approval-links`

## Verdict summary

**Accepted** (2026-11-06). Every criterion AC-1..AC-9 has a test that asserts what it says, re-run here. The full local checks are green; the only red files are the container-only `uploads.int` (LocalStack) and `rate-limit.int` (Valkey), which CI runs. AC-9's "desktop width" and "by keyboard" clauses had no automated test; the E2E now checks the "isn't valid" state with axe at 1440 px and opens "Open approvals" by keyboard (Corrected tests). All eight landing states were also checked here with a stubbed Playwright run at 390 px and 1280 px (Direct verification).

## Audit standard

Re-derived from SRS v0.4 APR-03 (M): "Approve from mobile through a secure link in the alert (signed, single-use, 24-hour expiry, needs login)"; criterion "Expired or reused links are rejected." UC-22 step 4 (the alert carries the link), step 5 (sign in, then decide) and 5b (expired or used link: told why, offered the queue). ADR-013 §5 (stateless signed token, nonce stored on use, an authenticated session for that user), ADR-005 (forced RLS, tenant only from a trusted source), ADR-014 (no PII or secrets in audit). Design §6 AC-1..AC-9 encode all of these faithfully: each APR-03 clause maps to a criterion (design §9), and 5b maps to AC-3 and AC-5. No gaps or misencodings found.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | APR-03 "secure link in the alert"; UC-22 4 | scheduler `alert-links.test` (reads back as that user, approval, tenant; other kinds keep the page); platform `notifications.int` "each recipient of approval_pending gets their own link…", "a held digest mints the approval item its own link"; approvals `links.test` 24 h expiry, fragment URL; E2E `approval-link.e2e` (Mailpit alert link) | Yes | Pass (E2E in CI) |
| AC-2 | APR-03 "signed" | approvals `links.test` "any changed character", "another key, another version, bad JSON, a bad shape or a broken format", "a forged expiry is invalid, not expired"; api `approval-links.int` tampered → 400 `link_invalid`; E2E tampered → "isn't valid" | Yes | Pass |
| AC-3 | APR-03 "24-hour expiry"; 5b | approvals `links.test` "works until 24 hours and is expired one second after"; approvals `links.int` "expired and invalid… refused before sign-in; expired nonce rows are swept"; api `approval-links.int` expired → 410 without a cookie | Yes | Pass |
| AC-4 | APR-03 "needs login"; UC-22 5 | approvals `links.int` no session / two_step / two_step_setup store nothing; api `approval-links.int` no cookie → `sign_in` (never 401), two-step challenge, magic link carries `approvalLink` back, forged or with invitation → 400, Google `next=approve` → `/approve`; dashboard `approval-link.test` `afterSignIn` (through two-step); E2E sign in from the landing by Mailpit link → `/approvals/:id` | Yes | Pass |
| AC-5 | APR-03 "single-use"; "reused links are rejected" | approvals `links.int` "opens it once: one nonce row, one code-only audit entry; again is used" (signed in and out), "of two concurrent opens exactly one is opened"; api `approval-links.int` once then 409; `rls.int` "a nonce is used once"; E2E reopen → "already been used" | Yes | Pass |
| AC-6 | UC-22 5; ADR-013 §5 | approvals `links.int` "another member is wrong_account and consumes nothing; the recipient then opens it", "a deactivated recipient is not_member"; api `approval-links.int` 403 `wrong_account` | Yes | Pass |
| AC-7 | UC-22 5 | approvals `links.int` "a recipient on another workspace is switched"; api `approval-links.int` switched; E2E approve at 375 px → "Quote sent to the visitor" | Yes | Pass (E2E in CI) |
| AC-8 | ADR-005, ADR-014 | `rls.int` "tenant B can't see or insert tenant A's used nonces", "only the dashboard zone touches used nonces", "an approval link rides only on a sign-in link without an invitation"; approvals `links.int` audit payload is `{ approvalId }` only and does not contain the token; nonce sweep | Yes | Pass |
| AC-9 | screens | E2E axe on sign-in and used states at 375 × 5000, focus on the `h1`; added here: axe at 1440 px and keyboard on "isn't valid"; dashboard `approval-link.test` (`linkState` per answer and code); stubbed run of all states (below) | Yes, after correction | Pass (E2E in CI) |

## Changed existing tests (reviewed, not weakened)

- `e2e/tests/support.ts`: `resetSignInLimits` exported (was module-private) and `magicLinkFor` accepts `'approve'` as a path. No assertion changed.
- `packages/platform/src/notifications/templates.test.ts`: imports only, plus new cases (`alertLink` precedence, the approval-link note); the FEAT-052 assertions are unchanged. No `.skip`, `.only` or deleted cases in the feature's test diff.

## Corrected tests

- `e2e/tests/approval-link.e2e.ts` (commit `31a5985`, "FEAT-056 acceptance: correct test for AC-9"): the "isn't valid" state now asserts `h1` focus, runs axe at 1440 × 1600, and reaches "Open approvals" by Tab and Enter. AC-9 asks for desktop width and keyboard; the test covered phone width and mouse only.

## Independent execution

Run here through `scripts/test-env.sh scripts/check-summary.sh`, 2026-11-06:

- `pnpm format:check`, `pnpm lint` (incl. `check-rtm`), `pnpm typecheck`: PASS.
- `pnpm test`: PASS, 136 files, 1600 tests.
- `@kaki/approvals` test 26, test:integration 24, test:coverage 50: PASS. `@kaki/db` test:integration 206 (RLS): PASS. `@kaki/identity` test:integration 65: PASS. contracts 71, dashboard 232, scheduler-worker 14: PASS.
- `@kaki/api` test:integration: 35 of 36 files pass (incl. `approval-links.int`); `@kaki/platform` test:integration: 2 of 3 (incl. `notifications.int`). The failing files are `uploads.int` (LocalStack) and `rate-limit.int` (Valkey): "Could not find a working container runtime strategy". CI runs them.
- E2E: in CI only (no Docker here).

## Direct verification

- Code read against the design: `openApprovalLink` checks signature → expiry → used → session → same user → membership, then inserts the nonce with `ON CONFLICT DO NOTHING` and appends the audit in the same transaction (one winner under concurrency); a wrong account or no session writes nothing (D6, D7). The tenant comes only from the verified token. The signature compare is constant-time over the canonical encoding, so changing only a padding bit of the last character (what the E2E's `tamper` does) is still invalid.
- Migration 0050: forced RLS with a `tenant_isolation` policy; `app_dashboard` gets SELECT, INSERT, DELETE only; `used_link_nonces` is in `TENANT_SCOPED_TABLES`.
- Screens: a stubbed-API Playwright run against the Vite dashboard at 390 × 3000 and 1280 × 1600 showed each state's `h1` as ui-design.md says (Sign in, Check your email, Link expired, Already used, Not valid, Wrong account, No longer on the team, Can't check), focus on the `h1`, Tab reaching the primary action, one `open` request per load, the magic-link request body carrying `approvalLink`, and no serious or critical axe violations in any state at either width.

## Findings

- None blocking. F1 (test only, fixed): AC-9's desktop and keyboard clauses had no automated test (Corrected tests).
- F2 (test only, fixed): `inbox.e2e` "at phone width…" used a 1400 px viewport; this feature's E2E adds conversations before it runs, so a row sat under the fixed tab bar (axe target-size, run 109, all browsers). It now uses the 5000 px tall viewport like the other phone-width axe checks (`d75c887`).
- F3 (pre-existing widget defect, fixed outside this feature's scope): `widget-controls.e2e` failed on Chromium in run 109 and both attempts of run 110 (and once on FEAT-055's run 107). Escape right after a click left focus nowhere, because the open render's item-focus effect could run after `hide(true)` had focused the button. `HeaderMenu` now refocuses the button again in the effect once the close commits (`5bc6d48`). No test changed.
- Firefox `two-step.e2e` timed out once waiting for "Check your email" (run 110, attempt 1); it passed in run 109 and on Chromium and WebKit. Recorded; watched in the next run.

## RTM

Test ref appended 2026-11-06: APR-03. `node scripts/check-rtm.mjs FEAT-056 --stage verify`: `RTM check passed (FEAT-056).`

## CI

_pending_
