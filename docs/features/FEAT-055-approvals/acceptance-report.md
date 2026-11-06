# Acceptance report: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry (verified)

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-11-06 by an independent verify session · Branch `feat/FEAT-055-approvals` · PR #54

## Verdict summary

**Accepted** (2026-11-06). Every criterion AC-1..AC-13 has a test that asserts what it says, re-run here; the changed FEAT-054 tests follow D1 and were not weakened. All local checks are green except the LocalStack-only `uploads.int` (no container runtime here; CI runs it). AC-13's keyboard clause had no test; one was added to the E2E (below). One pre-existing flaky assertion in FEAT-045's `suggest.int` (random UUIDs containing "55") failed once here and was corrected (below). The documented UI deviations are accepted as minor (F2). AGT-06 stays partial (`handoff_channel` is FEAT-038).

## Audit standard

Re-derived from SRS v0.4 APR-02 (draft → queue with conversation context and KB prices → approve, edit and approve, or reject with a reason → sent to the visitor; "Nothing is sent before a decision. Each decision is audited with the approver and timestamp"), APR-04 (waiting notice with an expected response time; escalate at the SLA; business hours only; configurable, default 2 business hours; after hours → next business day), APR-06 (first decision wins; delivered even if closed; expires after 7 days with a notice; "Two simultaneous decisions result in exactly one recorded decision. An expired approval can no longer be sent"), AGT-06 (`draft_approval` never sends before approval; tool calls audited), UC-22 2, 3, 3a, 5, 5a, 5c, 5d, 6, 6a, and ADR-005/008/012/013/014/025. §6's criteria encode these faithfully; §9's trace covers every clause. D1 (above-maximum discount goes to approval) changes FEAT-054's `refuse`; it is Ken's decision of 2026-11-05.

## Audit table

| AC | Source | Tests | Asserts the criterion | Result |
|---|---|---|---|---|
| AC-1 | APR-02; UC-22 2–3; AGT-06 | agent `approval.int` "drafts one approval from the product facts…"; approvals `approvals.int` "writes one pending approval, moves to waiting_approval, audits codes only…"; api `approvals.int` "lists… detail has the excerpt and prices"; E2E `approvals.e2e` test 1 | Yes | Pass (E2E in CI) |
| AC-2 | APR-02; AGT-06 | eval subset `approvals` (23 cases, threshold 1.0); agent `approval.int` stores only the waiting notice; E2E reject path checks no quote card before the decision | Yes | Pass |
| AC-3 | APR-04; UC-22 3, 3a | agent `approval.int` SGT time, "after hours names the next business day and the opening time", no `reply.*` call on a commitment-only turn, Chinese notice | Yes | Pass |
| AC-4 | APR-04 | approvals `approvals.int` "after hours the SLA starts at the next opening; no hours saved means plain minutes"; contracts `rules.test` 14/2880/2881; api `rules.int` SLA case; dashboard `rules.test` | Yes | Pass |
| AC-5 | APR-02; UC-22 5, 5a; D3 (SRS) | api `approvals.int` approve, "an Agent without rights gets 403; one with rights edits and approves", 422 for empty edit and missing reason; dashboard `approvals.test`; E2E edit-approve and reject | Yes | Pass |
| AC-6 | APR-02, APR-06; UC-22 6 | approvals `approvals.int` "approve delivers one quote card in the transaction…", "a closed conversation gets the quote and stays closed"; api approve publishes; widget `chat.test` quote view; E2E card line, price, total, note | Yes | Pass |
| AC-7 | APR-06; UC-22 5c | approvals `approvals.int` "two decisions at once record one" (`Promise.allSettled`); api `approvals.int` concurrent pair (`Promise.all`) 200 + 409 `already_decided` naming the first, stale version 409 | Yes | Pass |
| AC-8 | APR-04; UC-22 5d | approvals `approvals.int` timers "urgent alerts once more; sla escalates approval_sla; a decided approval does nothing"; scheduler `approval-timers.test` | Yes | Pass |
| AC-9 | APR-06; UC-22 5d | approvals timers "expire sends the notice once, returns to ai and cancels the alerts"; api "an expired approval is 409 expired" | Yes | Pass |
| AC-10 | UC-22 6a; ADR-013 | approvals `approvals.int` "…with no email or phone it is undeliverable" | Yes | Pass |
| AC-11 | D1, D3–D6 | approvals `rules.test` D1 rows; agent `approval.int` above-max `aboveMax`, D3 auto quote `approval.auto`, date still waits, repeat while pending (D4); approvals and api hand-back to `waiting_approval` (D5); inbox `lifecycle.test` and `inbox_queue_auto_close()` in 0049 skips `waiting_approval` (D6) | Yes | Pass |
| AC-12 | ADR-005, ADR-014 | `rls.int` approvals block (cross-tenant read/update, visitor zone never updates, dashboard updates decision columns only, checks); api and approvals tenant-B 404; audit payload assertions (codes only, reason off the audit) | Yes | Pass |
| AC-13 | screens | E2E axe on SCR-APP-017/018 at 1440 px and 375 × 5000 and the widget with the quote card, keyboard rejection (added here); dashboard and widget unit tests | Yes | CI (below) |

## Changed existing tests (reviewed, not weakened)

- approvals `rules.test`: two `refuse` rows now `needs_approval`, plus one more row — D1.
- agent `dispatch.test`: `request_commitment` was `unhandled`; now handled by the approval handler, with outcomes asserted — §5.2.
- contracts `rules.test`: the key-match test moved to approvals `rules.test` unchanged in substance (contracts can no longer import approvals: cycle); new SLA bounds cases.
- inbox `lifecycle.test`, contracts `inbox-contract.test`, agent `coach.test`, `turn.int`: one-line additions for the new state and fields.
- `evals/thresholds.json`: adds `approvals: 1.0`; no threshold lowered. No `.skip`, `.only` or deleted case in the diff.

## Corrected tests

- `packages/agent/test/suggest.int.test.ts` (FEAT-045, not this feature's code): `not.toContain('55')` on the whole audit payload failed when a random suggestion or fact UUID contained "55" (about one run in five). The ids are asserted exactly just above, so the check now blanks them and still asserts no price text in the payload (ADR-014). Commit `FEAT-055 acceptance: correct flaky suggest.int audit check`.
- `e2e/tests/approvals.e2e.ts`: AC-13's "work by keyboard" had no test. The reject path now opens the dialog with Enter, closes it with Escape, reopens it, submits empty (the reason field takes focus), types the reason and submits, all by keyboard. Commit `FEAT-055 acceptance: E2E drives the rejection by keyboard for AC-13`.

## Independent execution

All run fresh in this session at `a871f0c` plus the correction:

- `scripts/check-summary.sh`: format:check, lint (incl. check-rtm), typecheck PASS; `pnpm test` 132 files, 1576 tests PASS.
- Through `scripts/test-env.sh`: `@kaki/approvals` coverage (4 files, 36 tests) PASS; `@kaki/agent` coverage 33 files, 516 tests PASS after the correction; `@kaki/inbox` coverage 11 files, 124 tests PASS; `@kaki/db` integration 4 files, 203 tests PASS (migration 0049 on a fresh database); `@kaki/api` integration 34 of 35 files PASS, `uploads.int` needs LocalStack (no container runtime); `pnpm eval` PASS.
- E2E, build and size: GitHub CI (below).

## Direct verification

- Invariants: drafts are written in code from retrieved facts with integer totals (ADR-008, D2); the decision transaction stores the card and outbox rows together (ADR-012); timers are due columns plus one sweep and the worker re-checks `pending`; one pending approval per conversation by a partial unique index; the decision route checks approval rights server-side (D8); audit payloads carry ids and codes only.
- Module boundaries: dependency-cruiser clean in `pnpm lint`; `@kaki/contracts/quote` is the only new cross-package entry.

## Findings

- F1 (fixed, test only): the FEAT-045 flaky assertion above.
- F2 (accepted, minor UI deviations noted in tasks.md): SCR-APP-017 rows stack at every width; decided rows don't name the decider (the detail page does); "Above your maximum" chip without the percentage; the inbox thread shows the quote's text with "Sent after approval" rather than the card; D3 auto quotes get their own divider. None changes a requirement; ui-design may adopt them in a later pass.
- F3 (later): AGT-06 `handoff_channel` (FEAT-038); signed link (FEAT-056); channel delivery (FEAT-036+).

## RTM

Test ref appended 2026-11-06: APR-02, APR-04, APR-06, AGT-06 (partial: `draft_approval`). `node scripts/check-rtm.mjs FEAT-055 --stage verify`: `RTM check passed (FEAT-055).`

## CI

GitHub CI run 107 (`workflow_dispatch`, https://github.com/codeforests/kakiagent/actions/runs/42140382431) at `de562b2`: all 11 jobs green on attempt 2, including E2E on Chromium, Firefox and WebKit (`approvals.e2e` both tests, keyboard rejection included), integration with coverage (`uploads.int` with LocalStack), build and size, eval, unit, lint. Attempt 1 had two failures not from FEAT-055, both green on the single re-run: FEAT-034's `widget-controls.e2e` menu-button focus on Chromium (passed on Chromium in run 106 and on Firefox and WebKit), and FEAT-049's known `search-volume.int` 2-char Chinese timing (2,087 ms vs 2,000 ms). Run 106 (`59b0a35`) found F4 and F5; run 105 was cancelled for the newer head.

- F4 (fixed, test only): `approvals.e2e` run tags held digits that the fake triage read as the quantity (a `0` or out-of-range number made the draft a Promise), and the Decided tab looked for the tag in a headline that becomes the approved line. Tags are now letters only and the edited line carries the tag.
- F5 (fixed, test only, pre-existing): tenancy `profile.int` used a staff day off 3 days ahead, a public holiday on 5–6 Nov 2026 (Deepavali); it now takes the first non-holiday from day 3.
