# Acceptance report: FEAT-007 — Team, invitations, roles, approval-rights grants, tenant switcher

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-10-31 by an independent verify session · Branch `feat/FEAT-007-team` · PR #42

## Verdict summary

**Accepted.** DSH-03 and AUTH-04 are met; AUTH-02 gains its "after a role change or deactivation" clause. D3's approval-rights grant and `canApprove` are in place for the approvals features (APR-02 stays with them). Every criterion below has a test that asserts what it says, and every local result was produced in this session. E2E (`team.e2e.ts`, new, and the FEAT-006 leftovers added to `two-step.e2e.ts`) run only in GitHub CI.

## Audit standard

Re-derived from SRS v0.4 DSH-03 ("invite by email, assign role, deactivate"; "deactivated users lose access immediately"), AUTH-04 (single-use, 7 days, bound to the invited email, several tenants, switcher lists only active memberships), AUTH-02's revocation clause, D3; UC-06 1–4 with 3a, UC-02 4; technical-design §6 AC-1..AC-9, D1–D9. Each FR maps to at least one AC; the criteria are faithful to the statements ("immediately" → AC-5 revokes sessions and closes the socket in the same request, not at expiry; "rejected" → 403 `invite_wrong_email` with the invite left live).

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 | DSH-03, AUTH-04; UC-06 1–2 | identity `invitations.int` "creating and sending" (4); api `team.int` invite → email → lookup, queued send, limiter, refusals; `team.e2e` | Yes: one email, 7-day expiry, pending listing, audit holds IDs and role only (no email); failed send queued, sweep sends once with two workers | Pass |
| AC-2 | AUTH-04; UC-06 3, 3a | identity "accepting" (5); api "a different address gets 403…; expired, used, revoked"; `team.e2e` wrong email, used, revoked | Yes: right address joins once with the role; other address 403 and invite still usable; resend kills the old link; B can't resend/revoke A's | Pass |
| AC-3 | AUTH-04; UC-06 3 | identity "sign in to join" (2); api magic link with invitation, Google `next=invite` allow-list; `team.e2e` signed-out "Email me a sign-in link" | Yes for magic link; Google join path is unit/route-level only (see O1) | Pass |
| AC-4 | DSH-03; UC-06 4 | identity "changing members" (4); api "an Admin manages Admins and Agents but not the Owner or themself" | Yes: Owner's and own row refused, Admin changes Admin, audits with codes only | Pass |
| AC-5 | DSH-03, AUTH-02 | identity "ending sessions" (2); api deactivation and role change end sessions (401) and publish `session_ended`; realtime `ws.int` closes 4401, other member's socket stays open; `team.e2e` session ends after a change | Yes: only that tenant's sessions end (another tenant's survives); deactivated member can't switch back | Pass |
| AC-6 | D3; APR-02 | identity unit `canApprove` per role and grant; identity "approval rights…"; api "rights only by the Owner on Agents; Me.canApprove follows"; db RLS "approval rights only on an agent" | Yes: Owner only, active Agent only, cleared by role change; DB check refuses rights on an admin | Pass |
| AC-7 | AUTH-04; UC-02 4 | identity "workspaces", "last-used workspace"; api "lists active memberships by name and switches"; db `user_workspaces`; `team.e2e` invitee in two businesses | Yes: exactly the active memberships; switch to a non-member tenant 404; new sign-in opens last used | Pass |
| AC-8 | ADR-005; RBAC | db `rls.int` (B can't insert/update/delete A's invitations; other zones read nothing; `app_dashboard` can't execute `user_workspaces`); api "Agents get 403 on every team route", "tenant B's owner can't see, resend, revoke or patch tenant A's rows" | Yes | Pass |
| AC-9 | SCR-APP-045, -004, switcher; NFR-19, NFR-09 | `team.e2e` `axeEverywhere` (1280/375 × light/dark) on Team, invite dialog and SCR-APP-004 states; `lib/team.test.ts`; builder's stubbed-API runs (tasks.md T6–T8) | Yes in CI; loading/error/expired/queued states rest on the stub runs (O2) | Local: unit pass; E2E in CI |

## Corrected tests

- `team.e2e.ts` (AC-2, `27e6a63`): after revoking an invitation it expected focus on the Invitations heading, but the revoked one was the only invitation, so the section and its heading are gone and focus goes to "Invite someone" (`team.tsx`'s fallback). It now expects the heading when the section remains and the button when it doesn't.
- `team.e2e.ts`, `two-step.e2e.ts` (AC-9, `9a3501e`): axe refuses pages opened with `browser.newPage()`; the extra pages now come from `browser.newContext()`.

Otherwise none. Test diff reviewed (`git diff origin/main...HEAD` on `*.test.ts`, `*.int.test.ts`, `e2e/`): no skips, `.only`, `.todo` or deleted cases. The only removed test-support lines are `magicLinkFor`, rewritten with a `path` argument (`'invite'`) and the same matching; `ws.int`'s fake `subscribe` gained channel recording.

## Independent execution

Fresh `pnpm install`, `pnpm tokens`, then: `pnpm format:check` clean; `pnpm lint` (ESLint + dependency-cruiser, 605 modules, no violations); `pnpm typecheck` 26/26; `pnpm test` 24/24 tasks (identity 25, contracts 23, dashboard 141 among them). Through `scripts/test-env.sh`: integration identity 49, db 160, realtime 6, api 307 passed + 1 skipped; `test:coverage` with thresholds green for identity, db, contracts, realtime, dashboard, ui. Two suites need a container runtime this session lacks, both untouched by the feature and green in CI: api `uploads.int` "the S3 presigner" (no `KAKI_TEST_S3_ENDPOINT`) and platform `rate-limit.int` (Valkey via Testcontainers), which also fail those packages' local coverage runs.

## Direct verification

- Tenant ID only from the session in every route (`apps/api/src/team.ts`: `s.tenantId`, `a.tenantId`; the switch target is a path param checked against `user_workspaces`, 404 when not a member).
- Migration 0040: `invitations` forced RLS with `tenant_isolation`; `identity_lookup FOR SELECT TO app_identity USING (true)` is the design's (§4) lookup-before-tenant pattern, and every identity query also filters `tenant_id` explicitly (`team.ts`, `invitations.ts`); column-limited UPDATE grants; `user_workspaces` SECURITY DEFINER with a fixed `search_path`, EXECUTE to `app_identity` only. Name in `TENANT_SCOPED_TABLES`, cases in `rls.int`.
- Audit entries (`member.invited`, role, status, rights) carry IDs and codes only; tests assert no email in them (ADR-014).
- Accept runs in one transaction with the claim; a refusal rolls the claim back, so the invite stays usable.

## Findings

- O1 (observation, not blocking): Google sign-in to join (D4) is covered at the route level (`next=invite` allow-list) and by the shared consume path, not end to end; it needs a real Google account.
- O3 (observation, not blocking): ui-design says focus moves to the Invitations heading after a revoke; when the last invitation goes, the code focuses "Invite someone". Sensible, but worth a line in ui-design when the screen is next touched.
- O2 (observation, not blocking): Team's loading, error-with-Try-again, expired and queued states, and the switcher's 404 alert, are asserted by the builder's stubbed-API runs, not by a committed spec; the backend behind them is covered by the integration suites.

## RTM

Test ref appended for AUTH-04, DSH-03, and AUTH-02 (partial: sessions end on a role change or deactivation).

## CI

GitHub CI run 84 at `27e6a63`, 2026-10-31: all jobs green (E2E Chromium, Firefox, WebKit; integration and coverage; unit; lint/typecheck; build and size; eval; Terraform; scanning). Two earlier runs (on `6054007`, `9a3501e`) found, besides the two test corrections above, one real defect, fixed on the branch:

- F1 (`9a3501e`): switching business from `/` showed no "Switched to …" toast. The switcher navigates to `/` with the toast in router state, but `useToast` (`lib/form.ts`) read that state only when the page mounted, and Home was already mounted. `useToast` now also takes a toast that arrives with a new location. Only the real stack exposed it: the builder's stubbed run switched from another page.
