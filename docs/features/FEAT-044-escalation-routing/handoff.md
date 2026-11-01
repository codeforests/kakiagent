# Handoff: FEAT-044 — Escalation routing, "talk to a person", reminders
Branch: feat/FEAT-044-escalation-routing · PR: none · Updated: 2026-11-01 by design
Stage done: design
Next: build (backend, T1–T5) — kickoff: "Build FEAT-044 (backend) on branch feat/FEAT-044-escalation-routing.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Migration is `0045_escalations.sql` (last on main: 0044). Two new tenant tables, a SECURITY DEFINER `escalation_candidates()` (visitor zone can't read `memberships`, D3), a reminder queue function owned by `kaki_inbox_timer`, and `inbox_queue_auto_close()` replaced to skip `escalated` (D5).
- `inbox` can't import `agent`: the visitor notice texts live in agent `texts.ts` (`escalationNotice`) and are passed into `requestEscalation` as `noticeText`.
- Resolution happens inside `transition` (every move out of `escalated`), which also calls `cancelNotifications` for `escalation` and `escalation_reminder`. Don't add it to each caller.
- Business minutes: new `addBusinessMinutes` in `tenancy/hours.ts`, built on the same spans as `openStatus`.
- D1 (urgency after hours) is on a decision card to Ken; the design applies the recommended default (visitor request urgent only in business hours). If Ken picks "always urgent", change `urgent = source !== 'unverified'` in §5.1 step 3 and AC-4/AC-6's wording; nothing else moves.
- Text changes (disclosure core, `unsure`) will break FEAT-022/023/024 text assertions by design; update those expectations, don't weaken them.
- Seeded member Mei Ling (`agent@kaki-bakery.test`, FEAT-043) is the E2E assignee.

## Left to CI or later
- E2E `escalation.e2e.ts` and screen renders run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken
- D1 decision card (after-hours urgency). Plan row screens gain SCR-APP-045 (p) and SCR-APP-015 (p) (design §8, D2).
