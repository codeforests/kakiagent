# Handoff: FEAT-034 — Channel framework: adapter contract, go-live and go-offline per channel, health and degraded alerts
Branch: feat/FEAT-034-channels · PR: https://github.com/codeforests/kakiagent/pull/36 · Updated: 2026-10-27 by verify
Stage done: verify (accepted; GitHub CI green at 2d203b6, 2026-10-28)
Next: merge on Ken's go; then FEAT-057 — kickoff: "Design FEAT-057. Branch feat/FEAT-057-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Report: `acceptance-report.md`. One test strengthened: agent not-live case now asserts no retrieval (embed count 0).
- FEAT-057 adds the "AI paused" banner to `shell/banners.tsx` (slot above the degraded banner) and the paused state of SCR-WGT-005 (same panel view as not live).
- A fresh session needs `pnpm tokens` before the channels, widget, dashboard and api suites can import `@kaki/design-tokens`.

## Left to CI or later
- api `uploads.int.test.ts` S3 presigner: needs an S3 endpoint (same on main).

## Pending for Ken
- Approve the squash-merge of PR #36.
