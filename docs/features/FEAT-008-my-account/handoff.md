# Handoff: FEAT-008 — My account: profile, email change, sessions list
Branch: feat/FEAT-008-my-account · PR: none · Updated: 2026-10-31 by design
Stage done: design
Next: build (backend, T1–T3) — kickoff: "Build FEAT-008 (backend) on branch feat/FEAT-008-my-account. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Everything is identity-zone: `email_changes` is NOT tenant-scoped (no RLS, like `magic_links`); grants to `app_identity` only. Migration is `0041_my_account.sql`.
- `/me/*` routes use `authFrom` (not `sessionFrom`): users without a workspace must reach them. The email-change request alone calls `requireReauth` (D3, stricter than AUTH-03's list).
- Copy the magic-link send/sweep pattern (`magic-link.ts` `sendMagicLink`, `sendPendingMagicLinks`) for `email_changes`; one row carries two emails (`sent_at` for the new address, `notice_sent_at` for the old).
- `auditUserEvent` moves from `mfa.ts` to `audit-user.ts` unchanged; payload `{}` (no names, no emails).
- `revokeAllSessions` changes its return from a count to the revoked IDs; check its callers.
- Confirm must delete unconsumed `sign_in` magic links for the old address (otherwise `consumeMagicLink` → `findOrCreateUser` makes a new user with it) and clear `google_sub`.
- `channels.session(id)` (`s:{id}`) is new in platform pubsub; `/ws` closes 4401 `session_ended` on it, same handler as `channels.member`.
- UI session: `/verify-email` is in `AuthLayout` outside the shell, like `/invite` (`pages/invite.tsx` is the pattern for the fragment token).

## Left to CI or later
- E2E `account.e2e.ts` and screen renders: GitHub CI in the verify stage (no Docker here).

## Pending for Ken
- None blocking. D3 (re-auth before an email change) is stricter than the SRS; noted in the reply.
