# Handoff: FEAT-018 — Correction queue, stale-fact scan and old-versus-new replay
Branch: feat/FEAT-018-correction-queue · PR: PR_LINK · Updated: 2026-10-24 by build (UI)
Stage done: build (T1–T9 of 9), status developer-done
Next: verify — kickoff: "Verify FEAT-018 on branch feat/FEAT-018-correction-queue. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Screens: `pages/corrections.tsx` (SCR-APP-021, with the intervals dialog opened by `?intervals=1`), `pages/correction.tsx` (SCR-APP-022), shared `pages/answer-compare.tsx` (FEAT-028's `answer-compare`, moved; `replay.tsx` now wraps it). Display rules in `lib/corrections.ts` with `lib/corrections.test.ts`.
- `driveReplay` in `lib/replay.ts` is generic over the `…/next` response, so both replays use it; `lib/replay.test.ts` is unchanged and passes.
- The Review nav pill counts facts + conflicted + open corrections and now reads "items to review"; `review.e2e.ts` line 64 was changed to match that text (same assertion strength). The Corrections tab has its own count pill.
- The coach confirm card's "See {n} past answers" link comes from the confirm response only, so it doesn't survive a reload of the coach chat (no field on the stored message).
- The closed banner shows the decision and its time, not the decider's name: `CorrectionItem` has no decider name (ui-design said "Closed by {name}").
- The "Was" captions in the edit dialog are one line per changed field above the fields, not one under each field label.
- A re-confirm item's "Edit fact" loads the fact (`GET /kb/facts/:id`) for its current value, since the change carries none.

## Left to CI or later
- E2E `corrections.e2e.ts` (and the changed `review.e2e.ts` line) and all screen renders and axe checks: CI only. The spec uses the owner connection to age the fact and call `kb_stale_scan()`.
- `pnpm-lock.yaml` changed (scheduler-worker → `@kaki/kb`), so per the CI cadence this feature needs a CI run before merge.

## Pending for Ken
- Nothing blocking.
