# Tasks: FEAT-007 — Team, invitations, roles, approval-rights grants, tenant switcher

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-31

- [x] T1 — Schema: `0040_team.sql` (`invitations` with checks, partial unique and indexes, forced RLS, `tenant_isolation` and `identity_lookup` policies; `memberships.approval_rights` + check; `magic_links.invitation_id` + check; `kaki_workspaces` role and `user_workspaces()`; grants) + Drizzle tables; name in `TENANT_SCOPED_TABLES`; RLS suite case (design §4; AC-8)
      Done when: `drizzle-kit generate` reports no drift after 0040; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with: B can't insert or update A's invitation; `app_dashboard` reads no invitations; `approval_rights = true` on an admin is refused; `user_workspaces(u)` returns only u's rows with names across two tenants; `app_dashboard` can't execute it.
- [x] T2 — Identity, invitations: capabilities (`team.manage`, `team.grant_approval`, `approvals.decide`, `canApprove`), `approvalRights` in `AuthContext`; `inviteToken`, `inviteEmail`; `invitations.ts` (create, resend, revoke, send, `sendPendingInvitations` with the 30-day purge, lookup, accept); `requestMagicLink` with an invitation and `consumeMagicLink` joining; `startSession(…, preferTenant?)` and the last-used rule; `InvitationError`; exports (design §5.1; D2, D4, D6, D9; AC-1–AC-3, AC-6, AC-7)
      Done when: `pnpm --filter @kaki/identity test` (unit: `canApprove` per role and grant; token domain separation from magic links) and `scripts/test-env.sh pnpm --filter @kaki/identity test:integration` pass with: create refuses member, deactivated and pending; an expired invite is replaced; send failure queues and the sweep sends once (SKIP LOCKED); accept by the right email joins once (a second accept is `link_used`), by another email is refused and leaves the invite live; resend kills the old token; a magic link carrying an invitation joins on verify and opens that tenant; sign-in opens the last-used workspace; audit entries hold no email.
- [x] T3 — Identity, team and workspaces: `team.ts` (`listTeam`, `updateMember` with the guards, rights cleared on role change, session revocation on that tenant only, audits), `workspaces.ts` (`listWorkspaces`, `switchWorkspace`, `NotMemberError`), `TeamError`; exports (design §5.1; D3, D5, D8; AC-4–AC-7)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/identity test:integration` passes with: the Owner's row and your own refused; Admin changes an Admin; rights only by the Owner and only on an active Agent; deactivation and role change revoke exactly the member's sessions on that tenant (one on another tenant survives) and `authenticate` then fails; reactivation keeps the role; `listWorkspaces` excludes deactivated memberships; switching to one is `NotMemberError`.
- [x] T4 — Contracts, API, realtime, scheduler: the §3 contract section (+ unit test), `Me.canApprove`, the magic-link body and Google `next=invite`; `apps/api/src/team.ts` (all §3 team, invitation and workspace routes, limiter, `channels.member` publish), error mapping in `app.ts`; `channels.member` in `@kaki/platform`; `/ws` closes on `session_ended`; scheduler tick runs `sendPendingInvitations`; `apps/api/test/team.int.test.ts` and a `ws.int.test.ts` case (design §5.2, §5.3; AC-1–AC-8)
      Done when: `pnpm --filter @kaki/contracts test`, `scripts/test-env.sh pnpm --filter @kaki/api test:integration` (the §5.2 cases; existing auth and mfa suites still green) and `scripts/test-env.sh pnpm --filter @kaki/realtime test:integration` pass; `pnpm --filter @kaki/api typecheck` and `--filter @kaki/scheduler-worker typecheck` are clean.

## Build session 2 (UI)

- [x] T5 — Dashboard data: `api.team`/`invite`/`resendInvite`/`revokeInvite`/`updateMember`/`lookupInvite`/`acceptInvite`/`workspaces`/`switchWorkspace`, the magic-link call's `invitation`; `lib/team.ts` (hooks, `roleLabel`, `inviteErrorText`, `memberActions`), `lib/workspaces.ts`; `lib/team.test.ts` (design §5.4)
      Done when: `pnpm --filter @kaki/dashboard test` passes with `memberActions` for each viewer role × member role × status (Owner row and self have none; rights only for the Owner on active Agents) and `inviteErrorText` per error code; dashboard typecheck clean.
- [x] T6 — SCR-APP-045 Team: members table (stacked list < 768), invitations section, invite dialog, role/deactivate/reactivate confirm dialogs, rights toggle, Agent read-only view; the FEAT-006 card kept below, the placeholder removed (ui-design SCR-APP-045; AC-4, AC-6, AC-9)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run at 1280 and 375 shows each state in ui-design, logs the request bodies of invite, resend, revoke and each patch, focus returns to the row's menu after a dialog, axe clean.
      Note: renders against the real stack and full axe run in the verify stage's GitHub CI.
      Evidence (2026-10-31, stubbed-API Chromium at 1280 and 375): 5 members, 3 invitations (pending, expired, queued); no actions on the Owner/your row; Owner's Agent menu "Change role | ✓Remove approval rights | Deactivate", Admin's "Change role | Deactivate", deactivated "Reactivate"; bodies `{"role":"admin"}`, `{"approvalRights":true}`, `{"status":"deactivated"}`, `{"status":"active"}`, invite `{"email":"staff@kaki-bakery.test","role":"admin"}` (trimmed, lower-cased), resend `POST …/:id/resend`, revoke `DELETE …/:id`; `invite_pending` alert keeps focus in the field; focus back on the row's menu after role and deactivate dialogs, on "Invite someone" after inviting, on the Invitations heading after revoke; Agent read-only alert, only-the-Owner empty state, loading skeleton, error with Try again; axe clean on each (and on the open menu and dialogs). `FormDialog` gained `onCloseAutoFocus` (as `ConfirmDialog` has) for the focus return.
- [x] T7 — SCR-APP-004 Accept invitation: `/invite` in the auth layout (outside `AppShell`), token from the fragment (then `history.replaceState`), lookup, the seven states, Join, "Email me a sign-in link" (sends `invitation`), Google with `sessionStorage` and auto-join on return, "Sign out and continue" (ui-design SCR-APP-004; AC-2, AC-3, AC-9)
      Done when: dashboard typecheck passes; stubbed-API Chromium run shows each state with axe clean at 1280 and 375, light and dark, and the token never appears in a request URL (logged URLs only).
      Evidence (2026-10-31): valid signed in, valid signed out (+ sent), wrong email, expired, used, revoked, invalid (no token), joining and error, axe clean at 1280/375 × light/dark (32 runs); `#token=` gone from the address bar on load; requests: `POST /api/v1/invitations/lookup`, `/accept`, `/auth/magic-link` with the token only in bodies; Join → `/` with "Welcome to Kaki Bakery."; title "Join Kaki Bakery · KakiAgent". The token is kept in `sessionStorage` for the tab (Google return, two-step detour) and cleared on join or an ended state. Google's real redirect and auto-join run in CI only (E2E has no Google).
- [x] T8 — Tenant switcher: `shell/tenant-switcher.tsx` in the top bar (menu with ≥ 2 workspaces, checked current, roles as secondary text; plain name otherwise); switch clears the query cache, reconnects the socket, goes to `/`, toasts (ui-design "Tenant switcher"; AC-7, AC-9)
      Done when: dashboard typecheck passes; stubbed-API Chromium run: one workspace shows a plain name; two show the menu; choosing the other posts the switch and the tenant name changes; keyboard (Enter, arrows, Esc) works; axe clean.
      Evidence (2026-10-31, 1280 and 375): one workspace → plain `tenant-name`, no button; two → "Switch business, current: Kaki Bakery", current `aria-checked=true`; Esc closes; Enter, ArrowDown, Enter posts `POST /api/v1/workspaces/<T2>/switch`, lands on `/` with "Switched to Second Tenant." and the name changes; axe clean with the menu open. The inbox socket reconnects because `/` unmounts the inbox (its hook opens a new socket on mount). A 404 shows "You're no longer a member of {name}." in the banner slot.
- [ ] T9 — E2E: `e2e/tests/team.e2e.ts` and the two FEAT-006 leftovers in `two-step.e2e.ts` (design §5.5; AC-1–AC-9)
      Done when: the specs typecheck and lint; they run in the verify stage's GitHub CI on Chromium, Firefox and WebKit.
      Note: no local stack in cloud sessions (STATE.md); the invite and sign-in steps read Mailpit as `auth.e2e.ts` does.
- [ ] T10 — Verify: full `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for identity, api, dashboard; update `code-map.md` (identity `invitations.ts`, `team.ts`, `workspaces.ts`; `team.ts` route file; `shell/tenant-switcher.tsx`; `channels.member`); evidence below
      Done when: all pass locally through `scripts/test-env.sh`; evidence filled.

## Verification evidence

- AC-1:
- AC-2:
- AC-3:
- AC-4:
- AC-5:
- AC-6:
- AC-7:
- AC-8:
- AC-9:
