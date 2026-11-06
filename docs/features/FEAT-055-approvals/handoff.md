# Handoff: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry
Branch: feat/FEAT-055-approvals · PR: https://github.com/codeforests/kakiagent/pull/54 (draft) · Updated: 2026-11-06 by build (UI, T7–T11)
Stage done: build (T1–T11 of 11; developer-done)
Next: verify — kickoff: "Verify FEAT-055 on branch feat/FEAT-055-approvals. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Read the "Note (build)" lines in `tasks.md` (T7–T11 for the UI); Verification evidence has one bullet per AC.
- Deviations from ui-design to judge (all noted in tasks.md):
  - SCR-APP-017 rows are a stacked list at every width (as Corrections), not a table ≥ 768.
  - Decided rows don't name the decider ("by Mei Ling · 2:31 pm"): `ApprovalSummary` has no decider; the detail page does.
  - "Above your maximum" chip without the percentage (the summary has no `maxDiscountPct`).
  - The inbox thread shows the quote message's text with "Sent after approval", not the card (`ThreadMessage.card` is the kind only).
  - D3 auto quotes get the divider "Assistant sent a quote within your rules" (not in ui-design).
- "Approve and send" is disabled for an empty draft (no lines, no note): the owner edits first. The E2E relies on this (the dev tenant has no product facts).

## Left to CI or later
- E2E `e2e/tests/approvals.e2e.ts` (2 tests, serial) and all screen renders: verify stage's GitHub CI. It typechecks; stubbed Chromium runs of the widget card and the dashboard pages passed here.
- Integration suites were last run by the backend session; `apps/api` `uploads.int` needs LocalStack (CI only).
- Pre-existing date flake (not FEAT-055): tenancy `profile.int` fails on 5–6 Nov 2026 (Deepavali); passes from 7 Nov.

## Pending for Ken
- None.
