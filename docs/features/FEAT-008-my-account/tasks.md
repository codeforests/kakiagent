# Tasks: FEAT-008 — My account: profile, email change, sessions list

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: accepted · Last updated: 2026-10-31

- [x] T1 — Schema: `0041_my_account.sql` (`users.display_name` + check; `sessions.user_agent`; `email_changes` with the partial unique and the due index; grants to `app_identity` only) + Drizzle tables; RLS suite assertion that `app_dashboard` and `app_visitor` can't read `email_changes` or `users` (design §4; AC-7)
      Done when: `drizzle-kit generate` reports no drift after 0041; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with: a 61-character name refused by the check; a second live request for one user refused by the partial unique; the zone assertions.
- [x] T2 — Identity: `audit-user.ts` (moved from `mfa.ts`), `device.ts` `deviceLabel` (+ unit test), `emailChangeToken`, the three emails in `email.ts`, `account.ts` (get, update profile, request, send, `sendPendingEmailChanges` with the 7-day purge, cancel, confirm), `listSessions`, `revokeOwnSession`, `revokeAllSessions` returning IDs, `startSession(…, userAgent?)` and its callers, `displayName` in `AuthContext` and `listTeam`, `AccountError`; exports (design §5.1; D2–D9; AC-1–AC-5, AC-7)
      Done when: `pnpm --filter @kaki/identity test` (unit: `deviceLabel` for each browser/OS pair and null; token domain separation from `magic-link:` and `invite:`; masked address) and `scripts/test-env.sh pnpm --filter @kaki/identity test:integration` pass with: request leaves `users.email` unchanged and queues both emails, a send failure is retried once by the sweep (SKIP LOCKED); confirm changes the email, clears `google_sub`, deletes old sign-in links, a second confirm is `link_used`; replace and cancel kill the old token; taken at request → no link, confirm `link_invalid`; taken at confirm → `email_taken` with nothing changed; sessions listed live only with labels; revoking another user's session is `not_found`, the current `current_session`; audit entries hold no email or name.
- [x] T3 — Contracts, API, realtime, scheduler: the §3 contract section (+ unit test), `Me.user.displayName`, `TeamMember.displayName`; `apps/api/src/account.ts` (`registerAccountRoutes`, limiter, `requireReauth` on the request, public confirm), error mapping in `app.ts`, `meOf` and the sign-out routes' publish, user agent passed on sign-in; `channels.session` in `@kaki/platform`; `/ws` closes on it; scheduler tick runs `sendPendingEmailChanges`; `apps/api/test/account.int.test.ts` and a `ws.int.test.ts` case (design §5.2, §5.3; AC-1–AC-7)
      Done when: `pnpm --filter @kaki/contracts test`, `scripts/test-env.sh pnpm --filter @kaki/api test:integration` (the §5.2 cases; auth, mfa and team suites still green) and `scripts/test-env.sh pnpm --filter @kaki/realtime test:integration` pass; `pnpm --filter @kaki/api typecheck` and `--filter @kaki/scheduler-worker typecheck` are clean.

## Build session 2 (UI)

- [x] T4 — Dashboard data: `api.account`/`updateProfile`/`requestEmailChange`/`cancelEmailChange`/`confirmEmailChange`/`sessions`/`revokeSession`; `lib/account.ts` (hooks, the request through `useReauthGuard`, `accountErrorText`, `nameError`), `lib/account.test.ts` (design §5.4)
      Done when: `pnpm --filter @kaki/dashboard test` passes with `nameError` (empty, 61 chars, control characters, trimmed) and `accountErrorText` per code; dashboard typecheck clean.
- [x] T5 — SCR-APP-055 My account: Profile, Email (default, pending, queued; change dialog; cancel) and Devices cards (list, this device, sign out one with confirm, sign out of all devices) above the FEAT-006 two-step card; placeholder removed; the account menu shows the name; the Team row shows the name (ui-design SCR-APP-055; AC-1, AC-4, AC-5, AC-8)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run at 1280 and 375 shows each state in ui-design, logs the bodies of the profile patch and the email request, the re-auth dialog opens on a stubbed 403 `reauth_required` and the request re-runs, focus returns to the trigger after each dialog, axe clean.
- [x] T6 — `/verify-email` (SCR-APP-055, confirm state): `AuthLayout` route outside `AppShell`, token from the fragment then `history.replaceState`, auto-confirm once, the seven states (ui-design SCR-APP-055 "Confirm new email"; AC-2, AC-4, AC-8)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run shows each state and confirms only once on reload (the token is gone from the URL).
- [x] T7 — E2E: `e2e/tests/account.e2e.ts` (design §5.5; AC-1–AC-8)
      Done when: the spec typechecks (`pnpm --filter @kaki/e2e typecheck`); it runs in the verify stage's GitHub CI.
      Note: no Docker in cloud sessions, so the E2E run and the screen renders are checked in GitHub CI.
- [x] T8 — Verify: full `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for identity, api, dashboard; update `code-map.md` (identity `account.ts`, `device.ts`, `audit-user.ts`; `apps/api/src/account.ts`; `channels.session`; `pages/account-parts.tsx`, `pages/verify-email.tsx`); evidence below
      Done when: all pass; evidence recorded.

## Verification evidence

- AC-1 — identity `account.test.ts` + `api/test/account.int.test.ts` (profile, audit without the name); dashboard `lib/account.test.ts` (`nameError`); E2E `account.e2e.ts` sets, refuses, shows in the menu and clears the name. Stubbed-API browser run (2026-10-31): menu label "Mei Ling / owner@…", focus stays on the field after Save.
- AC-2 — api `account.int.test.ts` (request leaves the email, confirm changes it, used/expired/replaced/cancelled refused); E2E: link at the new address, old address signs in while pending, confirm, used link refused.
- AC-3 — identity `account.test.ts` (notice with masked address, queued retry); E2E reads the notice at the old address and checks the new address is not in it.
- AC-4 — api `account.int.test.ts` (cancel, replace, `same_email` 409, taken address 202 + "already in use" email, `email_taken` 409 on confirm); E2E: `same_email` field error.
- AC-5 — api `account.int.test.ts` (list, revoke other, 409 current, 404 other user); E2E: two devices listed, the other signed out, its next load goes to sign-in. Stubbed browser run: row removed, toast, focus on the Devices heading, "You're only signed in here."
- AC-6 — api `ws.int.test.ts` (4401 `session_ended` on sign-out paths, other sessions stay open).
- AC-7 — db `rls.int.test.ts` (`email_changes`, `users` unreadable by dashboard and visitor zones); api `account.int.test.ts` (another user's session 404).
- AC-8 — Stubbed-API Playwright run (Chromium, 2026-10-31): My account default and pending, `/verify-email` confirmed/expired/used/taken/error/invalid, each with the `h1` focused, axe serious/critical clean at 1280 light and 375 dark (it caught the FEAT-006 loading `div` with `aria-label`, now a `section`). E2E `account.e2e.ts` covers axe at 1280, 375 and dark in GitHub CI.

Checks (2026-10-31, build UI session): `pnpm format:check`, `pnpm lint` (ESLint + dependency-cruiser), `pnpm typecheck` (26/26) and `pnpm test` (24/24) green. `test:coverage` through `scripts/test-env.sh`: identity 102/102; api 330 passed, only `uploads.int.test.ts` fails (needs LocalStack, fails on main in cloud sessions too); the dashboard has no coverage script (its unit tests run in `pnpm test`). E2E and screen renders: GitHub CI in the verify stage (no Docker here).
