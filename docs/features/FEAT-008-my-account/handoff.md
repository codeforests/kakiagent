# Handoff: FEAT-008 — My account: profile, email change, sessions list
Branch: feat/FEAT-008-my-account · PR: none · Updated: 2026-10-31 by build (backend)
Stage done: build (T1–T3 of 8)
Next: build (UI, T4–T8) — kickoff: "Build FEAT-008 (UI) on branch feat/FEAT-008-my-account. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Contracts (`@kaki/contracts`, section "my account"): `Account`, `ProfilePatch`, `DisplayName`, `EmailChangeBody`, `EmailChangeConfirmed`, `DeviceSession`, `DeviceSessionList`. `Me.user.displayName` and `TeamMember.displayName` are now required (nullable); stubs and fixtures need `displayName: null` (`lib/team.test.ts` already has it).
- Routes (all `authFrom`, so they work without a workspace): `GET /api/v1/me/account` → `Account`; `PATCH /api/v1/me/profile` `{ displayName | null }` → 200 `Account` (400 `validation`); `POST /api/v1/me/email-change` `{ email }` → 202 `Account` (403 `reauth_required` with `methods`, 409 `same_email`, 429 `rate_limited`); `DELETE /api/v1/me/email-change` → 204; `GET /api/v1/me/sessions` → `DeviceSessionList`; `DELETE /api/v1/me/sessions/:id` → 204 (404 `not_found`, 409 `current_session`).
- Public `POST /api/v1/email-change/confirm` `{ token }` → 200 `{ email }`; 400 `link_expired` / `link_used` / `link_invalid`; 409 `email_taken`; 429 `rate_limited` (20 per IP per 15 min).
- A taken new address answers 202 exactly like a free one (D5); the UI can't and shouldn't tell them apart.
- The email-change rate limit runs before the re-auth check: a re-auth retry counts as a request too (5 per hour).
- Error messages come with each error body (`message`), as the team routes do; `accountErrorText` can still map codes to the ui-design wording.
- Sign-out, sign-out-everywhere and the devices delete now publish `session_ended` on `channels.session(id)`; `/ws` closes 4401 `session_ended`, which the shell already handles from FEAT-007.

## Left to CI or later
- E2E `account.e2e.ts` and screen renders: GitHub CI in the verify stage (no Docker here).
- `apps/api/test/uploads.int.test.ts` needs LocalStack (Docker) and fails in cloud sessions on main too; not touched.

## Pending for Ken
- None blocking. D3 (re-auth before an email change) is stricter than the SRS; noted in the design reply.
