# Handoff: FEAT-008 — My account: profile, email change, sessions list
Branch: feat/FEAT-008-my-account · PR: https://github.com/codeforests/kakiagent/pull/43 (draft) · Updated: 2026-10-31 by build (UI)
Stage done: build (T1–T8 of 8), status developer-done
Next: verify — kickoff: "Verify FEAT-008 on branch feat/FEAT-008-my-account. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- New screens: `pages/account-parts.tsx` (Profile, Email, Devices cards), `pages/verify-email.tsx` (`/verify-email`, outside the shell), names in `shell/account-menu.tsx` and the Team row (`memberName`, `initialOf` in `lib/team.ts`).
- `/verify-email` renders one `AuthLayout` for every state, so its `h1` takes focus when the state changes (separate components would remount and skip the focus).
- `useSignedIn` (`lib/account.ts`) asks `/me` without the global 401 routing, so a signed-out visitor sees "Sign in" instead of being redirected.
- FEAT-006's two-step loading skeleton was a `div` with `aria-label` (axe `aria-prohibited-attr`); it is a `section` now.
- E2E `e2e/tests/account.e2e.ts` creates a fresh user and workspace through the API; `support.ts` gains `emailWithSubject` and `magicLinkFor(…, 'verify-email')`. The expired, taken and error states of `/verify-email` are stubbed with `page.route`.
- A revoked device's next load may land on `/sign-in` or `/session-expired`; the spec accepts either. Check which one the shell shows and whether the ui-design ("shows sign-in") wants it pinned.

## Left to CI or later
- E2E (three browsers) and screen renders: GitHub CI in verify. Not run here (no Docker).
- `apps/api/test/uploads.int.test.ts` needs LocalStack and fails in cloud sessions on main too.

## Pending for Ken
- None blocking. D3 (re-auth before an email change) is stricter than the SRS; noted in the design reply.
