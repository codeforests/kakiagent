# Handoff: FEAT-075 — Inbox redesign
Branch: feat/FEAT-075-inbox-redesign · PR: https://github.com/codeforests/kakiagent/pull/71 (draft) · Updated: 2026-11-14 by build
Stage done: build (T1–T10 of 10), status `developer-done`
Next: verify — kickoff: "Verify FEAT-075 on branch feat/FEAT-075-inbox-redesign. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Dashboard + E2E only: no contract, schema or package change. Evidence per task in `tasks.md`.
- Built and checked on Windows against the local WSL api through a dashboard dev server on :5190 (Edge, Playwright scripts); no E2E run here (see below).
- Deviations from ui-design, all to meet an AC (recorded in tasks.md evidence):
  - Views use `space-between` (min gap `--space-3`) and caption-size labels in the 360 px pane; the fixed `--space-6` gap overflowed (AC-4). Checked with counts 128/12/9/14.
  - Filters is icon-only at 1024–1279 as well as on phone, and the search input drops its clear-button padding while empty, so the placeholder shows in full (AC-7).
  - At < 640 the state chip sits on header line 2 beside "party · channel"; beside the subject it cut the subject to two letters (AC-10).
  - Desktop header shows More only when it has an item (Hand back, when mine).
- D2: `to(f)` prefers the cached list row over the thread copy (live events patch lists synchronously, the thread only refetches). inbox.e2e's reopen → Open step depends on this.
- `UrgentChip` (testid `urgent-chip`) is gone; urgent is `StateChip urgent` ("Escalated · Urgent", testid `state-chip`). No spec used `urgent-chip`.
- The dashboard has no `test:coverage` script (report-only coverage); T10 ran `vitest run --coverage` directly.
- Windows notes: turbo needs a `pnpm.cmd` on PATH; `pnpm format:check` flags every file in a CRLF working copy (run prettier on the changed files instead, or check on Linux/CI).

## Left to CI or later
- E2E (inbox, takeover, skeleton changed; every other inbox spec unchanged, AC-11) and its axe runs: the verify stage's GitHub CI run. The only stack on this machine is Ken's WSL dev stack, so E2E wasn't run against it. Axe was pre-checked through the harness (clean at 1440 × 900 and 375 × 812).

## Pending for Ken
- Where FEAT-075 sits in the build order: plan §5 and STATE.md put it before M5's FEAT-060 (owner request); say if it should wait.
