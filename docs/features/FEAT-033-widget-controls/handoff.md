# Handoff: FEAT-033 — Widget visitor controls and EN / 中文 chrome
Branch: feat/FEAT-033-widget-controls · PR: https://github.com/codeforests/kakiagent/pull/34 · Updated: 2026-10-26 by build (UI)
Stage done: build (T1–T9 of 9), developer-done
Next: verify — kickoff: "Verify FEAT-033 on branch feat/FEAT-033-widget-controls. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Widget: `strings.ts` (14 new keys, `ALL_STRINGS` for the parity test), `chat.ts` (`chromeLocale`, `menuItems`), `api.ts` (`endConversation`, `ChatEndedError` on 409), `panel.tsx` (`HeaderMenu`, `PrivacyLink`, end state `open | confirm | ending | ended`, `newChat`), `panel.css.ts` (`.menu`, `.mi`, `.foot`, `.card`, `.btn`).
- The locale is now derived inside `Panel` on every render; `mountPanel` no longer sets `lang` once (an effect does).
- A 409 on send shows the visitor's done card (with Start a new chat), as the design's "panel shows the ended state".
- The typing and slow indicators hide once the visitor ends (the gate sends nothing more).
- Backend notes from the backend session still hold: D5 changed one FEAT-025 test in `packages/agent/test/safety.int.test.ts` by design (review it as design-mandated, not weakened); an unused `TENANT_B` import was removed from `apps/api/test/widget.int.test.ts`.
- Menu focus moves in an effect after render: an E2E must wait for the item to be focused before pressing Enter (the spec does, with `toBeFocused`).

## Left to CI or later
- E2E `widget-controls.e2e.ts` in Ken's local CI: its steps passed in the cloud Chromium against a stand-in api/realtime, except the dashboard inbox check (needs the stack) and Firefox/WebKit.
- `apps/api/test/uploads.int.test.ts` "S3 presigner" needs Docker or `KAKI_TEST_S3_ENDPOINT` (fails on main too).

## Pending for Ken
- Local CI before merge: the feature touches the widget (size budget, E2E). Nothing blocks the verify stage.
