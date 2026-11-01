# Handoff: FEAT-044 — Escalation routing, "talk to a person", reminders
Branch: feat/FEAT-044-escalation-routing · PR: https://github.com/codeforests/kakiagent/pull/48 (draft) · Updated: 2026-11-01 by build (UI)
Stage done: build (T1–T9 of 9), status developer-done
Next: verify — kickoff: "Verify FEAT-044 on branch feat/FEAT-044-escalation-routing.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Widget: `escalationPending` (chat.ts), `menuItems(..., { handover })` hides Talk to a person while asking, pending or staff-handled; `api.escalate`; panel `talkToPerson()` creates the conversation first; transient "Asking the team…" row (`.notice.asking`, role=status), failed row `.error.retry` with Retry; 409 shows the ended card. Focus returns to the menu button even when it unmounts for a render (focusNext waits for it).
- Dashboard: `lib/inbox.ts` `waitingFor`, `escalationText`, `escalationStrip`, `keepAssigneeName` (used in `applySummary`), `matchesView` holder = owner else escalation assignee, `eventText` for `escalated`. Strip in `takeover-dock.tsx` `TakeoverBar` (`data-testid="escalation-strip"`), `UrgentChip`, row line `conversation-escalation`; list wait times tick every minute. Team card `pages/escalation-card.tsx`, helpers `lib/escalation.ts`; shown to everyone, editable for Owner/Admin.
- Realtime: the open thread refetches when the escalation id, assignee or reminder count changes.
- **Test change by requirement, not weakening:** `e2e/tests/widget-controls.e2e.ts` expected no menu button before a conversation and one privacy item; with CHN-13 (Talk to a person always shown while live) the menu now starts with Talk to a person, so those steps were updated (ArrowDown/ArrowUp to reach End chat / Privacy, count 2).
- `escalation.e2e.ts` turns Mei Ling's quiet hours off for the run (an after-hours alert is not urgent and would be held for the digest) and restores the seeded prefs; routing reset to round-robin in `afterEach`.
- Stubbed-API Playwright checks run here: Team card save/validation/toast/phone width, inbox row + Urgent chip + strip + divider, widget Talk to a person (ok, failed → Retry, menu hides, notice once).

## Left to CI or later
- E2E (`escalation.e2e.ts`, changed `widget-controls.e2e.ts` and `assistant.e2e.ts`) and screen renders: verify stage's GitHub CI.
- `apps/api` uploads and `@kaki/platform` rate-limit integration tests need LocalStack/Valkey (no Docker here).
- Abuse rule still ends only `ai` chats (see backend note); worth a line in the acceptance report.

## Pending for Ken
- None blocking.
