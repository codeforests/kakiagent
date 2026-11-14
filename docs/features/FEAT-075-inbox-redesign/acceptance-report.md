# Acceptance report: FEAT-075 — Inbox redesign

> Verified 2026-11-14 by an independent verify session (re-verify after rework 1) · Branch `feat/FEAT-075-inbox-redesign` · PR #71 · Head audited: `d824488` (GitHub CI run 138)

## Verdict

**Accepted.** Rework 1 fixes both findings of the first verify (`rework-1.md`, kept as history): R1 (axe `label-content-name-mismatch` on the Filters button and the phone More views trigger) and R2 (page scroll at 1440 × 900 with a channel-health banner). The first verify's test corrections (`2d6c13e`) stand unchanged; GitHub CI run 138 at `d824488` is green in every job, E2E in Chromium, Firefox and WebKit.

## Audit standard

INB-01 (Must, partial here: list layout, views and filters), INB-04 (Must, partial: sidebar layout), INB-06 (Should, partial: inbox and conversation complete at 375 px), UC-23 steps 1–3, NFR-09 (WCAG 2.1 AA) for AC-12. Technical-design §6 AC-1–AC-12 re-derived against these and owner decisions D1–D7: every implemented requirement has at least one AC, D2 is encoded by AC-3. No design defect.

## Audit table

| AC | Tests | Asserts the criterion? | Result |
|---|---|---|---|
| AC-1 | `inbox.e2e` "the redesigned inbox …": degraded channel via `page.route('/api/v1/channels')`, banner visible, `scrollHeight <= innerHeight` and dock bottom ≤ 900 on `/inbox/:id` at 1440 × 900 | Yes (corrected in `2d6c13e`) | Pass (R2 fixed) |
| AC-2 | same test: empty state at `/inbox`, no `complementary` "Conversation details" | Yes | Pass |
| AC-3 | `inbox.test.ts` `inView` matrix; E2E keep-on-matching-filter, clear-on-Escalated | Yes; live-close-stays-open by code read (only links/selects use `to(f)`) | Pass |
| AC-4 | views fit at 1440/1024; phone More menu with Flagged/Closed hrefs | Yes (added in `2d6c13e`) | Pass |
| AC-5 | E2E Filters panel, chip, accessible name "Filters 1 active", remove; `takeover.e2e` | Yes (see note below) | Pass |
| AC-6 | `escalation.e2e` reads `escalation.urgent`, expects the one matching chip | Yes (corrected in `2d6c13e`) | Pass |
| AC-7 | placeholder clears the icon by ≥ 8 px at 1440 and 375 | Yes (added in `2d6c13e`) | Pass |
| AC-8 | `visitorLabel` unit cases; E2E "Website visitor" | Yes | Pass |
| AC-9 | `live-state` "Connected" (inbox ×3, skeleton ×2) | Yes (D4 copy) | Pass |
| AC-10 | phone header ≤ 48 px tall, three 44 × 44 targets | Yes (added in `2d6c13e`) | Pass |
| AC-11 | every other inbox-related spec unchanged (email-channel, telegram-channel, escalation, takeover, inbox phone-width) | Yes | Pass (R1 fixed) |
| AC-12 | axe (serious/critical) at 1440 × 900 and 375 × 812 on `/inbox` and `/inbox/:id` | Yes | Pass (R1 fixed) |

## Rework 1 audit

- **R1** (`inbox.tsx`, `app.css`): the Filters button and the More views trigger drop `aria-label` and are named by their content, so the name contains the visible text (WCAG 2.5.3). Filters: glyph + label + count + `sr-only` " active"; where the button is icon-only (< 640, 1024–1279) the label is visually hidden (the `.sr-only` pattern) instead of `display: none`, so "Filters" stays in the name. More: "More" + hidden " views", or hidden "More views, " + view + hidden " selected"; Flagged's count follows. Rule now not applicable (no `aria-label`), and the name still carries the count and state.
- **R2** (`app.css`): `position: relative` on `.content:has(.inbox)` (≥ 1024 and the < 1024 thread) and `.inbox__rows`, so absolutely positioned `.sr-only` and badge spans in rows below the fold are clipped by their pane instead of growing the page. Cause and fix are consistent with the build's probe (965 → 900 px). Radix menus portal to `body`, so the new containing blocks don't move them; CI's phone-width specs confirm.
- Production change is limited to these two files; no contract, schema, RLS, outbox, agent or package change.

## Changed existing tests (reviewed, not weakened)

- `live-state` "Live" → "Connected" (D4): `inbox.e2e` ×3, `skeleton.e2e` ×2.
- `takeover.e2e` opens Filters before `assignee-filter`; assertion unchanged.
- `inbox.e2e`: expected Filters name "Filters, 1 active" → "Filters 1 active" (`d824488`). The build wrote the old string (T9, from ui-design's suggested `aria-label`); the new one is the content name WCAG 2.5.3 requires, and still asserts the count and "active". Equivalent, not weaker. ui-design's `aria-label` wording is superseded by the content name; noted here rather than editing the signed-off design.
- `git diff 2d6c13e d824488 -- e2e` is that one line: the verify corrections stand. No skips or deleted cases.

## Independent execution

Fresh `pnpm install --frozen-lockfile` and `pnpm tokens` (Windows, Node 24.12, pnpm 10 via corepack): `pnpm lint` PASS (ESLint, dependency-cruiser, check-rtm), `pnpm typecheck` PASS, `pnpm test` PASS (1904 tests, 0 failed), `@kaki/e2e` typecheck PASS, prettier `--check --end-of-line auto` on every file the branch changed PASS (full `format:check` is run by CI on LF). The dashboard has no `test:coverage` script (coverage is report-only; the build's T10 figures stand). Token-use log skipped: `/mnt/project-files` doesn't exist on this machine.

## Direct verification

- `inView`/`matchesView` match the server's `viewFilter` and assignee filter (`packages/inbox/src/views.ts`), from the first verify; unchanged by the rework.
- CSS uses `var(--…)` tokens only; new literals are the 1 px visually-hidden box.
- AGENTS.md invariants: dashboard-only change; none touched.

## RTM

Test refs appended: INB-01 (partial: list layout, views and filters), INB-04 (partial: sidebar layout), INB-06 (partial: inbox and conversation complete at 375 px).

`node scripts/check-rtm.mjs FEAT-075 --stage verify`: `RTM check passed (FEAT-075).`

## CI

GitHub CI run 138 at `d824488` (2026-11-14): all 11 jobs green (format/lint/typecheck, unit, integration and coverage, build and size budget, eval, terraform, workflow lint, scanning, Skeleton E2E in Chromium, Firefox and WebKit), first attempt. First verify: run 136 at `2d6c13e`, E2E red (R1, R2).
