# Handoff: FEAT-007 — Team, invitations, roles, approval-rights grants, tenant switcher
Branch: feat/FEAT-007-team · PR: none · Updated: 2026-10-31 by build (backend)
Stage done: build (T1–T4 of 10)
Next: build (UI, T5–T10) — kickoff: "Build FEAT-007 (UI) on branch feat/FEAT-007-team. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Contracts (end of `packages/contracts/src/index.ts`, section "team, invitations and workspaces"): `TeamResponse`, `TeamMember`, `TeamInvitation`, `InviteBody`, `MemberPatch`, `InvitationTokenBody`, `InvitationLookup`, `Workspace`, `WorkspaceList`, `InvitableRole`. `Me` now has `canApprove` (required: any dashboard fixture building a `Me` needs it); `MagicLinkRequest` has optional `invitation` (the invite token).
- Routes are all in `apps/api/src/team.ts`, exactly as design §3. Error codes and messages: `INVITATION_ERRORS`/`TEAM_ERRORS` there (`inviteErrorText` in the dashboard should key on the same codes). Accept/switch answer `Me`; PATCH answers the whole `TeamResponse`; POST invite and resend answer one `TeamInvitation` with `delivery` `sent` or `queued`.
- `POST /api/v1/invitations/accept` and `/workspaces/:id/switch` allow a session owing enrolment (`enrol`), not one owing the code challenge.
- Google: `GET /api/v1/auth/google/start?next=invite` sets a short cookie; the callback then goes to `/invite` when the result would have been `/` or `/welcome` (two-step still comes first when owed, so `/invite` must read the token back from `sessionStorage`).
- Magic link from SCR-APP-004: POST `{ email, invitation: token }`; a mismatch answers 400 `invite_wrong_email`.
- Socket: on a role change or deactivation the member's `/ws` closes with 4401 `session_ended` (the hook already treats 4401 as signed out).
- Invitation emails link to `{PUBLIC_APP_URL}/invite#token=…`.
- Lookup states: `valid | expired | used | revoked` (a resent invitation's old link reads `revoked`).

## Left to CI or later
- `apps/api/test/uploads.int.test.ts` "the S3 presigner" needs a container runtime and fails in cloud sessions without `KAKI_TEST_S3_ENDPOINT`; unrelated to this feature, runs in GitHub CI.
- E2E (`team.e2e.ts`, two FEAT-006 leftovers in `two-step.e2e.ts`) and real-stack renders run in the verify stage's GitHub CI.
- `code-map.md` update is T10.

## Pending for Ken
- None.
