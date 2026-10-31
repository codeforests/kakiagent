# Tasks: FEAT-008 — My account: profile, email change, sessions list

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-31

- [x] T1 — Schema: `0041_my_account.sql` (`users.display_name` + check; `sessions.user_agent`; `email_changes` with the partial unique and the due index; grants to `app_identity` only) + Drizzle tables; RLS suite assertion that `app_dashboard` and `app_visitor` can't read `email_changes` or `users` (design §4; AC-7)
      Done when: `drizzle-kit generate` reports no drift after 0041; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with: a 61-character name refused by the check; a second live request for one user refused by the partial unique; the zone assertions.
- [x] T2 — Identity: `audit-user.ts` (moved from `mfa.ts`), `device.ts` `deviceLabel` (+ unit test), `emailChangeToken`, the three emails in `email.ts`, `account.ts` (get, update profile, request, send, `sendPendingEmailChanges` with the 7-day purge, cancel, confirm), `listSessions`, `revokeOwnSession`, `revokeAllSessions` returning IDs, `startSession(…, userAgent?)` and its callers, `displayName` in `AuthContext` and `listTeam`, `AccountError`; exports (design §5.1; D2–D9; AC-1–AC-5, AC-7)
      Done when: `pnpm --filter @kaki/identity test` (unit: `deviceLabel` for each browser/OS pair and null; token domain separation from `magic-link:` and `invite:`; masked address) and `scripts/test-env.sh pnpm --filter @kaki/identity test:integration` pass with: request leaves `users.email` unchanged and queues both emails, a send failure is retried once by the sweep (SKIP LOCKED); confirm changes the email, clears `google_sub`, deletes old sign-in links, a second confirm is `link_used`; replace and cancel kill the old token; taken at request → no link, confirm `link_invalid`; taken at confirm → `email_taken` with nothing changed; sessions listed live only with labels; revoking another user's session is `not_found`, the current `current_session`; audit entries hold no email or name.
- [x] T3 — Contracts, API, realtime, scheduler: the §3 contract section (+ unit test), `Me.user.displayName`, `TeamMember.displayName`; `apps/api/src/account.ts` (`registerAccountRoutes`, limiter, `requireReauth` on the request, public confirm), error mapping in `app.ts`, `meOf` and the sign-out routes' publish, user agent passed on sign-in; `channels.session` in `@kaki/platform`; `/ws` closes on it; scheduler tick runs `sendPendingEmailChanges`; `apps/api/test/account.int.test.ts` and a `ws.int.test.ts` case (design §5.2, §5.3; AC-1–AC-7)
      Done when: `pnpm --filter @kaki/contracts test`, `scripts/test-env.sh pnpm --filter @kaki/api test:integration` (the §5.2 cases; auth, mfa and team suites still green) and `scripts/test-env.sh pnpm --filter @kaki/realtime test:integration` pass; `pnpm --filter @kaki/api typecheck` and `--filter @kaki/scheduler-worker typecheck` are clean.

## Build session 2 (UI)

- [ ] T4 — Dashboard data: `api.account`/`updateProfile`/`requestEmailChange`/`cancelEmailChange`/`confirmEmailChange`/`sessions`/`revokeSession`; `lib/account.ts` (hooks, the request through `useReauthGuard`, `accountErrorText`, `nameError`), `lib/account.test.ts` (design §5.4)
      Done when: `pnpm --filter @kaki/dashboard test` passes with `nameError` (empty, 61 chars, control characters, trimmed) and `accountErrorText` per code; dashboard typecheck clean.
- [ ] T5 — SCR-APP-055 My account: Profile, Email (default, pending, queued; change dialog; cancel) and Devices cards (list, this device, sign out one with confirm, sign out of all devices) above the FEAT-006 two-step card; placeholder removed; the account menu shows the name; the Team row shows the name (ui-design SCR-APP-055; AC-1, AC-4, AC-5, AC-8)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run at 1280 and 375 shows each state in ui-design, logs the bodies of the profile patch and the email request, the re-auth dialog opens on a stubbed 403 `reauth_required` and the request re-runs, focus returns to the trigger after each dialog, axe clean.
- [ ] T6 — `/verify-email` (SCR-APP-055, confirm state): `AuthLayout` route outside `AppShell`, token from the fragment then `history.replaceState`, auto-confirm once, the seven states (ui-design SCR-APP-055 "Confirm new email"; AC-2, AC-4, AC-8)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run shows each state and confirms only once on reload (the token is gone from the URL).
- [ ] T7 — E2E: `e2e/tests/account.e2e.ts` (design §5.5; AC-1–AC-8)
      Done when: the spec typechecks (`pnpm --filter @kaki/e2e typecheck`); it runs in the verify stage's GitHub CI.
      Note: no Docker in cloud sessions, so the E2E run and the screen renders are checked in GitHub CI.
- [ ] T8 — Verify: full `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for identity, api, dashboard; update `code-map.md` (identity `account.ts`, `device.ts`, `audit-user.ts`; `apps/api/src/account.ts`; `channels.session`; `pages/account-parts.tsx`, `pages/verify-email.tsx`); evidence below
      Done when: all pass; evidence recorded.

## Verification evidence

- AC-1 —
- AC-2 —
- AC-3 —
- AC-4 —
- AC-5 —
- AC-6 —
- AC-7 —
- AC-8 —
