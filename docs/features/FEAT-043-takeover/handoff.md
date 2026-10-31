# Handoff: FEAT-043 — Take over and hand back, single owner
Branch: feat/FEAT-043-takeover · PR: https://github.com/codeforests/kakiagent/pull/45 (draft) · Updated: 2026-10-31 by build (UI)
Stage done: build (T1–T11 of 11), status developer-done
Next: verify — kickoff: "Verify FEAT-043 on branch feat/FEAT-043-takeover. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- **The dashboard socket moved to the shell** (`AppShell` calls `useInboxSocket(hasTenant)`): one socket per tab so member toasts (`shell/member-toasts.tsx`) show on any page. The inbox reads its state with `useLiveState()` (`lib/realtime.ts`). Check `inbox.e2e.ts` still passes (Live badge) in CI.
- Dock logic: `lib/takeover.ts` `useDockActions` (mutations, alerts, focus moves, lost draft, 60 s "Request sent"); views in `pages/takeover-dock.tsx`; `dockMode`, `ownerText`, `takeoverErrorText`, `memberToastText`, assignee URL/key helpers in `lib/inbox.ts`. List cache keys now carry the assignee (`listKey`/`filterOfKey`).
- Deviations from ui-design: the "You took over · visitor sees …" divider is shown as two rows (the event divider from the server, plus the "Visitor saw: …" caption from the notice message); dividers use names, not "You". The phone menu holds Hand back (Close stays next to it). Socket `message` events for staff/system messages refetch the open thread (for `authorUserId`).
- Stubbed Chromium run (1440 and 375) passed for: take over → composer focus, Ctrl+Enter send, "You" label, notice caption, owner caption, hand back (button and phone menu) → focus on Take over, owned bar, take-from dialog cancel → focus back, request sent.
- Coverage runs need `--workspace-concurrency=1` with `scripts/test-env.sh` (parallel packages race on `CREATE ROLE`).

## Left to CI or later
- E2E `e2e/tests/takeover.e2e.ts` (2 tests) and `inbox.e2e.ts` regression; api coverage threshold (local api run fails only on the S3 presigner, environment).

## Pending for Ken
- None.
