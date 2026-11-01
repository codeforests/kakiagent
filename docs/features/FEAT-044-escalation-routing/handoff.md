# Handoff: FEAT-044 — Escalation routing, "talk to a person", reminders
Branch: feat/FEAT-044-escalation-routing · PR: https://github.com/codeforests/kakiagent/pull/48 (draft) · Updated: 2026-11-01 by build (rework R1)
Stage done: build (rework R1)
Next: verify — kickoff: "Verify FEAT-044 on branch feat/FEAT-044-escalation-routing.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify; re-check R1 (acceptance-report.md) against the rework CI run."

## What the next stage needs
- R1 cause: not the SSE. Escape pressed right after clicking the menu button reached the panel's Escape-to-close, because the first menu item takes focus only after paint (Preact `useEffect`) and the menu's Escape handler sat on the `ul`. On Chromium the dialog closed, so the joined notice was "not found". Fix: `panel.tsx` HeaderMenu handles Escape on its wrapper whenever open. tasks.md has the rework note.
- Also: the mount's `lang` now updates in `useLayoutEffect` (the `widget-controls.e2e.ts:124` Chromium flake, same frame lag).
- New regression step in `widget-controls.e2e.ts` (Escape with the menu open and focus on the button keeps the panel open).
- The rework CI run number and result are in the PR thread / below once green.

## Left to CI or later
- E2E on all three browsers in the rework CI run.

## Pending for Ken
- None new. Earlier notes (D5 vs INB-08, abuse rule in escalated chats) stay in pending-actions.
