# Handoff: FEAT-057 — Kill switch: pause and resume the AI on all channels
Branch: feat/FEAT-057-kill-switch · PR: https://github.com/codeforests/kakiagent/pull/37 (draft) · Updated: 2026-10-28 by build (UI)
Stage done: build (T1–T9 of 9), status developer-done
Next: verify — kickoff: "Verify FEAT-057 on branch feat/FEAT-057-kill-switch.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Dashboard: `lib/ai-status.ts` (`useAiStatus`, `useSetAiPaused`, `pillState`, `pausedSince`, `canToggle`), `shell/ai-status.tsx` (`AiStatusPill`, `KillSwitchDialog`, `PauseIcon`), dialog state, mutation and toast lifted into `app-shell.tsx`; banner `useAiPausedBanner` first in `shell/banners.tsx`. `lib/realtime.ts` invalidates `['ai-status']` on `ai_status`.
- Widget: `chat.ts` `pausedNotice` (shares `noticeView` with `notLiveView`), `panel.tsx` `PausedNotice` as the first `li` of the log (region inside the `li` so the list stays valid), `ContactLines` shared with the not-live card. `notLiveRegion` string reused (identical text).
- E2E `e2e/tests/kill-switch.e2e.ts`: serial; `afterEach` posts `/api/v1/ai/resume` through `page.request`. It reads the fallback from the dialog's "What visitors see" box and expects one `data-author="system"` message.

## Deviations (minor; verify to judge)
- Resume mode uses `ConfirmDialog`, which is always `role="alertdialog"` (ui-design says `dialog` for resume).
- On a 403 the confirm button is disabled rather than hidden (`ConfirmDialog` has no hide option).
- The shell has its own toast (`useShellToast`), not `useToast`, which would also show a page's router-state toast twice.
- Tooltip is a CSS hover/focus tooltip (no Esc dismiss); no tooltip component existed.

## Left to CI or later
- E2E (Chromium, Firefox, WebKit) and axe runs: verify stage's GitHub CI.
- Local: governance `anchors` and api `uploads` S3 suites fail only for lack of S3 in cloud sessions.
- AC-5 staff-reply half waits for the inbox reply feature (backend handoff).

## Pending for Ken
- None.
