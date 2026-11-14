# Handoff: FEAT-075 — Inbox redesign
Branch: feat/FEAT-075-inbox-redesign · PR: none yet · Updated: 2026-11-14 by design
Stage done: design
Next: build (UI, one session) — kickoff: "Build FEAT-075 on branch feat/FEAT-075-inbox-redesign. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Dashboard only: no contract, schema or package change. Tasks T1–T10 in `tasks.md`.
- Owner request (Ken, 2026-11-14), approved from a prototype canvas (link in ui-design.md, private to Ken). Same functionality; ui-design.md restates only what changes, and its "Unchanged" list must keep passing.
- D2 changes FEAT-042 behaviour: `to(f)` in `inbox.tsx` stops keeping the selected id when the conversation isn't in the new view/filters (`inView` mirrors `viewFilter` in `packages/inbox/src/views.ts`; status is `waiting_approval`). Live events never deselect.
- D4 copy change "Live" → "Connected" on `live-state`; update the five E2E expectations listed in T9 (copy change, not a weakened test). `assignee-filter` keeps its testid but sits in the Filters panel.
- D6: the empty-state card uses `counts.escalated` (no per-user count in the API).
- There is no shared menu in `@kaki/ui`; the phone "More" views menu reuses Radix `DropdownMenu` like the header's More actions.
- PR #66 fixed the thread height under a banner at phone width; T2 extends that to desktop (review: at 1440 × 900 the dock fell below the fold).

## Left to CI or later
- E2E and axe runs in the verify stage's GitHub CI run if the session has no Docker.

## Pending for Ken
- Where FEAT-075 sits in the build order: plan §5 and STATE.md put it before M5's FEAT-060 (owner request); say if it should wait.
