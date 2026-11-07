# Handoff: FEAT-051 — Consent withdrawal in any channel
Branch: feat/FEAT-051-consent-withdrawal · PR: none · Updated: 2026-11-07 by build (backend)
Stage done: build (T1–T5 of 8)
Next: build (UI, T6–T8) — kickoff: "Build FEAT-051 (UI) on branch feat/FEAT-051-consent-withdrawal. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Widget: `POST /widget/v1/conversations/:id/withdraw` body `WithdrawBody` `{ messageId, scope: 'all'|'marketing' }` → 201 `WithdrawResponse` `{ status: 'withdrawn'|'already_withdrawn'|'nothing_held', notice }` (notice only on `withdrawn`, `noticeKind: 'consent_withdrawn'`); 404 not this conversation's withdraw card or not the visitor's; 422 `scope_not_offered`; 400 extra fields. The card is `MessageCard` `{ kind: 'withdraw', offers }` on the agent message.
- Dashboard: `POST /api/v1/leads/:id/withdraw` body `LeadWithdrawBody` `{ scope }` → 200 `LeadDetail` (idempotent); 403 Agent; 404 other tenant; 422 `scope_not_offered` (marketing with no offers agreed). GET detail now names recorders.
- Contracts: `LeadRow.consentWithdrawnAt`, `LeadMarketing.withdrawn`, `LeadConsentRecord` (`decision` `withdrawn`, `channel` `dashboard`, `wording` nullable, `recordedBy` name), `LeadSummary.consent.withdrawnAt` and (deviation, for ui-design's sidebar "Offers: stopped") `LeadSummary.consent.marketing.withdrawn`, `ThreadMessage.card` `withdraw`, `VisitorsWouldGet` `withdraw`, `AlertEvent` `consent_withdrawn`.
- Already in the dashboard (to keep typecheck green): `lib/notifications.ts` toggle text (ui-design SCR-APP-056, done), `lib/inbox.ts` `cardCaption('withdraw')`, `lib/coach.ts` `withdraw` explainer text (not in ui-design; reword if wanted), `pages/lead.tsx` `CONSENT_TEXT` withdrawn entries and the wording guard. T7 still adds the channel line ("Recorded by {name}" / "See conversation"), alert, dialog, chip, export note, sidebar line.
- The escalation labels in `lib/inbox.ts` (`e.source === 'unverified' ? …`, two places) read `data_request` as "visitor asked for a person"; add a label ("asked about their personal data") in T7.
- Widget: `LeadMessageCard` is now consent | lead_form only and `panel.tsx` renders `LeadCard` for those two; T6 adds `WithdrawCard`. `activeCard` already treats a withdraw card as open (any non-quote card).
- Deviations from the design: the per-contact lock is `pg_advisory_xact_lock` (the dashboard zone has no UPDATE on contacts for `for update`); the turn's `consentGiven` also needs a `consentId` newer than the withdrawal; a `data_request` escalation stores no "asked the team" notice (its own fixed reply says so); the withdraw card is attached even without a saved purpose statement.

## Left to CI or later
- E2E (`consent-withdrawal.e2e.ts`, T8) and screen renders in the verify stage's CI.
- `apps/api/test/escalation.int.test.ts` "after hours" fails on 2026-11-07 regardless of FEAT-051: with the Deepavali holiday the next opening is "on Tue 10 Nov", and the notice reads "reply from on Tue 10 Nov" (pre-existing wording bug in the escalation notice). `uploads.int` needs an S3 endpoint locally.

## Pending for Ken
- None blocking. Noted in pending-actions: the "reply from on …" escalation-notice wording bug.
