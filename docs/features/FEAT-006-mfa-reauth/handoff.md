# Handoff: FEAT-006 — Two-step verification and re-authentication
Branch: feat/FEAT-006-mfa-reauth · PR: none · Updated: 2026-10-30 by build (backend)
Stage done: build (T1–T5 of 11)
Next: build (UI) — kickoff: "Build FEAT-006 (UI) on branch feat/FEAT-006-mfa-reauth. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes are live exactly as design §3, in `apps/api/src/mfa.ts`; contracts in `@kaki/contracts` (section "two-step verification and re-auth"): `MfaStatus`, `MfaCode`, `MfaEnrolmentStart`, `MfaEnrolmentConfirm`, `RecoveryCodes`, `ReauthStatus`, `ReauthRequired`, `TeamMfa`, `TeamMfaBody`; `MagicLinkVerifyResponse.next` has `mfa`, `mfa-enrol`, `reauthed`.
- Error bodies: 401 `mfa_required`; 403 `mfa_enrolment_required`; 403 `reauth_required` + `methods`; 400 `code_invalid` (+ `attemptsLeft` on a TOTP challenge or re-auth only); 429 `mfa_locked` + `until`; 429 `too_many_attempts`; 409 `mfa_required_by_workspace` + `workspaces` (names); 409 `use_authenticator`, `mfa_not_enrolled`, `mfa_already_enrolled`; 404 `no_enrolment`; 400 `link_other_session` on verify.
- `/api/v1/me` refuses a pending session (401/403 above), so `routeAuthError` must route those before the shell renders. `GET /auth/mfa` works pending; `GET /auth/reauth` and the reauth POSTs accept `ok` and `enrol` but not `challenge`.
- `POST /auth/mfa/enrolment` needs a fresh re-auth too, so the setup page needs the `ReauthProvider` (ui-design already says so). After `confirm`, the session is fresh and passed.
- A verify with a re-auth token returns `{ next: 'reauthed' }` and sets no cookie; the dialog's tab learns it by polling `GET /auth/reauth`.
- `PUT /api/v1/team/mfa` order of checks: 403 `forbidden` (Admin/Agent) → 403 `reauth_required` → 409 `mfa_not_enrolled` (turning on).
- Build deviation B1 (tasks T1 note): no `identity_read` on `tenants`; `user_mfa_required_by(user)` instead. No UI impact.
- E2E: TOTP for the `totp` helper is RFC 6238 SHA-1/6/30 s; the base32 secret comes from `POST /auth/mfa/enrolment`. A code is refused if its step isn't later than the last accepted one, so wait for the next 30 s step (or use step +1) between two codes of one user.

## Left to CI or later
- `terraform validate` (provider registry blocked here; `fmt -check` passes) and the S3 presigner case of `uploads.int.test.ts` (needs Docker): the verify stage's GitHub CI.
- E2E (`two-step.e2e.ts`), renders and axe: verify stage's GitHub CI (no local stack).
- Google re-prompt for re-auth deferred (D4).

## Pending for Ken
- Nothing blocking. Already in pending-actions: lost authenticator + all recovery codes has no self-service reset until an operator tool exists (design §8 item 2).
