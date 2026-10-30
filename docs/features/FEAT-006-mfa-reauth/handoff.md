# Handoff: FEAT-006 — Two-step verification and re-authentication
Branch: feat/FEAT-006-mfa-reauth · PR: https://github.com/codeforests/kakiagent/pull/38 (draft) · Updated: 2026-10-30 by build (UI)
Stage done: build (T1–T11 of 11), status `developer-done`
Next: verify — kickoff: "Verify FEAT-006 on branch feat/FEAT-006-mfa-reauth. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Dashboard: `/two-step` (`pages/two-step.tsx`), `/two-step/setup` (`pages/two-step-setup.tsx`, inside its own `ReauthProvider`), `/account` (`pages/account.tsx`), `/settings/team` (`pages/team.tsx`); shared parts in `pages/two-step-parts.tsx`; `/auth/verify` handles `mfa`, `mfa-enrol`, `reauthed` and `link_other_session`.
- Guard: `lib/reauth.ts` (`makeGuard`, `useReauthGuard`, `ReauthCancelled`); `ReauthProvider` and the dialog are in `shell/reauth-dialog.tsx` (build note B2: lib can't import shell). `AppShell` is wrapped in the provider.
- Routing: `main.tsx` sends 401 `mfa_required` to `/two-step?next=…` and 403 `mfa_enrolment_required` to `/two-step/setup?next=…`; both count as auth errors (no retry).
- `uqr` 0.1.3 is a dashboard dependency, imported dynamically by `QrCode` (own chunk; main chunk has no `renderSVG`).
- E2E `e2e/tests/two-step.e2e.ts`: a fresh Owner per run; it sets `sessions.reauth_at` back 11 minutes through the owner DB connection to make re-auth stale, and runs the TOTP "Require" re-auth before the lock (order differs from design §5.6 for that reason). `totp(secret, step)` in `support.ts` matches `@kaki/identity` `totpAt`.
- Dashboard has no `test:coverage` script (as before this feature); its unit tests run in `pnpm test`.

## Left to CI or later
- E2E on Chromium, Firefox and WebKit, real renders and axe against the stack: verify stage's GitHub CI. A throwaway Chromium smoke against `vite preview` with a stubbed API passed every screen state here (axe clean, 375 px).
- Not in the E2E: the forced-enrolment variant (needs a second member, FEAT-007) and Team read-only for Admin/Agent; covered by the smoke only.
- Still from the backend session: `terraform validate` and the S3 presigner case of `uploads.int.test.ts` (Docker).

## Pending for Ken
- Nothing blocking. Already in pending-actions: lost authenticator + all recovery codes has no self-service reset until an operator tool exists (design §8 item 2).
