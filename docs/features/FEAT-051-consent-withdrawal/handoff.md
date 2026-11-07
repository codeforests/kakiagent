# Handoff: FEAT-051 — Consent withdrawal in any channel
Branch: feat/FEAT-051-consent-withdrawal · PR: none · Updated: 2026-11-07 by design
Stage done: design
Next: build (backend, T1–T5) — kickoff: "Build FEAT-051 (backend) on branch feat/FEAT-051-consent-withdrawal. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- D1 decided by Ken 2026-11-07: the confirm card offers "Just stop offers" besides "Stop all use" (when offers were agreed).
- A contact's consent state = its latest consent row per purpose (§5.1); withdrawals are new append-only rows, never updates. Re-consent in a later chat makes the lead usable again with no staff action.
- Who is withdrawn comes from the conversation (`contact_id`, else the same `visitor_id`'s contact), never from the message text (D2).
- The handler writes nothing; the widget route `/withdraw` and the dashboard route record it (ADR-025).
- `withdraw_consent` and `data_request` already exist as TaskKinds, in `PHASE`, triage and the fake triager; only handlers are new. Fake triage: "don't contact me" must not also plan `capture_lead`.
- `AlertEvent` + `consent_withdrawn` breaks every `Record<AlertEvent, …>` map (platform templates, dashboard labels): fix them in T2.
- Migration is `0052`; latest on main is `0051`.

## Left to CI or later
- E2E (`consent-withdrawal.e2e.ts`) and screen renders run in the verify stage's GitHub CI.
- Webhook exclusion (LED-06) is FEAT-053's: check `exportable` at send time.

## Pending for Ken
- None.
