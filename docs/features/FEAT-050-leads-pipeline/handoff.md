# Handoff: FEAT-050 — Leads list, pipeline, scoring and CSV export
Branch: feat/FEAT-050-leads-pipeline · PR: https://github.com/codeforests/kakiagent/pull/56 · Updated: 2026-11-06 by verify
Stage done: verify (accepted), status accepted
Next: Ken's review and squash-merge; then design FEAT-051 — kickoff: "Design FEAT-051. Branch feat/FEAT-051-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- FEAT-051 extends `exportable()` in `packages/leads/src/export.ts` with "no withdrawn consent" (LED-05's last clause) and adds the consent-withdrawn state to SCR-APP-033 (`apps/dashboard/src/pages/lead.tsx`).
- Verify added tests for AC-3 (quiet hours hold the hot-lead alert; a reopen doesn't re-alert) and AC-7 (10,001 leads → 413, no audit).

## Left to CI or later
- `leads.e2e.ts` and `uploads.int` (LocalStack) run in GitHub CI; result in acceptance-report.md §CI.

## Pending for Ken
- Review and merge PR #56.
