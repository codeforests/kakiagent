# Handoff: FEAT-033 — Widget visitor controls and EN / 中文 chrome
Branch: feat/FEAT-033-widget-controls · PR: none · Updated: 2026-10-26 by design
Stage done: design
Next: build (backend, T1–T4) — kickoff: "Build FEAT-033 (backend) on branch feat/FEAT-033-widget-controls. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Backend is T1–T4 (contracts → `0032_message_language.sql` + inbox → agent `store()` → api end route); UI is T5–T9 after `## Build session 2 (UI)`.
- T1 breaks every `Message` literal (add `language: null`) and the hand-built config in `apps/widget/src/preview.ts`; fix them in T1 so the workspace typechecks.
- The visitor zone already has `UPDATE (status)` on `conversations`; no grant change. `messages.language` needs no grant either.
- `appendVisitorMessage`: check for an existing `clientMessageId` row before refusing a closed conversation (retries stay 200), D5.
- Privacy URL and talk-to-person are config fields only: `privacyNoticeUrl: null`, `controls.talkToPerson: false` (D1, D2). Don't add tenant columns.
- UI session: menu keyboard per ui-design; Escape in the menu/confirm must `stopPropagation` (the mount's Escape closes the panel).

## Left to CI or later
- E2E `widget-controls.e2e.ts` and the size budget run in Ken's local CI: the feature touches the widget, so CI is due before merge.
- FEAT-058 sets `privacyNoticeUrl`; FEAT-044 sets `controls.talkToPerson` and wires `onTalkToPerson`; FEAT-031 adds the rating to SCR-WGT-006; FEAT-042 may add a "visitor ended" row for staff.

## Pending for Ken
- Nothing blocks the build. Ken's local CI before merge (widget touched).
