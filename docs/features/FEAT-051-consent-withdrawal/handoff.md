# Handoff: FEAT-051 — Consent withdrawal in any channel
Branch: feat/FEAT-051-consent-withdrawal · PR: (draft, see thread) · Updated: 2026-11-07 by build (UI)
Stage done: build (T1–T8 of 8), status developer-done
Next: verify — kickoff: "Verify FEAT-051 on branch feat/FEAT-051-consent-withdrawal. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Widget: `WithdrawCard` (`cards.tsx`) over `withdrawChoices`/`withdrawStateOf`/`withdrawLine` (`chat.ts`); `api.withdraw`. `activeCard` now also closes on a `consent_withdrawn` notice; the panel gives that notice `data-notice` so focus moves to it. Reloading the chat after an answer shows the card as "Not answered" (same as FEAT-049's consent card; no answered state is stored on the card).
- Dashboard: alert, `ConsentEntry` channel text (`consentWhere`), `RecordWithdrawalDialog` and `WithdrawnChip` (`leads-parts.tsx`), sidebar line (`leadLines().withdrawn`), `data_request` escalation labels, an `alert` glyph. The list chip sits in the Status cell (the list has no marketing column to replace).
- Stubbed Playwright checks for both (tasks.md T6/T7 evidence) passed; scripts were scratch only.
- E2E `consent-withdrawal.e2e.ts` checks the export exclusion through `page.request.post('/api/v1/leads/export')` right after sign-in (fresh re-auth), not the download dialog.
- Deviations from the backend handoff still stand (advisory lock; `consentId` newer than the withdrawal; no "asked the team" notice for `data_request`; card even without a purpose statement).

## Left to CI or later
- `consent-withdrawal.e2e.ts` and all E2E/axe runs: verify stage's GitHub CI (no local stack here).
- `apps/api/test/escalation.int.test.ts` "after hours" fails on 2026-11-07 regardless of FEAT-051 (Deepavali; "reply from on Tue 10 Nov" wording bug, in pending-actions). `uploads.int` needs S3 locally.

## Pending for Ken
- None blocking.
