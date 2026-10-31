# Acceptance report: FEAT-008 — My account: profile, email change, sessions list

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-10-31 by an independent verify session · Branch `feat/FEAT-008-my-account` · PR #43

## Verdict summary

**Accepted.** AUTH-05 is met in full (name, email change verified before it takes effect, notice to the old address, old address signs in until then). AUTH-02 gains "sign out, and sign out of all devices" per device with live sockets closed; it stays partial overall (operators FEAT-070). UC-02 step 6 is realised. Every criterion below has a test that asserts what it says, and every local result was produced in this session. E2E (`account.e2e.ts`) and the screen renders run only in GitHub CI.

## Audit standard

Re-derived from SRS v0.4 AUTH-05 ("change their profile name and email"; "takes effect only after it is verified"; "old email receives a notice"; "until verified, sign-in still uses the old email") and AUTH-02 ("sign out, and sign out of all devices"; "the old session cannot call any API"); UC-02 step 6; technical-design §6 AC-1..AC-8, D1–D10. Each clause maps to an AC (§9 traceability holds). D3 (re-auth before an email change) is stricter than the SRS, not in conflict. "Until verified, sign-in still uses the old email" is encoded faithfully: the new address isn't on `users` until confirm (D2), so a sign-in link to it creates or reaches a different user, which the API test asserts.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 | AUTH-05 name | identity `account.int` "sets and clears the name"; api `account.int` "sets, shows in Me and the team, refuses bad names, clears", "audit entries carry no email or name"; dashboard `lib/account.test` (`nameError`); db `rls.int` 61-char check; `account.e2e` | Yes: menu, `Me.user.displayName`, Team row; 400 field error; `account.name_changed` without the name | Pass |
| AC-2 | AUTH-05 verified, old sign-in | api `account.int` "request → both emails; old sign-in still works; confirm moves it; once only", "replaced or cancelled … expired"; identity `account.int` confirm and refusal cases; `account.e2e` | Yes: email unchanged while pending, old address still the same user, new address not; used/expired/replaced/cancelled each give their state; 24 h, single use | Pass |
| AC-3 | AUTH-05 notice | identity `account.int` "request leaves the email … sends the link and the notice", "a failed send is queued and retried … SKIP LOCKED"; api "a send failure answers queued"; `account.e2e` reads the notice | Yes: notice masks the new address (`n***@x.test`, address absent), both emails retried by the sweep | Pass |
| AC-4 | AUTH-05; safety | api `account.int` taken-address case (202, in-use email, never confirmable), `same_email` 409, `email_taken` 409 at confirm; identity cancel/replace, Google cleared, old sign-in links deleted | Yes | Pass |
| AC-5 | AUTH-02; UC-02 6 | identity "lists live sessions with labels, this one first", "signs out another device …"; api "lists the devices, signs out another, never this one or a stranger's"; identity `device.test`; `account.e2e` two devices, one signed out | Yes: label, method, times, this device; other's next call 401; current 409; stranger's 404 | Pass |
| AC-6 | AUTH-02 old session; FEAT-007 open item | api "sign out and sign out everywhere close each ended session's sockets" (publishes `channels.session` per ended session, per path); realtime `ws.int` FEAT-008 AC-6 case | Yes: the API side asserts every ended session is published, the realtime side that the socket closes 4401 and the other session's stays open | Pass |
| AC-7 | ADR-005, ADR-014, ADR-020 | db `rls.int` (`email_changes`, `users` unreadable by dashboard and visitor zones); api stranger's session 404; identity "account events carry IDs only, and the chain holds" | Yes | Pass |
| AC-8 | SCR-APP-055, NFR-19, NFR-09 | `account.e2e` (states, dialogs, `/verify-email` confirmed, used, invalid, and stubbed expired, taken, error; axe at 1280, 375, dark); builder's stubbed-API runs for loading, error, saving, queued | Partly by committed spec (see O2) | Pass (GitHub CI) |

## Corrected tests

None. Test diff reviewed (`git diff origin/main...HEAD` on `*.test.ts`, `*.int.test.ts`, `e2e/`): no skips, `.only`, `.todo` or deleted cases. The only changed existing assertions follow API changes: `revokeAllSessions` returns IDs (`.length` > 0, same meaning), and `TeamMember` fixtures gain `displayName: null`.

## Independent execution

Fresh `pnpm install`, `pnpm tokens`, then at `e0d0153`: `pnpm format:check` clean; `pnpm lint` (ESLint + dependency-cruiser, 617 modules, no violations); `pnpm typecheck` 26/26; `pnpm test` 24/24 tasks (contracts 26, identity 40, dashboard 148 among them). Through `scripts/test-env.sh`: integration identity 62, db 163, realtime 7, api 318 passed + 1 skipped; `test:coverage` with thresholds green for identity (102) and db (163). api coverage: 330 passed, the only failure is `uploads.int` "the S3 presigner" (needs `KAKI_TEST_S3_ENDPOINT`; untouched by the feature, fails on main in cloud sessions, green in CI). contracts, realtime and dashboard have no coverage script; their tests run in `pnpm test`.

## Direct verification

- User ID only from the session in every `/me/*` route (`apps/api/src/account.ts`: `a.userId`, `a.sessionId`); the session ID path param is UUID-checked and the update filters `user_id`, so another user's is 404. Confirm takes the user from the token's row (D4), rate-limited per IP.
- Migration 0041: `email_changes` has no `tenant_id` (user-owned, like `magic_links`); grants to `app_identity` only, with column-limited UPDATE; `users` UPDATE widened to `(email, display_name)` for `app_identity` only; partial unique index keeps one live request per user, and `requestEmailChange` takes a `FOR UPDATE` lock on the user first.
- Confirm is one transaction: the claim, the email move (unique violation → `email_taken`, claim rolls back), the Google unlink, the sign-in link purge and the audit entry.
- Audit codes (`account.name_changed`, `account.email_change_requested`, `…_cancelled`, `account.email_changed`, `session.revoked`) carry IDs only (ADR-014). No IP stored (D6); the user agent is cut to 256 characters.
- Module boundaries: identity owns the logic; api, realtime and scheduler-worker only wire it; no model calls; the agent pipeline is unchanged.

## Findings

- O1 (observation, not blocking): `POST /me/email-change` counts the rate limit before `requireReauth`, so the 403 that opens the re-auth dialog and its retry use two of the five hourly requests. Harmless at 5/hour; swapping the two lines would make each user-visible request cost one.
- O2 (observation, not blocking): My account's loading, error-with-Try-again, saving and queued states are asserted by the builder's stubbed-API runs, not a committed spec; the backend behind them is covered by the integration suites (as for FEAT-007).
- O3 (observation, not blocking): the E2E accepts `/sign-in` or `/session-expired` after a device is signed out. With a revoked session's cookie the API answers 401 `session_expired`, so the shell goes to `/session-expired`; ui-design doesn't pin it, and AC-5 asks only for the 401.

## RTM

Test ref appended for AUTH-05, and AUTH-02 (partial: sign out one device or all, live sockets closed).

## CI

GitHub CI on `feat/FEAT-008-my-account` at `e0d0153`: result recorded below once the run completes.
