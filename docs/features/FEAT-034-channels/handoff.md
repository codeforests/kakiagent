# Handoff: FEAT-034 — Channel framework: adapter contract, go-live and go-offline per channel, health and degraded alerts
Branch: feat/FEAT-034-channels · PR: https://github.com/codeforests/kakiagent/pull/36 · Updated: 2026-10-27 by verify
Stage done: verify (accepted; E2E pending Ken's local CI)
Next: Ken's local CI on this branch, then merge on his go; then FEAT-057 — kickoff: "Design FEAT-057. Branch feat/FEAT-057-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Report: `acceptance-report.md`. One test strengthened: agent not-live case now asserts no retrieval (embed count 0).
- FEAT-057 adds the "AI paused" banner to `shell/banners.tsx` (slot above the degraded banner) and the paused state of SCR-WGT-005 (same panel view as not live).
- A fresh session needs `pnpm tokens` before the channels, widget, dashboard and api suites can import `@kaki/design-tokens`.

## Left to CI or later
- E2E `e2e/tests/channels.e2e.ts` (2 tests, axe light/dark) and screen renders: Ken's local CI (due: widget, lockfile, new E2E).
- api `uploads.int.test.ts` S3 presigner: needs an S3 endpoint (same on main).

## Pending for Ken
- Run local CI on `feat/FEAT-034-channels` and paste the summary; then approve the squash-merge.
