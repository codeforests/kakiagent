# Handoff: FEAT-052 — Owner alerts by email, quiet hours, digest, notification preferences
Branch: feat/FEAT-052-owner-alerts · PR: https://github.com/codeforests/kakiagent/pull/46 · Updated: 2026-11-01 by verify
Stage done: verify (accepted)
Next: Ken's merge, then design FEAT-044 — kickoff: "Design FEAT-044. Branch feat/FEAT-044-<slug> (create it from main).
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- FEAT-044 is the first producer: call `notify(tx, …)` from `@kaki/platform/notifications` for escalations (urgent when the visitor asked for a person) and reminders (a dedupe key per reminder), and `cancelNotifications` on claim or take-over (technical-design §8).
- Links per kind live in `packages/platform/src/notifications/links.ts`.

## Left to CI or later
- NFR-18 goes live at MD (DNS records from the `mail` module outputs, SES identity).

## Pending for Ken
- Merge PR #46 (squash) once CI is green.
