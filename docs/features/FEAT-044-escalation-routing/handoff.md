# Handoff: FEAT-044 — Escalation routing, "talk to a person", reminders
Branch: feat/FEAT-044-escalation-routing · PR: https://github.com/codeforests/kakiagent/pull/48 (draft) · Updated: 2026-11-01 by verify
Stage done: verify (rework: R1)
Next: build (rework R1) — kickoff: "Build FEAT-044 (rework R1) on branch feat/FEAT-044-escalation-routing.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build; the task is acceptance-report.md R1."

## What the next stage needs
- R1 (acceptance-report.md, Findings): on Chromium only, the visitor never shows "Mei Ling joined the chat." after a take-over of a conversation started by Talk to a person (`escalation.e2e.ts:159-161`; 2/2 fails in CI run 95; Firefox and WebKit pass). FEAT-043's take-over E2E passes on Chromium. Suspect the widget's SSE for a conversation created by `talkToPerson` (`panel.tsx`). The trace is in run 41277552542's `playwright-chromium` artifact (the cloud session can't download artifacts; ask Ken for error-context.md if needed, or add diagnostics).
- Fix the product, not the test. Then re-run GitHub CI (`ci.yml` dispatch on this branch) and hand back to verify.
- Already done by verify: the E2E setup correction `23975a8`; report, pending-actions notes. On acceptance, verify writes the RTM, STATE and tasks status.

## Left to CI or later
- Chromium E2E (R1). Everything else is green in run 95.

## Pending for Ken
- Rework needs Ken's go to start the build thread (feature-stage: a rework verdict waits for him).
