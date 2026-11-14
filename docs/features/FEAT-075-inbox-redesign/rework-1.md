# Verify findings (rework 1): FEAT-075 — Inbox redesign

> Verified 2026-11-14 by an independent verify session · Branch `feat/FEAT-075-inbox-redesign` · PR #71 · Head audited: `2d6c13e` (GitHub CI run 136)

## Verdict summary

**Rework.** Local checks are green and the design holds (no design defect), but GitHub CI run 136 fails E2E in Chromium, Firefox and WebKit on two production defects:

- **R1 (AC-12, AC-11, NFR-09): axe `label-content-name-mismatch` (serious)** on the new Filters button and on the phone "More views" trigger. It fails five specs in every browser, including four the redesign was meant to leave passing unchanged (AC-11): `email-channel.e2e:212`, `telegram-channel.e2e:194`, `escalation.e2e:145` (all `.filters-button`, with a filter active), and `inbox.e2e:311` "at phone width…" (`#radix-…`, the More views trigger). Cause: the accessible name doesn't contain the visible text. Filters: `aria-label="Filters, 1 active"`, visible text "Filters" + count "1" (`aria-hidden` doesn't exempt it from this rule). More views: `aria-label="More views"` / `"More views, Flagged selected"`, visible text "More" or "Flagged" + Flagged's count. The build's harness axe pre-check missed it; CI's `expectNoSeriousA11yViolations` is the standard.
- **R2 (AC-1, review finding 2): the page still scrolls at 1440 × 900 with a channel-health banner.** The FEAT-075 test in `inbox.e2e` (line 211, Chromium and WebKit) now reports a channel as degraded and asserts `document.scrollingElement.scrollHeight <= innerHeight` on `/inbox/:id`: false. (Firefox stopped earlier on R1.) The build's own check patched the channels response the same way, so the difference is CI's seeded data or timing; the trace is in the run's artifacts (`test-results/inbox.e2e.ts-the-redesigne-…-chromium/trace.zip`).

No RTM Test refs were written (rework). This file is named `rework-1.md` so `check-rtm` (which requires Test refs once `acceptance-report.md` exists) keeps the branch green; the re-verify writes `acceptance-report.md`. Production code is unchanged by this session.

## Audit standard

INB-01 (Must, partial here: list layout, views and filters), INB-04 (Must, partial: sidebar layout), INB-06 (Must, partial: inbox and conversation complete at 375 px), UC-23 steps 1–3, NFR-09 (WCAG 2.1 AA) for AC-12. Technical-design §6 AC-1–AC-12 checked against these and the owner decisions D1–D7: every implemented requirement has at least one AC, and D2 is encoded faithfully by AC-3. No design defect.

## Audit table

| AC | Tests | Asserts the criterion? | Result |
|---|---|---|---|
| AC-1 | `inbox.e2e` FEAT-075 test | Build version had no banner showing. **Corrected:** degraded channel via `page.route('/api/v1/channels')`, banner asserted visible | **Fail (R2)** |
| AC-2 | same test: empty state, no `complementary` "Conversation details" | Yes | Pass (before R2's line) |
| AC-3 | `inbox.test.ts` `inView` matrix; E2E keep-on-matching-filter, clear-on-Escalated | Yes; live-close-stays-open by code read (only links/selects use `to(f)`) | Unit pass; E2E after R2's line, not reached |
| AC-4 | **Added:** views fit at 1440/1024, phone More menu with Flagged/Closed hrefs | Yes | Fit at 1440/1024 passed (before R2's line); phone part not reached |
| AC-5 | E2E Filters panel, chip, accessible name, remove; `takeover.e2e` | Yes | Not reached (inbox); see R1 for the button's name |
| AC-6 | **Corrected:** `escalation.e2e` checks `escalation.urgent` then the one chip | Yes | Chip assertion passed; spec then fails on R1 |
| AC-7 | **Added:** placeholder clears the icon by ≥ 8 px at 1440 and 375 | Yes | 1440 passed |
| AC-8 | `visitorLabel` unit cases; **added:** E2E "Website visitor" | Yes | Unit pass; E2E passed (before R2's line) |
| AC-9 | `live-state` "Connected" (inbox ×3, skeleton ×2) | Yes (D4 copy) | Pass |
| AC-10 | **Added:** phone header ≤ 48 px tall, three 44 × 44 targets | Yes | Not reached |
| AC-11 | every other inbox-related spec unchanged | Yes | **Fail (R1):** email-channel, telegram-channel, escalation, inbox phone-width |
| AC-12 | axe at 1440 × 900 and 375 × 812 | Yes | **Fail (R1)** |

## Changed existing tests (reviewed, not weakened)

- `live-state` "Live" → "Connected" (D4): `inbox.e2e` ×3, `skeleton.e2e` ×2.
- `takeover.e2e` opens Filters before `assignee-filter`; assertion unchanged.
- No skips or deleted cases; removed `urgent-chip` testid was used by no spec.

## Corrected tests

Commit `2d6c13e` "FEAT-075 acceptance: correct tests for AC-1, AC-4, AC-6, AC-7, AC-8, AC-10":
- `escalation.e2e`: expected the chip to read exactly "Escalated", but with the merged urgent chip (AC-6) a visitor who presses Talk to a person in seeded business hours (Mon–Fri 8–19, Sat 9–17, Sun 9–13 SGT) gets "Escalated · Urgent", so it failed by time of day. It now reads `escalation.urgent` from the API and expects the matching single chip.
- `inbox.e2e` FEAT-075 test: banner case of AC-1, AC-4, AC-7, AC-8, AC-10 assertions (the build had only scripts as evidence for these).

These corrections stay; the rework must make them pass, not change them.

## Independent execution

Fresh `pnpm install` (Windows, Node 24, pnpm 10.28 via corepack): `pnpm lint` PASS (incl. check-rtm), `pnpm typecheck` PASS, `pnpm test` PASS (166 files, 1904 tests), dashboard coverage run 302 tests (statements 58.37%, report-only), `@kaki/e2e` typecheck PASS, prettier on changed files PASS. GitHub CI run 136 at `2d6c13e`: format/lint/typecheck, unit, integration and coverage, build and size budget, eval, terraform, workflow lint, scanning all green; Skeleton E2E red in all three browsers (5 failed per browser; R1, R2).

## Direct verification

- `inView`/`matchesView` match the server's `viewFilter` and assignee filter (`packages/inbox/src/views.ts`) case by case.
- CSS uses `var(--…)` tokens only; literals are 1 px borders, breakpoints and the designed pane widths.
- No contract, schema, RLS, outbox, agent or package change.

## Findings and routing

- R1, R2: production code, back to a build session (kickoff in `handoff.md`). After the fix, a fresh verify session re-runs CI.
- F1, F2 (test artifacts): corrected here (above).

## RTM

Not updated (rework). `node scripts/check-rtm.mjs FEAT-075` (design-stage check) passes.

## CI

GitHub CI run 136 at `2d6c13e` (2026-11-14): E2E failed (Chromium, Firefox, WebKit); all other jobs green.
