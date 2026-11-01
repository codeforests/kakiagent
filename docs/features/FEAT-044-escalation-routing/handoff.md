# Handoff: FEAT-044 — Escalation routing, "talk to a person", reminders
Branch: feat/FEAT-044-escalation-routing · PR: https://github.com/codeforests/kakiagent/pull/48 · Updated: 2026-11-01 by verify
Stage done: verify (accepted)
Next: Ken's merge, then FEAT-045 design — kickoff: "Design FEAT-045. Branch feat/FEAT-045-<slug> (create it from main).
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- `requestEscalation` (inbox) is the one path for escalations; FEAT-055's approval SLA adds a source, not a second path (§8).
- FEAT-049 adds the lead offer to the after-hours escalation notice (AGT-09, CHN-13).
- Telegram (FEAT-037) and web push (FEAT-048) are new senders for the same `escalation` / `escalation_reminder` notifications.

## Left to CI or later
- E2E and screen renders ran in GitHub CI (acceptance-report.md, CI).

## Pending for Ken
- Merge approval for PR #48.
- Notes (not blocking, in pending-actions.md): abuse rule ends only `ai` chats; D5 vs INB-08's widget auto-close.
