# Handoff: FEAT-007 — Team, invitations, roles, approval-rights grants, tenant switcher
Branch: feat/FEAT-007-team · PR: none · Updated: 2026-10-31 by design
Stage done: design
Next: build (backend, T1–T4) — kickoff: "Build FEAT-007 (backend) on branch feat/FEAT-007-team. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Everything runs in the **identity zone** (D1): team routes use `withTenant(identityDb, s.tenantId, …)`, because only `app_identity` reads `users`, `sessions`, `mfa_factors`. `app_dashboard` gets no new grants.
- Migration is `0040_team.sql` (last was 0039). The switcher needs tenant names across tenants: `user_workspaces()` SECURITY DEFINER owned by NOLOGIN `kaki_workspaces`, copying 0037's `user_mfa_required_by` pattern.
- Invitation email copies the magic-link send/retry pattern (`sendMagicLink`, `sendPendingMagicLinks`), not the outbox. Token = HMAC(`MAGIC_LINK_SECRET`, `invite:{id}`); resend = revoke + new row (new id → new token).
- Accept requires a session whose email equals the invitation's (D2). Magic link can carry `invitation_id` and joins on verify (D4); Google keeps the token in `sessionStorage` on the page and returns to `/invite` via `google/start?next=invite`.
- Role change and deactivation revoke the member's sessions **on that tenant only**, then publish `session_ended` on the new `channels.member(tenantId, userId)`; `/ws` closes 4401 on it (D5).
- `startSession` gains `preferTenant?` and the last-used rule (D6) — FEAT-005 tests that assume "earliest membership" may need the new rule's expectation only where a user has two memberships.
- `Me` gains `canApprove`; `MagicLinkRequest` gains optional `invitation`. Update existing contract tests and the dashboard's `Me` fixtures that parse it.
- No seed changes: E2E creates members by invitation with unique addresses so other specs' member counts don't move.

## Left to CI or later
- E2E (`team.e2e.ts`, two FEAT-006 leftovers in `two-step.e2e.ts`) and real-stack renders run in the verify stage's GitHub CI.

## Pending for Ken
- None.
