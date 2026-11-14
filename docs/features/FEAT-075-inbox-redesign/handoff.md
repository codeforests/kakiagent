# Handoff: FEAT-075 — Inbox redesign
Branch: feat/FEAT-075-inbox-redesign · PR: https://github.com/codeforests/kakiagent/pull/71 (draft) · Updated: 2026-11-14 by verify
Stage done: verify (rework) — see `rework-1.md`
Next: build (rework R1, R2) — kickoff: "Build FEAT-075 (rework R1, R2) on branch feat/FEAT-075-inbox-redesign. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build; the findings are in docs/features/FEAT-075-inbox-redesign/rework-1.md."
Then: a fresh verify session (same kickoff as before).

## What the next stage needs
- R1: axe `label-content-name-mismatch` (serious) on `.filters-button` (`inbox.tsx` ~l. 223: `aria-label="Filters, N active"` vs visible "Filters" + count) and the phone More views trigger (~l. 461: `aria-label="More views…"` vs visible "More"/"Flagged" + count). The name must contain the visible text: e.g. drop the `aria-label` and let the visible label and count plus a visually hidden " active" form the name (then the E2E `toHaveAccessibleName('Filters, 1 active')` in `inbox.e2e` may need the new exact name; keep it asserting the count). Fails `email-channel.e2e:212`, `telegram-channel.e2e:194`, `escalation.e2e:145`, `inbox.e2e:311` in all browsers.
- R2: AC-1 still fails in CI: at 1440 × 900 with a degraded-channel banner, `/inbox/:id` scrolls (`inbox.e2e:211`, Chromium and WebKit). Trace in CI run 136's artifacts.
- Verify corrected two specs in `2d6c13e` (escalation urgent chip; extra FEAT-075 assertions): keep them; make them pass.
- Don't trust the harness axe pre-check: run `expectNoSeriousA11yViolations` (e2e/tests/support.ts) or CI.
- Windows: no `pnpm` on PATH here; a `pnpm.cmd` shim calling `corepack pnpm` works for turbo.

## Left to CI or later
- E2E: start GitHub CI on the fixed head in the next verify session.

## Pending for Ken
- None blocking; merge waits for acceptance.
