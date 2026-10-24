# Handoff: FEAT-018 — Correction queue, stale-fact scan and old-versus-new replay
Branch: feat/FEAT-018-correction-queue · PR: none · Updated: 2026-10-24 by build (backend)
Stage done: build (T1–T6 of 9)
Next: build (UI, T7–T9) — kickoff: "Build FEAT-018 (UI) on branch feat/FEAT-018-correction-queue. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (all `kb.manage`): `GET /api/v1/corrections?status=open|closed&source=&cursor` → `CorrectionList`; `GET /api/v1/corrections/:id` → `CorrectionDetail` (starts a missing replay lazily for an accepted item); `POST …/:id/accept` `{ edit: CorrectionEdit | null }` → `CorrectionAcceptResponse` (replay already started, all turns pending); `POST …/:id/close` `{}` → `CorrectionItemResponse`; `POST …/:id/replay/next` `{}` → `CorrectionReplayNextResponse` (409 `replay_complete` after the last, 404 when the item has no replay, 429 shared `replay:{userId}`); `GET|PUT /api/v1/kb/review-intervals` `{ intervals: ReviewIntervals }` (422 `invalid_body`).
- Contracts in `@kaki/contracts` "corrections" section; `DEFAULT_REVIEW_INTERVALS` is exported. `ReviewSummary` has `openCorrections`, `overdueFacts`; `CorrectionConfirmResponse.replayQuestions` drives the coach card's "See past answers" link.
- An edit's `after` uses the fact view shape (prices as `"13.50"` strings, SG dates), the same as `change.after`; the API maps it through the fact routes' `patchOf`. An edit equal to the proposal is accepted as proposed (`accepted`, no `acceptedChange`). A `reconfirm` item edited with `edit_fact` becomes a fact edit.
- `closedBySystem` is true for a dismissed item with no decider (the scan's auto-close, D8). Deleted facts show `status: 'deleted'`, version 0, with the label the change recorded.
- `apps/dashboard/src/lib/coach.ts` already handles `reconfirm` in `diffRows` (no rows), `changeSubject` and `confirmedLine` so the dashboard typechecks; the UI session may refine these in `lib/corrections.ts`.
- Error codes the screen maps: 409 `correction_closed`, 409 `correction_stale`, 422 `invalid_correction`, 422 `not_editable`, 422 `invalid_query`.
- `testApp` (apps/api/test/support.ts) now takes an optional `rateLimiter`.

## Left to CI or later
- E2E `corrections.e2e.ts` and screen renders: CI only (STATE.md).
- The scheduler-worker now depends on `@kaki/kb` (subpath `@kaki/kb/stale`, allowed in `.dependency-cruiser.cjs`), so `pnpm-lock.yaml` changed: per the CI cadence this feature needs a CI run before merge.

## Pending for Ken
- Nothing blocking.
