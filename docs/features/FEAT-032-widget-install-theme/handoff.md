# Handoff: FEAT-032 — Widget install, theme matching, allowed origins, install check
Branch: feat/FEAT-032-widget-install-theme · PR: https://github.com/codeforests/kakiagent/pull/31 · Updated: 2026-10-25 by verify
Stage done: verify (accepted; E2E, renders and axe pending Ken's local CI)
Next: merge after Ken's local CI is green and he approves; then FEAT-033 design — kickoff: "Design FEAT-033. Branch feat/FEAT-033-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Report: `acceptance-report.md`. One E2E case added (AC-8, a fixed scheme stops following), `77ec16d`.
- RTM Test ref appended for ONB-07, CHN-11, CHN-14, CHN-02 (partial). Design ref for those rows still lacks FEAT-032's design docs (design column; append in a later design session).

## Left to CI or later
- Ken's local CI on this branch: `widget-install.e2e.ts` (4 × 3 browsers), `coach.e2e.ts`, renders, axe; `files.int` and `uploads.int` (LocalStack).
- Lighthouse ≤ 2-point check (CHN-02): M2 close (D1).

## Pending for Ken
- Local CI run on this branch, then approve the squash-merge.
