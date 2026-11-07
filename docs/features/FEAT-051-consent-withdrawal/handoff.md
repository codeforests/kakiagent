# Handoff: FEAT-051 — Consent withdrawal in any channel
Branch: feat/FEAT-051-consent-withdrawal · PR: https://github.com/codeforests/kakiagent/pull/57 · Updated: 2026-11-07 by verify
Stage done: verify (accepted)
Next: Ken reviews and merges PR #57; then M3 close (`pipeline-verify` and demo).

## What the next stage needs
- Acceptance report: `acceptance-report.md` (AC-4 test corrected in `db30a9c`).
- FEAT-053 must call `exportable()` (`leads/export.ts`) when a webhook sends, not when it enqueues (LED-06).
- FEAT-061 replaces `dataRequestHandler.run` (escalation) with opening a data-subject request (GOV-05, UC-28 2a).
- FEAT-037 and later channels render the `withdraw` card their own way (ADR-011).

## Left to CI or later
- E2E `consent-withdrawal.e2e.ts` and axe: GitHub CI (report's CI section).
- F1 (FEAT-044 "reply from on …") fixed in this PR, `f703f99` (Ken, 2026-11-07).

## Pending for Ken
- Merge PR #57 once CI is green.
