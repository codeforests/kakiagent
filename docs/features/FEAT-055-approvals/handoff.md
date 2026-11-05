# Handoff: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry
Branch: feat/FEAT-055-approvals · PR: none · Updated: 2026-11-05 by design
Stage done: design
Next: build (backend, T1–T6) — kickoff: "Build FEAT-055 (backend) on branch feat/FEAT-055-approvals. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Split: backend T1–T6, then `## Build session 2 (UI)` T7–T11 (widget quote card, queue, detail, rules SLA, sidebar, E2E, verify).
- D1 (discount above the maximum → approval, flagged `aboveMax`) follows the recommended option of Ken's decision card. If Ken picks "refuse", only T3 (`commitmentDecision` keeps `refuse`) and T4 (handler refused `boundary`, fixed decline text) change; see design D1.
- Quotes are built in code (D2): `draftLines` matches triage `items` to this turn's retrieved product facts; no extra model call. FEAT-054's always-on discount guard stays.
- Timers follow 0045's pattern (D10): due columns + `approvals_queue_due()` owned by NOLOGIN `kaki_approvals_timer`, outbox `conversation-turns` job `approval_timer`, re-checked `pending` in the worker.
- Inbox must not import approvals: `handBack` takes a `hasPendingApproval` callback; the api fills `ContextSidebar.approval`.
- New edge `human → waiting_approval` (D5); auto-close skips `waiting_approval` (D6) — check FEAT-042/043 lifecycle tests that enumerate edges.
- Migration number 0049 (latest on main is 0048).

## Left to CI or later
- E2E (T10) and screen renders run in the verify stage's GitHub CI (no Docker here).
- Signed links FEAT-056; analytics FEAT-066; non-widget delivery FEAT-036+.

## Pending for Ken
- D1 decision card (discount above the maximum: approval vs refuse). Build can start on the recommended option.
