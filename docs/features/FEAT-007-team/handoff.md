# Handoff: FEAT-007 — Team, invitations, roles, approval-rights grants, tenant switcher
Branch: feat/FEAT-007-team · PR: https://github.com/codeforests/kakiagent/pull/42 · Updated: 2026-10-31 by build (UI)
Stage done: build (T1–T10 of 10), status developer-done
Next: verify — kickoff: "Verify FEAT-007 on branch feat/FEAT-007-team. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `pages/team.tsx` + `team-parts.tsx` (SCR-APP-045), `pages/invite.tsx` (SCR-APP-004, `/invite` outside the shell), `shell/tenant-switcher.tsx`; data in `lib/team.ts`, `lib/workspaces.ts`; unit test `lib/team.test.ts`.
- `FormDialog` (`@kaki/ui`) gained an optional `onCloseAutoFocus`, as `ConfirmDialog` has, so focus returns to the row's menu button after a dialog opened from a menu item.
- Small choices inside the ui-design: the rights menu item reads "Give approval rights" / "✓ Remove approval rights" (plain items, the check only when on); "Resend it" in the invite dialog resends straight away; a member who vanished meanwhile (404 on PATCH) closes the dialog and refetches; the switcher's 404 alert sits above the banners in `AppShell`.
- The invite token is read from `#token=`, dropped from the address bar, and kept in `sessionStorage` for the tab (Google return and a two-step detour), cleared on join or an ended state; it only ever goes in request bodies.
- The inbox socket "reconnects" on a switch because the switch goes to `/`, unmounting the inbox; its hook opens a new socket on mount.
- Stub-run evidence for T6–T8 is in `tasks.md` (173 checks, axe clean); the script was a scratch file, not committed.

## Left to CI or later
- E2E: `e2e/tests/team.e2e.ts` (new) and the FEAT-006 leftovers as a new `describe` at the end of `two-step.e2e.ts` (it sets Kaki Bakery's `mfa_required` through the owner DB connection and resets it in `afterEach`). Neither has run yet: no local stack in cloud sessions. `support.ts` `magicLinkFor` gained a `path` argument (`'invite'`).
- `apps/api/test/uploads.int.test.ts` "the S3 presigner" fails without `KAKI_TEST_S3_ENDPOINT`; unrelated, runs in GitHub CI.
- Google sign-in to join (D4) isn't exercised by any test.

## Pending for Ken
- None.
