# Handoff: FEAT-042 — Real-time inbox, conversation view, context sidebar, lifecycle and auto-close
Branch: feat/FEAT-042-inbox · PR: https://github.com/codeforests/kakiagent/pull/44 (ready) · Updated: 2026-10-31 by verify
Stage done: verify (accepted)
Next: Ken's review and squash-merge; then FEAT-043 design — kickoff: "Design FEAT-043. Branch feat/FEAT-043-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- acceptance-report.md: verdict, the 4 added tests, CI fixes F1 (focusable thread region) and F2 (widget-controls reads `?view=closed`).
- For FEAT-043: assignee filter (INB-01), the owner row deleted inside `transition` on close, the takeover bar replaces the dock text (technical-design §8). O2: the thread's implicit `aria-live` may announce older pages.

## Left to CI or later
- None for this feature. GitHub CI run 89 green at `9c20589`.

## Pending for Ken
- Review and merge PR #44. Non-blocking items stay in /mnt/project-files/pending-actions.md (assignee filter → FEAT-043; intent page context unplanned).
