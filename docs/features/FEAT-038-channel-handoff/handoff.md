# Handoff: FEAT-038 — Continue on another channel with the history
Branch: feat/FEAT-038-channel-handoff · PR: https://github.com/codeforests/kakiagent/pull/64 (draft) · Updated: 2026-11-11 by build (UI)
Stage done: build (T1–T12 of 12; developer-done)
Next: verify — kickoff: "Verify FEAT-038 on branch feat/FEAT-038-channel-handoff.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Backend deviations are in code-map.md (definer `conversation_move_channel()`, email job on `conversation-turns`, `moved` via the stored `handoff_moved` notice's card and 409 `moved`).
- Widget (T9): `HandoffCard` (cards.tsx) serves the stored `handoff` card and the menu's local one; the moved bar replaces the composer (panel.tsx) from `movedView` (the stored notice, else a 409 `moved` → `MovedError`); `withMessage` drops `handoff_recap`. The masked address holds `***`, so `handoffSent` fills `{to}` after the `**` bold split (`boldParts`); the stubbed check caught it.
- Widget has no conversation resume across reloads (no stored conversation ID), so AC-8's "reopening the widget shows the history and the moved state" is only the in-session case; the E2E covers the live move without reload. Worth a look in verify.
- Dashboard (T10): `eventText` 'moved' divider, `RecapNotice` (label, two lines, Show all) in conversation-parts.tsx.
- E2E (T11): `e2e/tests/handoff.e2e.ts`, two tests; it sets email live and connects a fake bot, and `afterEach` restores both (email offline, bot disconnected).

## Left to CI or later
- `handoff.e2e.ts` and its axe checks have not run (no Docker here): first run is the verify stage's GitHub CI.

## Pending for Ken
- None.
