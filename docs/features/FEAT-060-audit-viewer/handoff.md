# Handoff: FEAT-060 — Audit log viewer, chain verification and export
Branch: feat/FEAT-060-audit-viewer · PR: https://github.com/codeforests/kakiagent/pull/70 · Updated: 2026-11-14 by build (UI)
Stage done: build (T1–T9 of 9), status developer-done
Next: verify — kickoff: "Verify FEAT-060 on branch feat/FEAT-060-audit-viewer. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `pages/audit.tsx` + `pages/audit-parts.tsx`, data/words in `lib/audit.ts` (17 unit tests in `audit.test.ts`), routes in `lib/api.ts`; Settings row `managers` flag (Agents don't see it); inbox `ContextSidebar` "View audit log" section for Owner/Admin (reads `['me']`).
- `SlideOver` (`packages/ui`) gained an optional `onCloseAutoFocus`: Radix only returns focus to a `Dialog.Trigger`, so the entry panel focuses its opener (row button or "Show entry") itself.
- `save` moved from `leads-parts.tsx` to `lib/download.ts` (fast-refresh lint rule), shared by both exports.
- Deviations from ui-design: "Show entry" and "Clear filters" are `ghost` buttons (no `link` button style exists); quick date chips are a small `audit-chip` toggle (`aria-pressed`); the export dialog shows no count (no count endpoint; the 413 names it). An invalid date range stays in the fields with its error and is not put in the URL.
- A verify's result stays on the card through a later 429/409 answer (cooldown counts down, button disabled).
- Stubbed-API Playwright run (scratch, not committed): rows, Load more, detail + focus return, tamper → Show entry #4,512, cooldown 429, date error, quick chip URL, export → re-auth dialog with the JSON body, phone Filters (2) sheet, Agent no-access; axe serious/critical none at 1280 and 375 (list and detail); no sideways scroll at 375.

## Left to CI or later
- `e2e/tests/audit-log.e2e.ts` (2 tests, AC-6–AC-8, axe at 1440 and 375 × 5000) has not run: no local stack here. The verify cooldown (30 s) is shared by the three browsers' runs, so the spec waits out a cooldown before the intact check; it asserts chip "Intact" and accepts the anchors-unavailable wording (LocalStack).
- From the backend session: `terraform validate`/`test`, `governance/test/anchors.int.test.ts` (S3).

## Pending for Ken
- None blocking. FYI (from design): D1 direct-download export deviates from ADR-014 §8; tenant-facing alert on a broken chain is a possible follow-up. Both in pending-actions.
