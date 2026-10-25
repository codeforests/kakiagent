# Handoff: FEAT-032 — Widget install, theme matching, allowed origins, install check
Branch: feat/FEAT-032-widget-install-theme · PR: https://github.com/codeforests/kakiagent/pull/31 (draft) · Updated: 2026-10-25 by build (UI)
Stage done: build (T1–T12 of 12), status developer-done
Next: verify — kickoff: "Verify FEAT-032 on branch feat/FEAT-032-widget-install-theme. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Evidence per task and the AC table are in `tasks.md`; local checks all green there (format, lint, typecheck, unit, the feature's integration suites, widget size).
- Dashboard: `pages/widget.tsx` (SCR-APP-037 `/settings/widget`, SCR-APP-011 `/setup/website`), `pages/widget-parts.tsx`, `lib/widget.ts` (+ unit test), `lib/widget-editor.ts` (`useWidgetEditor`: polling per D8, draft, preview scheme, save, detect, unsaved-changes guard). Setup step 4's Continue now goes to `/setup/website`; `coach.e2e.ts` updated to match.
- The preview iframe is sandboxed without `allow-same-origin`, so messages go to `*` (look, bot name, greeting only) and replies are matched on `event.source`.
- Fixed a T5 bug: `apps/widget/build.mjs --serve` lacked the `readdirSync` import, so `pnpm dev` for the widget crashed.
- The dashboard now depends on `@kaki/channels` (lockfile changed).

## Left to CI or later
- E2E `widget-install.e2e.ts` (4 tests × 3 browsers), the updated `coach.e2e.ts`, screen renders and axe: Ken's local CI. The widget, the lockfile and `infra/` changed, so verify asks Ken for a local CI run (STATE.md cadence).
- `apps/ingest-worker/test/files.int.test.ts` needs LocalStack (no Docker here); untouched by this feature.
- Lighthouse ≤ 2-point check (CHN-02): M2 close (D1).

## Pending for Ken
- Non-blocking: confirm the Lighthouse check moves to the M2 close (already in pending-actions.md).
- Local CI run on this branch, asked for by the verify stage.
