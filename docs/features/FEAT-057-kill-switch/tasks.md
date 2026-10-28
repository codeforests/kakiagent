# Tasks: FEAT-057 — Kill switch: pause and resume the AI on all channels

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed (backend T1–T4 built) · Last updated: 2026-10-28

- [x] T1 — Schema: `0035_kill_switch.sql` (`ai_paused_at`, `ai_paused_by`, check, column grant to `app_dashboard`) + Drizzle columns; RLS suite: replace the refused `ai_paused` statement with the own-tenant and cross-tenant case (design §4; D5; AC-7)
      Done when: `pnpm db:setup` applies 0035 on a database at 0034 and `drizzle-kit generate` reports no drift; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with: as `app_dashboard` in tenant B, setting B's kill-switch columns works and A's row is unchanged; `route_complexity_threshold`, `cost_governor_step` and `widget_key` updates stay permission denied; the check rejects `ai_paused = true` with a null `ai_paused_at`.
- [x] T2 — Domain: governance `kill-switch.ts` (`aiPauseState`, `setAiPaused` with conditional update and audit), channels `liveChannelCount`; exports; integration tests in `packages/governance/test/kill-switch.int.test.ts` (design §5.1, §5.2; D3; AC-1, AC-2)
      Done when: governance and channels integration tests pass through `scripts/test-env.sh`: pause sets the three columns and appends one `ai.paused` entry (payload `{}`, actor user ID); a repeat is `changed: false` with no new entry; two concurrent `setAiPaused(paused: true)` in separate transactions give one entry; resume clears the columns and appends `ai.resumed`; `verifyChain` holds; `liveChannelCount` counts only the current tenant's live rows.
- [x] T3 — Agent: the paused branch of `runVisitorTurn` stores the fallback once per run of visitor messages; code-map visitor-turn line updated (design §5.3; D2; AC-3)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/agent test:integration` passes, including a new case: paused → first visitor message gets one `system` fallback (outcome `paused`, fake provider call count unchanged), a second message gets nothing; after resume the next message gets an answer (AC-6); the existing "with the kill switch on…" and "stops between segments…" cases pass unchanged.
- [x] T4 — Contracts and API: kill-switch contract section, `AiStatusEvent` in `RealtimeEvent`, `aiPaused` on `WidgetConfigResponse`; `apps/api/src/ai.ts` (`GET /api/v1/ai/status`, `POST /api/v1/ai/pause|resume`, post-commit `ai_status` publish), widget config `aiPaused`; contract unit test (design §3, §5.4; AC-1, AC-4, AC-5, AC-7)
      Done when: `pnpm --filter @kaki/contracts test` and `scripts/test-env.sh pnpm --filter @kaki/api test:integration` pass with a new `ai.int.test.ts`: Owner and Admin pause/resume return `AiStatus`; Agent 403 and unchanged; repeat is a no-op (no second audit entry); the publisher fake gets one `ai_status` event per change and none for a repeat; status for an Agent works; tenant B's status is unaffected by A's pause; widget config returns `aiPaused` with the persona fallback (custom and default) and contacts while paused, null after resume; `POST /widget/v1/conversations` and a visitor message still succeed while paused, and a staff reply is stored.

## Build session 2 (UI)

- [x] T5 — Dashboard data layer: `lib/api.ts` calls; `lib/ai-status.ts` (`useAiStatus`, `useSetAiPaused`, `pillState`); `lib/realtime.ts` handles `ai_status`; `lib/ai-status.test.ts` (design §5.5; D8; AC-8, AC-9)
      Done when: `pnpm --filter @kaki/dashboard test` passes with `pillState` cases (paused wins over live channels; 0 live and not paused → `not_live`; ≥ 1 live → `live`) and `pnpm --filter @kaki/dashboard typecheck` is clean.
- [x] T6 — Pill, dialog and banner: `shell/ai-status.tsx` (`AiStatusPill`, `KillSwitchDialog`), wired in `app-shell.tsx`; `useAiPausedBanner` first in `shell/banners.tsx`, its "Resume AI" opening the dialog (ui-design SCR-APP-058, Banner; AC-8, AC-9)
      Done when: dashboard typecheck and unit tests pass; `pnpm --filter @kaki/dashboard build` succeeds; only `var(--…)` tokens (grep shows no hex or px colour literals in the new files).
      Note: renders and interaction are checked by T8's E2E in the verify stage's GitHub CI (no local stack in cloud sessions).
- [x] T7 — Widget paused notice: `chat.ts` `pausedNotice`, `panel.tsx` notice above the composer (no greeting, no disclosure row), `strings.ts` en/zh; unit tests in `chat.test.ts` (ui-design SCR-WGT-005 paused; D7; AC-4, AC-10)
      Done when: `pnpm --filter @kaki/widget test` passes with `pausedNotice` cases (null when not paused; zh text for a `zh` browser; contacts only when present; offline wins); `pnpm --filter @kaki/widget build && pnpm size` within budget.
- [ ] T8 — E2E: `e2e/tests/kill-switch.e2e.ts` per design §5.7 with `afterEach` resume; axe light and dark; 375 px run (AC-3, AC-4, AC-5, AC-8, AC-9, AC-10)
      Done when: the spec typechecks and lints; it runs in the verify stage's GitHub CI on Chromium, Firefox and WebKit.
      Note: no local stack in cloud sessions; before CI, try the widget steps in the session's Chromium against the widget dev server with a stubbed config (code-map E2E pitfalls).
- [ ] T9 — Verify: full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for db, governance, channels, agent, api, dashboard, widget through `scripts/test-env.sh`; status `developer-done`; draft PR

## Verification evidence

- AC-1 …
- AC-2 …
- AC-3 …
- AC-4 …
- AC-5 …
- AC-6 …
- AC-7 …
- AC-8 …
- AC-9 …
- AC-10 …
