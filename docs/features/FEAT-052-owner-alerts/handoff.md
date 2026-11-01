# Handoff: FEAT-052 — Owner alerts by email, quiet hours, digest, notification preferences
Branch: feat/FEAT-052-owner-alerts · PR: see the draft PR for this branch · Updated: 2026-11-01 by build (UI)
Stage done: build (T1–T10 of 10), status developer-done
Next: verify — kickoff: "Verify FEAT-052 on branch feat/FEAT-052-owner-alerts.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `apps/dashboard/src/pages/notifications.tsx` (SCR-APP-056 at `/account/notifications`), data and pure helpers in `lib/notifications.ts` (+ `lib/notifications.test.ts`), three calls in `lib/api.ts`, route in `router.tsx`, "Notifications" in `shell/account-menu.tsx` (prop `workspace`, set by `app-shell.tsx`), `NotificationsCard` at the end of `pages/account.tsx`, styles under "My notifications" at the end of `app.css`.
- Each switch is its own `useSaveNotificationPrefs` instance: optimistic, the PUT body is the whole cache after the change, and a failure undoes only that change (so a second switch saved meanwhile keeps its position). Busy switches stay focusable and ignore presses (`aria-busy`), rather than `disabled`, so focus stays on them.
- `quietHelp` follows ui-design literally: overnight "Overnight, 22:00 to 08:00. Singapore time. …", daytime "Singapore time. …". `quietSummary` (tech design §5.5) is exported but not shown on the page.
- The quiet-hours switch saves the saved times, never unsaved drafts. Client validation catches same-time before the PUT; the server's 422 maps to the same field errors (`quietServerError`).
- The 429 warning has no live role (ui-design); the test card's danger alert has `role="alert"`.
- Backend notes from the backend session still hold: routes, error codes, the digest give-up deviation (`DIGEST_MAX_ATTEMPTS`), the new dependency-cruiser entry point.

## Left to CI or later
- T9 E2E (`e2e/tests/notifications.e2e.ts`, needs Mailpit and the scheduler sweep) and axe run in the verify stage's GitHub CI. Its `afterEach` restores the bakery Owner's defaults through the API.
- Locally excluded from coverage for lack of Docker: platform `test/rate-limit.int.test.ts`, api `test/uploads.int.test.ts` (not touched by this feature).
- tflint for the `mail` module runs in CI's terraform job. DNS records and the bounce alarm go live at MD.

## Pending for Ken
- None blocking.
