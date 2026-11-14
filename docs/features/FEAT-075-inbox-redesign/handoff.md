# Handoff: FEAT-075 — Inbox redesign
Branch: feat/FEAT-075-inbox-redesign · PR: https://github.com/codeforests/kakiagent/pull/71 (draft) · Updated: 2026-11-14 by build (rework 1)
Stage done: build (rework R1, R2 of `rework-1.md`), status `developer-done`
Next: verify — kickoff: "Verify FEAT-075 on branch feat/FEAT-075-inbox-redesign. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify. This is the re-verify after rework 1 (docs/features/FEAT-075-inbox-redesign/rework-1.md); run GitHub CI on the new head."

## What the next stage needs
- R1: the Filters button and the phone More views trigger have no `aria-label`; names come from content ("Filters 1 active", "More views 2", "More views, Flagged selected 2"). The Filters label is visually hidden, not `display: none`, where the button is icon-only. `inbox.e2e` now expects "Filters 1 active" (was "Filters, 1 active"; the count is still asserted). Nothing else in the specs changed.
- R2: cause was an absolutely positioned `.sr-only` "Escalated:" span in a list row below the fold, which had the page as its containing block and so escaped the clipped panes. Fix: `position: relative` on `.content:has(.inbox)` (≥ 1024 and the < 1024 thread) and `.inbox__rows`. Reproduced locally (965 px page) and fixed (900 px); evidence in `tasks.md` "Rework 1 evidence".
- The verify session's corrected specs from `2d6c13e` are unchanged.
- E2E here ran against this branch's dashboard on :5183 proxied to the running local api, Chromium only. Three specs failed locally for reasons of this environment, not the change (see tasks.md); CI's fresh database decides them.
- Windows: no `pnpm` on PATH; a `pnpm.cmd` shim calling `corepack pnpm` works for turbo.

## Left to CI or later
- E2E in all three browsers: start GitHub CI on the fixed head in the verify session.

## Pending for Ken
- The local E2E runs in this rework used the running WSL dev stack (tenant `kaki-bakery`), so they added test conversations and facts there and ran the telegram, takeover and escalation specs' setup steps against it. The earlier build session had avoided this; `pnpm stack:reset` and `pnpm db:setup` restore a clean dev database if you want one.
