# Handoff: FEAT-052 — Owner alerts by email, quiet hours, digest, notification preferences
Branch: feat/FEAT-052-owner-alerts · PR: none · Updated: 2026-11-01 by build (backend)
Stage done: build (T1–T6 of 10)
Next: build (UI) — kickoff: "Build FEAT-052 (UI) on branch feat/FEAT-052-owner-alerts.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (apps/api/src/notifications.ts, workspace session): `GET /api/v1/me/notifications` → `NotificationPrefs`; `PUT` same path with `NotificationPrefsBody` → `NotificationPrefs`; `POST /api/v1/me/notifications/test` → 202 `TestAlertResult`.
- Errors: 422 `invalid_preferences` with `fields` (`quietHours.end: 'same_time'`, `events: 'duplicate_event'`, else `invalid`); 403 `forbidden` when a member who can't approve sends `approval_pending`; 429 `rate_limited` with `retryAfterSeconds: 60` (contract `RateLimitedError`).
- Contracts (end of packages/contracts/src/index.ts): `AlertEvent`, `NotificationChannel`, `ClockTime`, `QuietHours`, `EventPref`, `NotificationPrefs`, `NotificationPrefsBody`, `TestAlertResult`, `RateLimitedError`.
- `events` in the GET response already omits `approval_pending` for members who can't approve (D9); the page renders what it gets. PUT may send only changed events; unlisted ones keep their setting.
- Quiet hours are "HH:MM" strings in the API (Singapore time); the DB stores minutes.
- The test alert is urgent and ignores mutes and quiet hours; with the stack up it reaches Mailpit within one 5 s scheduler tick (`NOTIFY_SWEEP_MS`).
- Deviation: a digest whose send keeps failing gives up after `DIGEST_MAX_ATTEMPTS` (the attempts whose backoff adds up to 24 h), not 24 h after creation, since held rows are hours old when the digest falls due. Single alerts use the design's 24 h from `created_at`.
- `.dependency-cruiser.cjs` now lists `platform/src/notifications/index.ts` as a declared entry point.

## Left to CI or later
- T9 E2E and screen renders run in the verify stage's GitHub CI. tflint for the new `mail` module runs in CI's terraform job (fmt, validate and `terraform test` passed here, see tasks.md T6).
- The bounce-rate alarm and DNS records go live at MD.

## Pending for Ken
- None blocking.
