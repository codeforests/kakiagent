# Technical design: FEAT-007 — Team, invitations, roles, approval-rights grants, tenant switcher

> Implements: DSH-03 (invite by email, assign role, deactivate; deactivated users lose access at once), AUTH-04 (single-use invite links, 7 days, bound to the invited email; one person in several tenants with a switcher of active memberships), AUTH-02 (p: "after a role change or deactivation the old session cannot call any API"), D3 (the Owner grants approval rights to individual Agents) · Realizes: UC-06 (1–4, 1a, 3a; 1b was FEAT-006), UC-02 step 4 (the switcher) · Screens: SCR-APP-045 (completes it), SCR-APP-004 (new), the top bar's `tenant-switcher` · Module: `identity` (invites, memberships; architecture §5.2)
> Status: designed · 2026-10-31

## 1. Intent

Today a tenant has one member, its Owner, and a person sees only the workspace they last created. This feature lets the Owner or an Admin invite staff by email as Admin or Agent, change a member's role, deactivate and reactivate them, and lets the Owner give individual Agents the right to decide approvals (D3, used by FEAT-055). The invitee opens a single-use link, signs in with the invited address and joins; a link opened while signed in as anyone else is refused. Someone who belongs to several businesses switches between them from the top bar. A role change or deactivation ends that member's sessions in the tenant at once, live sockets included.

## 2. Codebase context

- **Identity** (`packages/identity/src`): `memberships` (PK `(tenant_id, user_id)`, `role`, `status` `active|deactivated`) is tenant-scoped with forced RLS; `app_identity` reads every row through the `identity_read` policy and may INSERT (0007). `app_dashboard` has SELECT only. `users`, `sessions`, `magic_links`, `mfa_factors` are identity-zone only. `authenticate` (`sessions.ts`) re-reads the membership on every request; a deactivated one leaves `tenantId`/`role` null, so tenant routes already answer 403 `no_workspace`. `startSession` (`users.ts`) opens the earliest active membership (FEAT-005 D11, replaced here). `capabilities.ts` holds `POLICY` and `can(role, cap)`. Tokens: `magicLinkToken(secret, id)` = HMAC of `magic-link:{id}` (`tokens.ts`); links are sent now and retried by the scheduler sweep `sendPendingMagicLinks` (FEAT-005 §5.3), the pattern invitations copy.
- **API** (`apps/api/src/auth.ts`): `authFrom(req, { allow })`, `sessionFrom(req)` → `TenantSession { sessionId, userId, tenantId, role, reauthFresh, mfaEnrolled }`; `/api/v1/me`, `POST /api/v1/workspaces`, magic link and Google routes. The rate limiter (`createRateLimiter`, Valkey, fail closed) and mailer are in the api deps. `notify(channels, event)` in `app.ts` publishes after commit.
- **Realtime** (`apps/realtime/src/app.ts`): `/ws` authenticates once at connect and subscribes to `channels.inbox(tenantId)`; nothing closes it afterwards.
- **Team page** (FEAT-006): `/settings/team`, `pages/team.tsx` with the Owner's "Require two-step verification" card (`GET/PUT /api/v1/team/mfa`) and a placeholder naming this feature. FEAT-006 left two E2E cases for here: Admin/Agent read-only Team and forced enrolment of a second member.
- **Design:** design.md §4.5 `table`/`list`, `status-badge`, `menu`, `tenant-switcher` (§4.6), `dialog`/`confirm-dialog`, `select`, `toast`, `alert`, `empty-state`; SRS §2.1 role table; ux-foundations SCR-APP-004 (valid, wrong email, expired), SCR-APP-045 (P, invite pending).

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: team, invitations and workspaces (DSH-03, AUTH-04; FEAT-007 §3)`)

```ts
InvitableRole = z.enum(['admin', 'agent'])                    // never 'owner' (transfer is FEAT-010)
TeamMember = z.object({
  userId: z.uuid(), email: z.string(), role: Role, status: z.enum(['active', 'deactivated']),
  approvalRights: z.boolean(),                                // only ever true for an agent
  mfaEnrolled: z.boolean(), joinedAt: z.iso.datetime(), lastActiveAt: z.iso.datetime().nullable(),
  you: z.boolean(),
})
TeamInvitation = z.object({
  id: z.uuid(), email: z.string(), role: InvitableRole, invitedBy: z.string(),   // inviter's email
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  state: z.enum(['pending', 'expired']), delivery: z.enum(['sent', 'queued']),
})
TeamResponse = z.object({ members: z.array(TeamMember), invitations: z.array(TeamInvitation) })
InviteBody = z.object({ email: MagicLinkRequest.shape.email, role: InvitableRole })   // trimmed, lower-cased
MemberPatch = z.union([                                        // exactly one change per request
  z.object({ role: InvitableRole }).strict(),
  z.object({ status: z.enum(['active', 'deactivated']) }).strict(),
  z.object({ approvalRights: z.boolean() }).strict(),
])
InvitationTokenBody = MagicLinkVerifyBody                      // { token }, as FEAT-005's verify
InvitationLookup = z.object({
  state: z.enum(['valid', 'expired', 'used', 'revoked']),
  tenantName: z.string(), role: InvitableRole, email: z.string(), invitedBy: z.string(),
  signedInAs: z.string().nullable(),                           // the cookie's user, if any
})
Workspace = z.object({ id: z.uuid(), name: z.string(), role: Role, current: z.boolean() })
WorkspaceList = z.object({ workspaces: z.array(Workspace) })
// Changed: Me gains canApprove (D3; FEAT-055's nav and queue read it)
Me = { …, canApprove: z.boolean() }
// Changed: MagicLinkRequest gains invitation: z.string().max(100).optional() (sign in to join, §5.1)
```

| Route | Auth | Body | 2xx | Errors |
|---|---|---|---|---|
| `GET /api/v1/team` | session, `team.manage` | — | `TeamResponse` (members: owner first, then active by email, then deactivated; invitations: pending and expired, newest first) | 403 Agent |
| `POST /api/v1/team/invitations` | `team.manage` | `InviteBody` | 201 `TeamInvitation` | 409 `already_member`; 409 `member_deactivated` ("{email} was deactivated. Reactivate them instead."); 409 `invite_pending`; 429 `rate_limited` (30 per tenant per hour); 400 |
| `POST /api/v1/team/invitations/:id/resend` | `team.manage` | — | 200 `TeamInvitation` (a new id, token and 7 days; the old link stops working) | 404 (unknown, other tenant, accepted or revoked); 429 |
| `DELETE /api/v1/team/invitations/:id` | `team.manage` | — | 204 | 404 |
| `PATCH /api/v1/team/members/:userId` | `team.manage`; `approvalRights` needs `team.grant_approval` (Owner) | `MemberPatch` | 200 `TeamResponse` | 403 `owner_protected` (the Owner's row); 409 `self_change` (your own row); 409 `not_agent` (rights on a non-agent); 409 `member_deactivated` (role or rights on a deactivated member); 403 `forbidden`; 404 |
| `POST /api/v1/invitations/lookup` | none (cookie optional) | `InvitationTokenBody` | 200 `InvitationLookup` | 400 `link_invalid` (no such token) |
| `POST /api/v1/invitations/accept` | `authFrom` (mfa `ok`, or `enrol` for a user whose current workspace forces it) | `InvitationTokenBody` | 200 `Me` (the session now on the joined tenant) | 403 `invite_wrong_email` ("This invitation is for {email}."); 400 `link_expired` / `link_used` / `link_invalid` (revoked reads as invalid); 401 |
| `POST /api/v1/auth/magic-link` (changed) | none | `{ email, invitation? }` | 202 as before | **new:** 400 `invite_wrong_email` when `invitation` is given and isn't valid for that email (the page only sends the invited address) |
| `GET /api/v1/auth/google/start?next=invite` (changed) | none | — | 302 | `next` is allow-listed (`invite` only); the callback then redirects to `/invite` instead of `/` or `/welcome` |
| `GET /api/v1/workspaces` | `authFrom` | — | `WorkspaceList` (active memberships only, by name) | 401 |
| `POST /api/v1/workspaces/:tenantId/switch` | `authFrom` (allow `enrol`) | — | 200 `Me` | 404 (no active membership there) |

- Accepting an already active member's invitation consumes it and switches the session there (no error). A suspended tenant is listed and switchable; the shell shows its suspended screen as today.
- Errors use the existing envelope; the identity error classes gain `TeamError(code)` and `InvitationError(code)` mapped in `app.ts` like the others.

## 4. Schema changes (migration `0040_team.sql`, Drizzle DDL + hand-written RLS, grants and function in the same file)

| Table | Change |
|---|---|
| `invitations` (new, tenant-scoped) | `tenant_id uuid` → tenants; `id uuid` default random; `email text` (normalised); `role text` check `in ('admin','agent')`; `invited_by uuid` → users; `token_hash bytea` not null unique; `created_at`; `expires_at` (created + 7 days); `accepted_at`, `accepted_by uuid` → users, `revoked_at` null; `sent_at` null, `send_attempts int` default 0, `next_attempt_at` default now. PK `(tenant_id, id)`; unique `id`; partial unique `(tenant_id, email) where accepted_at is null and revoked_at is null` (one live invite per address; an expired one is revoked when a new one is made); index `(next_attempt_at) where sent_at is null`. |
| `memberships` | + `approval_rights boolean not null default false`, check `memberships_rights_ck (approval_rights = false or role = 'agent')`. |
| `magic_links` | + `invitation_id uuid` null (no FK: the invitation is tenant-scoped); check `purpose = 'sign_in' or invitation_id is null`. |

- `invitations`: forced RLS, `tenant_isolation` policy, plus `identity_lookup FOR SELECT TO app_identity USING (true)` (the lookup and the sweep find a row by token hash or due time before any tenant context, as `identity_read` does for memberships). Name in `TENANT_SCOPED_TABLES`; a case in `rls.int.test.ts` (B can't update or insert A's invitation; `app_dashboard` reads nothing).
- Grants to `app_identity`: `invitations` SELECT, INSERT, UPDATE (`accepted_at`, `accepted_by`, `revoked_at`, `sent_at`, `send_attempts`, `next_attempt_at`), DELETE (the purge); `memberships` UPDATE (`role`, `status`, `approval_rights`) under `tenant_isolation`. `app_dashboard` gets nothing new (the team routes run in the identity zone, which alone can read `users`).
- Function `user_workspaces(p_user uuid) returns table (tenant_id, name, status, role)`, SECURITY DEFINER, owned by a new NOLOGIN role `kaki_workspaces` with SELECT on `memberships (tenant_id, user_id, role, status)` and `tenants (id, name, status)` through `FOR SELECT TO kaki_workspaces USING (true)` policies; EXECUTE to `app_identity` only. The switcher needs names across tenants, which `tenant_isolation` on `tenants` hides (the 0037 `user_mfa_required_by` pattern).
- **Seed:** none. Specs create members through invitations with unique addresses, so dev-tenant counts other specs assert ("1 of 1 members") don't move.
- **Rollback:** forward-only; dropping the table, the two columns, the function and the role reverses it.

## 5. Component design

### 5.1 Identity (`packages/identity/src`)
- `capabilities.ts`: new `team.manage` (owner, admin), `team.grant_approval` (owner), `approvals.decide` (owner, admin). `canApprove({ role, approvalRights })` = `can(role, 'approvals.decide') || (role === 'agent' && approvalRights)`. `AuthContext` and the api's `TenantSession` gain `approvalRights` (read with the membership in `authenticate`'s one query).
- `tokens.ts`: `inviteToken(secret, id)` = HMAC(`MAGIC_LINK_SECRET`, `invite:{id}`), so a database read can't produce a link and a retry needs no stored secret (FEAT-005 D6). Link `{PUBLIC_APP_URL}/invite#token={token}` (fragment, FEAT-005 D4). `email.ts`: `inviteEmail(to, { tenantName, inviter, role, url, expiresAt })`.
- `invitations.ts`: `createInvitation(idDb, ctx, { email, role })` (one transaction under `withTenant`: refuse active or deactivated members and a live pending invite; revoke an expired one for the address; insert; audit `member.invited` `{ role }` subject `invitation:{id}`); `resendInvitation` (revoke the old row, insert a copy with a new id, audit `member.invite_resent` `{ previous }`); `revokeInvitation` (audit `member.invite_revoked`); `sendInvitation(idDb, mailer, cfg, id)` and `sendPendingInvitations` (the magic-link pattern: send now with a 5 s timeout, on failure backoff 10 s … 2 min while unexpired; the sweep also deletes invitations accepted, revoked or expired more than 30 days ago: the address has no further use); `lookupInvitation(idDb, token, viewer)`; `acceptInvitation(tx, invitationRow, user)`.
- **Accepting** (one identity transaction, tenant context from the invitation row, a trusted source): `update invitations set accepted_at, accepted_by where token_hash = $1 and accepted_at is null and revoked_at is null and expires_at > now() returning …` is the atomic claim; then the user's email must equal the invitation's (else `invite_wrong_email`, the claim rolls back); insert the membership with the invited role (`on conflict do nothing` for an already active member); audit `member.joined` `{ role, invitation }` actor `user:{id}`; set the session's `active_tenant_id`.
- **Sign in to join** (§3 changed routes): `requestMagicLink(idDb, cfg, email, invitationId?)` stores `invitation_id` after checking the invitation is live for that email. `consumeMagicLink`, after the sign-in claim, runs `acceptInvitation` when the link carries one and it is still live (an expired or revoked one is skipped: the user signs in and SCR-APP-004 explains), and `startSession` opens that tenant. Google: the page keeps the token in `sessionStorage` and returns to `/invite`, which posts accept (D4).
- `startSession(tx, userId, method, preferTenant?)`: opens `preferTenant` when given; else the tenant of the user's most recently seen session whose membership is still active; else the earliest active membership (replaces FEAT-005 D11, D6).
- `team.ts`: `listTeam(tx, tenantId, viewer)`; `updateMember(idDb, ctx, userId, patch)` → in one transaction: guards (§3 errors), the update, audit (`member.role_changed { from, to }`, `member.deactivated`, `member.reactivated`, `member.approval_rights_changed { granted }`), and for a role change or deactivation `update sessions set revoked_at = now() where user_id = $1 and active_tenant_id = $tenant and revoked_at is null` (AUTH-02; sessions on other tenants are untouched). A role change clears `approval_rights` (an Agent promoted and later demoted must be granted again, D5). Reactivation keeps the stored role. Returns the revoked count for the caller's notification.
- `workspaces.ts`: `listWorkspaces(idDb, userId, currentTenantId)` via `user_workspaces`; `switchWorkspace(idDb, sessionId, userId, tenantId)` (update `active_tenant_id` only when an active membership exists, else `NotMemberError` → 404).

### 5.2 API (`apps/api/src/team.ts`, `registerTeamRoutes(app, deps, { authFrom, sessionFrom })`, wired at the end of `app.ts`)
- Team routes run `withTenant(identityDb, s.tenantId, …)`; the tenant comes from the session only. Invitations use the limiter key `rl:inv:t:{tenantId}`. After a role change or deactivation the route publishes `{ type: 'session_ended' }` on `channels.member(tenantId, userId)` (new in `@kaki/platform` pubsub: `t:{tenantId}:user:{userId}`), post-commit, like `notify`.
- Invitation and workspace routes live here too; `auth.ts` changes only the magic-link body, Google `next`, `Me.canApprove` and the invite lookup's optional cookie read.
- No re-authentication: none of these actions is in AUTH-03's list (D7).
- Tests: `apps/api/test/team.int.test.ts` (from `testApp`, `sessionCookie`, `fakeMailer`): invite → email captured → lookup → accept as the invited user (new and existing); wrong email 403 and the invite still usable; expired, used, revoked; resend kills the old token; already member, deactivated, pending conflicts; rate limit; Agent 403 on every team route; Admin can manage Agents and Admins but not the Owner; self change 409; rights only by the Owner and only on Agents; role change and deactivation → the member's session gets 401 `session_expired` on its next call and `no_workspace` never leaks data; the member's session on another tenant still works; switch lists only active memberships and refuses a deactivated one; magic link with `invitation` joins on verify; tenant B's owner can't see, resend, revoke or patch tenant A's rows (404).

### 5.3 Realtime and scheduler
- `/ws` also subscribes to `channels.member(tenantId, userId)` and closes with 4401 `session_ended` on that event; the dashboard's socket hook already treats 4401 as signed out. Test in `apps/realtime/test/ws.int.test.ts` (a revoked member's socket closes with 4401; another member's stays open).
- scheduler-worker runs `sendPendingInvitations` in the magic-link tick (every 5 s, SKIP LOCKED claim, `withTenant` per row for the update).

### 5.4 Dashboard (detail in ui-design.md)
- `lib/team.ts` (`useTeam`, `useInvite`, `useResend`, `useRevoke`, `useUpdateMember`, `roleLabel`, `inviteErrorText`, `memberActions(viewer, member)` pure rules), `lib/workspaces.ts` (`useWorkspaces`, `useSwitchWorkspace`: on success `queryClient.clear()`, socket reconnect, navigate to `/`).
- `pages/team.tsx` completes SCR-APP-045 (members table/list, invitations, invite dialog, role and deactivate confirm dialogs, rights toggle) above FEAT-006's card; `pages/team-parts.tsx` holds the parts.
- `pages/invite.tsx` (SCR-APP-004) under the auth layout at `/invite`, outside `AppShell`.
- `shell/tenant-switcher.tsx` replaces the top bar's tenant name: a menu when there are two or more workspaces, the plain name otherwise.

### 5.5 E2E (`e2e/tests/team.e2e.ts`, and `two-step.e2e.ts` gains FEAT-006's two leftovers)
Owner invites `staff+{run}@kaki-bakery.test` as Agent → the email in Mailpit → opening it signed in as the Owner shows wrong email → sign out, "Email me a sign-in link" → the new link joins → the Agent sees Team read-only (FEAT-006 leftover) → Owner grants approval rights, promotes to Admin, deactivates: the Agent's next page load shows sign-in. Second tenant's owner invites the same address; after accepting, the switcher lists both and switching changes the tenant name and the inbox. Forced enrolment: with "Require two-step" on, the new member is sent to enrolment (FEAT-006 leftover; the spec turns it off again in `afterEach`). axe at 1280 and 375 (tall viewport), light and dark, on Team and each SCR-APP-004 state.

## 6. Acceptance criteria

- **AC-1** (DSH-03 "invite by email, assign role"; AUTH-04; UC-06 1–2) An Owner or Admin invites an address as Admin or Agent; one email is sent (queued and retried if the provider fails) with a single-use link valid for 7 days; the invitation is listed as pending with its role, inviter and expiry, and audited `member.invited` with IDs and the role only.
- **AC-2** (AUTH-04 "bind to the invited email"; UC-06 3, 3a) Opening the link signed in as the invited address and joining creates an active membership with the invited role and opens that tenant; signed in as any other address, accept is refused with 403 `invite_wrong_email` and the invite stays usable; an expired, used or revoked link is refused and shows the matching SCR-APP-004 state; the inviter can resend (a new link; the old one stops working) or revoke.
- **AC-3** (AUTH-04, UC-06 3) Not signed in, the invitee signs in from SCR-APP-004 by magic link (to the invited address only) or Google and lands in the joined tenant without reopening the invite.
- **AC-4** (DSH-03 "assign role, deactivate"; UC-06 4) An Owner or Admin changes an Admin or Agent's role and deactivates or reactivates them; the Owner's row and your own row can't be changed (403/409); each change is audited.
- **AC-5** (DSH-03 "deactivated users lose access immediately"; AUTH-02 p) After a role change or deactivation, the member's sessions on that tenant are revoked: their next API call gets 401 and an open dashboard socket closes; their sessions on other tenants keep working; a deactivated member can't switch back in.
- **AC-6** (D3; APR-02 approver) Only the Owner grants or removes approval rights, only for an active Agent; `Me.canApprove` and `canApprove(…)` are true for Owner, Admin and granted Agents only; a role change clears the grant.
- **AC-7** (AUTH-04 "one person in several tenants; the switcher lists only active memberships"; UC-02 4) `GET /workspaces` lists exactly the user's active memberships; switching to one moves the session there (the top bar, data and socket follow); switching to a tenant without an active membership is 404; a new sign-in opens the last-used workspace.
- **AC-8** (ADR-005; RBAC) `invitations` has forced RLS: tenant B can't read or change A's invitations or members through any route (404) or connection; Agents get 403 on every team route.
- **AC-9** (SCR-APP-045, SCR-APP-004, tenant switcher; NFR-19, NFR-09) Team shows members and invitations with their states (loading, error with Try again, only the Owner, pending, expired, queued, deactivated, read-only for Agents), the invite dialog and confirm dialogs; SCR-APP-004 shows valid, wrong email, expired, used, revoked, joining and error; axe reports no serious or critical issues at 1280 and 375, light and dark.

## 7. Decisions

- **D1 — Invitations live in `identity` and run in the identity zone.** Architecture §5.2 puts invites there, and the team list needs `users.email` and session activity, which only `app_identity` may read. The dashboard zone gains nothing.
- **D2 — The link proves where the invitation went, sign-in proves who opened it.** Accepting needs a session whose email equals the invited one; the invite link alone never signs anyone in, so a forwarded link can't be used by its new holder (AUTH-04's "opened by a different email is rejected").
- **D3 — Admins manage Admins and Agents; only the Owner's row and your own are fixed.** SRS §2.1 gives team management to both. Ownership moves only through FEAT-010's transfer; nobody can lock themselves out.
- **D4 — Sign in to join without a second trip to the invite.** The magic link carries the invitation, so it joins on verify in any browser; Google is a same-browser redirect, so the page keeps the token in `sessionStorage` and finishes the join on return.
- **D5 — A role change or deactivation ends the member's sessions on that tenant** (AUTH-02's criterion, UC-06 4), and a role change clears approval rights. Sessions on other tenants stay: the change is about this tenant.
- **D6 — Sign-in opens the last-used workspace**, replacing FEAT-005 D11; the switcher is the user's choice, as D11 anticipated.
- **D7 — No re-authentication for team actions.** AUTH-03's list doesn't include them; each follows confirm → server acknowledgement → toast. Granting approval rights is the Owner's alone (D3), which is the extra control.
- **D8 — Last write wins on member changes.** Each PATCH changes one field and returns the whole team, so a stale screen corrects itself; a version column isn't worth it for a handful of members.
- **D9 — Invitation addresses are purged 30 days after an invitation ends** (accepted, revoked or expired), by the sweep; audit entries hold the invitation ID only (ADR-014).

## 8. Escalations and open items

- **Not here:** ownership transfer (FEAT-010), display names and the sessions list (FEAT-008), the Approvals nav for Agents without rights and the approval queue itself (FEAT-055 reads `canApprove`), per-user own-stats analytics.
- Seats and plan limits on members are FEAT-062's (plans); no limit is enforced here.
- Sign-out everywhere (FEAT-005) doesn't close open sockets either; the `channels.member` event could serve it later (FEAT-008 sessions list).

## 9. Self-check

- Every DSH-03 and AUTH-04 criterion maps to an AC; AUTH-02's role-change clause → AC-5; D3 → AC-6. UC-06 1, 1a, 2, 3, 3a, 4 covered; 1b was FEAT-006.
- New table: forced RLS, policy, `TENANT_SCOPED_TABLES`, RLS case (AC-8). Tenant ID only from the session or, for accepting, from the invitation row the token selects.
- Audit entries carry IDs and role codes only, no emails (ADR-014). Email sending follows the magic-link retry pattern, not the outbox, as identity mail already does (FEAT-005 §5.3).
- Module boundaries: identity owns everything; api, realtime and scheduler wire it; no model calls; the agent pipeline is unchanged.
- UI uses design.md's `table`/`list`, `status-badge`, `menu`, `tenant-switcher`, `dialog`, `confirm-dialog`, `select`, `toggle`, `toast`, `alert`, `empty-state`; tokens only.

Traceability: DSH-03 → AC-1, AC-4, AC-5, AC-9; AUTH-04 → AC-1, AC-2, AC-3, AC-7; AUTH-02 (p) → AC-5; D3 → AC-6; UC-06 1–2 → AC-1, 3 → AC-2, AC-3, 3a → AC-2, 4 → AC-4, AC-5, 1a → AC-6; UC-02 4 → AC-7; ADR-005 → AC-8; ADR-014 → AC-1, AC-4.
