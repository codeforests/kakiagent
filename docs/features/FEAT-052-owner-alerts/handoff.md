# Handoff: FEAT-052 — Owner alerts by email, quiet hours, digest, notification preferences
Branch: feat/FEAT-052-owner-alerts · PR: none · Updated: 2026-11-01 by design
Stage done: design
Next: build (backend) — kickoff: "Build FEAT-052 (backend) on branch feat/FEAT-052-owner-alerts.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- No producer exists yet (FEAT-044 escalations, FEAT-055 approvals, FEAT-050 hot leads). Test the pipeline with direct `notify` calls and the test-alert route; don't wire a producer here.
- Alerts are Postgres rows polled every 5 s by the scheduler (D2), not a new SQS queue: copy the shape of identity `sendPendingInvitations` (due-tenant scan via an `identity_lookup` policy, then `withTenant` + `for update skip locked`, `backoffSeconds`).
- Preferences and quiet hours are applied at send time (D3); rows store IDs and codes only, emails carry no visitor data (D12).
- Quiet hours are Singapore time (UTC+8, no DST), stored as minutes; windows may wrap midnight. Inject `now` into the sender for tests.
- `notification_prefs` stores opt-outs (`email_muted`), no row = defaults (D4). PUT keeps unlisted events.
- Migration is `0044_notifications.sql`; FKs go to `memberships (tenant_id, user_id)`.
- Build splits at `## Build session 2 (UI)` in tasks.md (T1–T6 backend, T7–T10 UI).

## Left to CI or later
- E2E (T9) and the Terraform `mail` module's `terraform test` (T6, if no Terraform locally) run in the verify stage's GitHub CI.
- The bounce-rate alarm and DNS records go live at MD (never applied before).

## Pending for Ken
- None blocking. Two choices taken that he may want to see: alerts polled from Postgres rather than a new SQS queue (D2), and the alert sender running in the identity zone like the other account emails (D10).
