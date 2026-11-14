# Handoff: FEAT-075 — Inbox redesign
Branch: feat/FEAT-075-inbox-redesign · PR: https://github.com/codeforests/kakiagent/pull/71 (ready) · Updated: 2026-11-14 by verify
Stage done: verify (accepted, after rework 1)
Next: merge on Ken's go-ahead, then M5 design (Ken pauses after FEAT-060 to review existing screens first) — kickoff: "Design FEAT-061. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- `acceptance-report.md` is the verdict; `rework-1.md` is kept as the first verify's history.
- GitHub CI run 138 at `d824488`: all jobs green, E2E in all three browsers.
- RTM Test refs appended: INB-01, INB-04, INB-06 (all partial). `node scripts/check-rtm.mjs FEAT-075 --stage verify` passes.

## Left to CI or later
- Nothing for this feature.

## Pending for Ken
- Merge PR #71 (squash).
- The rework build's local E2E runs added test data to the WSL dev stack (tenant `kaki-bakery`); `pnpm stack:reset` and `pnpm db:setup` restore it if wanted.
