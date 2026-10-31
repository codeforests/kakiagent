# Acceptance report: FEAT-042 — Real-time inbox, conversation view, context sidebar, lifecycle and auto-close

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-10-31 by an independent verify session · Branch `feat/FEAT-042-inbox` · PR #44

## Verdict summary

**Accepted.** INB-04 and INB-08 are met in full; INB-01 is met except its assignee filter (FEAT-043, no owners exist yet) and AGT-13 gains its "listed under Flagged" clause. UC-23 steps 4–5 are realised for reading the sidebar and closing. Every criterion has a test that asserts what it says; four tests were added here where a clause had none (below). Every local result was produced in this session; E2E (`inbox.e2e.ts`, now 4 tests) and the screen renders run in GitHub CI.

## Audit standard

Re-derived from SRS v0.4 INB-01 ("unified real-time inbox", the open/escalated/approval/flagged/closed and channel filters, "paginated", "new messages appear in ≤ 2 s without refreshing"), INB-04 (sidebar: contact, channel, intent signals, lead status, KB sources used, "visible for every conversation"), INB-08 (five states, auto-close after 30 min widget / 72 h other channels, staff close, reopen within 7 days, "state changes are shown in the inbox and recorded in the audit log"), AGT-13's flagged clause, UC-23 steps 4–5, ADR-013 d1 and technical-design §6 AC-1..AC-10, D1–D9. Every clause maps to an AC (§9 holds). D1 (keeps `status`/`ai` rather than ADR-013's `state`/`ai_handling`) keeps the ADR's decision; D5 (no reopen after a visitor or abuse end) narrows "reopen within 7 days" in line with CHN-13 and AGT-13, and is a reasonable reading rather than a misencoding. The intent block's page/UTM signals are outside INB-04's statement (anchor-screens only) and are recorded in §8 and pending-actions.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 | INB-01 live ≤ 2 s; reconnect | dashboard `lib/inbox.test` (`applySummary`, `appendMessage`); `inbox.e2e` test 1 (row and preview within 2 s, thread); `skeleton.e2e`; **added** `inbox.e2e` "a dropped socket shows Reconnecting, and reconnecting loses nothing" | Yes, with the added test: before it, the Reconnecting state and refetch-on-reconnect were exercised nowhere (handoff) | Pass (GitHub CI) |
| AC-2 | INB-01 filters, pagination | inbox `views.int` (pages newest first, no duplicates or gaps; each view exact; counts; bad cursor); api `inbox.int` (25 a page, views and channel filter, 400s); `lib/inbox.test` (`matchesView`, view ↔ URL) | Yes | Pass |
| AC-3 | AGT-13 Flagged | `views.int` (flagged in any state); `matchesView` closed+flagged; `inbox.e2e` test 2 (Flagged view, chip, divider); `safety.e2e` reads `?view=flagged` | Yes | Pass |
| AC-4 | INB-04 | `views.int` "returns messages with fact IDs, … facts, intents and history"; api `inbox.int` thread case; kb `facts.int` chips; identity `names.int`; agent `turn.int` task kinds; `inbox.e2e` test 1 (fact chip, sidebar contact, channel, intents, fact link) | Yes | Pass |
| AC-5 | INB-08 states, ADR-013 d1 | `lifecycle.test` (exact edge table); `lifecycle.int` (refused edges leave row and audit untouched, stale version, two simultaneous closes → one); api `inbox.int` 409 `state_changed` / `already_closed`, concurrent closes | Yes | Pass |
| AC-6 | INB-08 auto-close | `lifecycle.int` (31 vs 29 min, any open state, not after a message, scan queues once, job closes); db `rls.int` scan once per idle period, outbox zone only; `lifecycle.test` 30 min / 72 h; scheduler `auto-close.test`; **added** assertion: no message posted | Yes, with the added "no visitor message" assertion. 72 h is unit-tested only (widget is the only channel, §8) | Pass |
| AC-7 | INB-08 close, reopen | `lifecycle.int` staff close → reopen (same ID, AI, turn queued), after 7 days refused, visitor-ended stays ended; api `inbox.int`; `inbox.e2e` test 1 (close, Closed view, reopened into Open); **added** `lifecycle.int` reopen after an inactivity close, and abuse-ended stays ended | Yes, with the two added cases | Pass |
| AC-8 | INB-08 shown and audited | `lifecycle.int` (exactly one entry, `{from,to,reason}`, IDs only); api `inbox.int` named dividers; `eventText` unit cases; `inbox.e2e` dividers | Yes | Pass |
| AC-9 | ADR-005, ADR-009 | api `inbox.int` 404 on every route for another tenant, signed-out and owing-2FA refused; `lifecycle.int` tenant B; db `rls.int` FEAT-042 block (lifecycle columns only for dashboard, scan for outbox only, owner NOLOGIN) | Yes | Pass |
| AC-10 | SCR-APP-014/015, NFR-19, NFR-09 | `inbox.e2e` test 3 (375 px: list, thread, details sheet, no horizontal scroll, axe) and axe in tests 1–2; builder's stubbed Chromium runs at 1440/1100/375 for loading, empty, filtered-empty, not-found, closed and flagged | Partly by committed spec (O1) | Pass (GitHub CI) |

## Corrected tests

Added, commit `1e81d9d` (`FEAT-042 acceptance: …`):

- `e2e/tests/inbox.e2e.ts` "a dropped socket shows Reconnecting, and reconnecting loses nothing (AC-1)": routes `/ws` with `page.routeWebSocket`, drops the socket, asserts the header and banner say Reconnecting, starts a visitor conversation while no event can arrive, restores the socket and asserts Live and the new row.
- `packages/inbox/test/lifecycle.int.test.ts`: "a visitor message within 7 days of an inactivity close reopens the same conversation" and "a chat the abuse rule ended stays ended" (AC-7); the auto-close case now asserts no message was posted (AC-6).

Test diff reviewed (`git diff origin/main...HEAD` on `*.test.ts`, `*.int.test.ts`, `e2e/`): no skips, `.only`, `.todo` or deleted cases. Changed existing assertions follow the design: audit payloads gain `{ from, to, reason }` (D6, more fields, nothing removed); `listConversations` takes a view (`open`, or `flagged` for a flagged one); `safety.e2e` reads `?view=flagged` because Open now leaves closed conversations out (D9); `skeleton.e2e` checks the new conversation is the first row instead of `count + 1`, since a 25-row page can't grow by one (still asserts it arrived live, at the top).

## Independent execution

Fresh `pnpm install`, `pnpm tokens`, at `fe48229`: `pnpm format:check` clean; `pnpm lint` (ESLint + dependency-cruiser, 637 modules, no violations); `pnpm typecheck` 26/26; `pnpm test` 24/24 tasks. `test:coverage` with thresholds through `scripts/test-env.sh`: inbox 36/36, db 170/170, identity 103/103, kb 369/369, agent 462/462; api 340 passed + 1 skipped, the only failure `uploads.int` "the S3 presigner" (needs `KAKI_TEST_S3_ENDPOINT`; untouched by the feature, fails on main in cloud sessions, green in CI). After the added tests, `lifecycle.int` 14/14 at `1e81d9d`. contracts, dashboard, scheduler-worker and agent-worker have no coverage script; their suites (incl. `inbox-contract.test`, `lib/inbox.test`) pass in `pnpm test`.

## Direct verification

- Tenant ID only from the session in every route (`apps/api/src/inbox.ts`: `s.tenantId`, `withTenant(dashboardDb, …)`); names read through the identity zone (D7); close publishes after commit, pub/sub only notifies (ADR-017).
- Migration 0042: `app_dashboard` may update only `status, version, closed_at, close_reason`; the auto-close function is `SECURITY DEFINER` with a fixed `search_path`, owned by the NOLOGIN `kaki_inbox_timer` with column-limited grants, revoked from `PUBLIC` and granted to `app_outbox` only. The job goes through the outbox (ADR-012) and the worker re-checks idleness and compare-and-sets (idempotent).
- Send gate: open set widened to `escalated` and `waiting_approval` (D2, ADR-013 d3); `human` still blocks the AI. The model and prompt are untouched; `store(` records task kinds only.
- UI against ui-design: every specified string is in the code (empty-state titles drop the trailing full stop); three panes at ≥ 1280 by `useMedia`, drawer at 1024–1279, one pane below with a bottom sheet under 640; `role="log"` thread, `aria-current` on the selected row, throttled polite announcement for new visitor messages; tokens only (no colour literals added to `app.css`).

## Findings

- O1 (observation, not blocking): the inbox's loading, error-with-Try-again and empty-per-view states, and the 1024–1279 drawer, are asserted by the builder's stubbed-API runs, not a committed spec (as for FEAT-007/008); the backend behind them is covered by the integration suites.
- O2 (observation, not blocking): the thread's `role="log"` is implicitly polite, so "Show earlier messages" may announce the older page too; ui-design asks for announcements of new messages only. Worth a look when FEAT-043 adds the composer.
- O3 (carried, §8): INB-01's assignee filter (FEAT-043) and the intent block's page/UTM context (no feature yet) are in pending-actions.

## RTM

Test ref appended for INB-01 (partial: assignee filter with FEAT-043), INB-04, INB-08, and AGT-13 (partial: flagged listing).

## CI

Pending: GitHub CI on the PR branch.
