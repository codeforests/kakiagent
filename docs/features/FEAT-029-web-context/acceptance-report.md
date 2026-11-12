# Acceptance report: FEAT-029 — Web context and first-party intent tracking; consent mode

> Verified 2026-11-12 by an independent verify session · Branch `feat/FEAT-029-web-context` · PR #67

## Verdict summary

**Accepted.** AC-1 to AC-11 hold; every suite was re-run in this session and is green locally. One gap closed with a new test: AC-6's "regenerated, then escalated" had only the regenerate half for the tracking guard, so `compose.test.ts` now checks that a reply revealing tracking on both attempts escalates and never publishes. The E2E half of AC-1, AC-3, AC-4, AC-8 and AC-11 runs in GitHub CI (CI section).

## Audit standard

AGT-05 (Must): the agent uses the current page and, where tracking allows, viewed pages; with tracking off or not consented only the current page; never reveals tracking beyond what is on the page; context recorded in the audit log. CHN-03 (Must): first-party events inside the widget script, keyed by the visitor ID, no cookies or third parties, turn-off per tenant, consent mode with nothing sent before acceptance, events shown in the sidebar. INB-04 (partial): the Intent block's page context. UC-20 steps 1, 5 and 1a. Design §6 encodes each clause (AGT-05: AC-4–AC-7; CHN-03: AC-1–AC-3, AC-8; INB-04: AC-8), plus ADR-005/015 (AC-9), NFR-02/14 (AC-10) and the screens (AC-11). No misencoding found.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | CHN-03 off per tenant; D8 | api `tracking.int` "PUT /api/v1/widget/tracking: staff 403; owner…audited", "config returns the mode", "dropped in off…"; channels `tracking.int` "stores nothing in off…", "sets the mode and audits from → to"; widget `track.test` "tracks in on, or consent once accepted"; dashboard `web-context.test`; E2E `web-context.e2e` toggles | Yes: default `on`, owner-only, audited, nothing stored or sent in `off` | Pass |
| AC-2 | CHN-03 events | widget `track.test` (path only, `@`/6+ digit segments dropped, five UTM keys cut to 100, external referrer host only, uuid); build's stubbed Playwright run (view per load and `pushState`, engage on hide, `history` untouched); code: `credentials: 'omit'`, sendBeacon, no cookie API | Yes | Pass |
| AC-3 | CHN-03 consent; UC-20 1a | channels `tracking.int` "accepted → consented events; declined after accepted deletes them…", "409s outside consent mode"; api `tracking.int` 409/204; E2E "consent mode: nothing before Allow…" (0 events before Allow, events after) | Yes: server drops unconsented events, choice stored with time and wording version, withdrawal deletes | Pass |
| AC-4 | AGT-05 current page only | api `tracking.int` "a message with page stores it, masked"; channels `tracking.int` "page_only when off, unconsented, or for events collected before consent mode"; agent `web-context.int` "AC-4: an off tenant gives page_only"; E2E "tracking off: the next conversation shows only the current page" | Yes | Pass |
| AC-5 | AGT-05 personalise; UC-20 step 5 | agent `web-context.int` "AC-5, AC-7…" (exact `<page>` block, triage tail current page only, no source/UTM/dwell); `web-context.test` tail cases, fenced as data | Yes; replay passes `replayWebContext(question.pagePath)` (code read) | Pass |
| AC-6 | AGT-05 never reveals | `web-context.test` guard cases (viewed path, each en/zh marker, current page's product passes, coaching unchecked); agent `web-context.int` "AC-6: …blocked and regenerated"; **added** `compose.test` "AC-6 (FEAT-029 verify): …twice is escalated and never published"; eval `web-context` 5/5 = 1.000 | Yes, both halves now | Pass |
| AC-7 | AGT-05 audit | agent `web-context.int` (decision `webScope`, masked `webPage`, `webViewed`, `webReturning`); `web-context.test` "scope, masked page, viewed count and returning; no source" | Yes: no query strings, page through `piiMask`, no source | Pass |
| AC-8 | CHN-03 sidebar; INB-04 | api `tracking.int` "full: current page, viewed with dwell, source and returning; off: current page only; email: nulls"; dashboard `web-context.test` (`webRows`, `formatDwell`, `sourceLine`); E2E sidebar Now on / Viewed | Yes | Pass |
| AC-9 | ADR-005, ADR-015, D8 | db `rls.int` "web context tracking (FEAT-029)" (cross-tenant denied, column-limited engage update, page_path check, purge windows, app roles can't execute); channels `tracking.int` masked `/u/S1234567D`; schema has no `contact_id`; scheduler `tracking-purge.test` | Yes | Pass |
| AC-10 | NFR-02, NFR-14 | `pnpm size`: loader 5.96 KB gz (≤ 14), panel 25.57 KB (≤ 35); `track.test` "ignores junk and blocked storage without throwing"; every tracker handler in try/catch (code read) | Yes | Pass |
| AC-11 | SCR-WGT-007, SCR-APP-037 | E2E axe on the settings section, the prompt at desktop and 375×5000; native `<button>`s and switches (keyboard operable); widget strings parity test (`en`, `zh-Hans`) | Yes | Pass (E2E in CI) |

## Changed existing tests (reviewed, not weakened)

- `safety.test.ts`: the data-rule string gains `<page>`; same assertion.
- `turn.int.test.ts`: the decision payload expectation gains the four `web*` fields; nothing removed.
- `inbox-contract.test`, `widget.test` (contracts), dashboard `inbox.test`/`widget.test`: fixtures gain `web`/`tracking`.
- `evals/src/run.ts` passes `web` to the fake; `thresholds.json` adds `web-context: 1.0`, other thresholds unchanged.
- No skips, deleted cases or loosened matchers in the diff.

## Corrected tests

None rejected. Added: `compose.test` AC-6 escalation case (commit `FEAT-029 acceptance: AC-6 …`).

## Independent execution

In this session through `scripts/test-env.sh scripts/check-summary.sh`: `pnpm format:check`, `pnpm lint` (ESLint, dependency-cruiser, RTM 47 features), `pnpm typecheck` PASS; `pnpm test` 1896 tests PASS; integration/coverage `@kaki/db` 242, `@kaki/channels` 185, `@kaki/agent` 577, `@kaki/inbox` 126 PASS; `@kaki/api` integration 462 PASS, only `uploads.int` S3 presigner fails to start LocalStack (no Docker here; untouched by this feature, runs in CI); widget build and `pnpm size` PASS; `pnpm eval` PASS (web-context 5/5, red-team 54/54, S$0.00104 per conversation ≤ S$0.03).

## Direct verification

- Invariants: both new tables have forced RLS, policies, `TENANT_SCOPED_TABLES` entries and RLS cases; the tenant comes from the verified visitor token (body token checked against `Origin`) or the session, never a body field; tracking rows carry no contact ID (ADR-015); paths and UTM masked at the edge with `piiMask`; the model gets paths and the returning flag only, fenced as data, and a deterministic guard blocks tracking reveals (ADR-008 spirit); agent and inbox read web context through `@kaki/channels/tracking` (boundary rule updated); the purge is a `SECURITY DEFINER` function owned by a NOLOGIN role, executable by `app_outbox` only.
- The tracker never patches `history` (popstate plus a 1 s path poll), uses `credentials: 'omit'`, sets no cookie and makes no third-party call.

## Findings

- **Observation (low):** the tracker uses the visitor token from the config; once it expires on a long-open page, beacons get 401 and are dropped silently (best effort by design). No action needed now; FEAT-030 may want a refresh.
- **Observation (low):** "welcome back" is blocked even when the visitor says "I'm back" first; a regenerate covers it. Acceptable.

## RTM

`node scripts/check-rtm.mjs FEAT-029 --stage verify`: RTM check passed (FEAT-029). Test refs appended to AGT-05, CHN-03 and INB-04 (partial: page context in the intent block).

## CI

GitHub CI run 132 at `96c1a46` (2026-11-12): all 11 jobs green, including E2E on Chromium, Firefox and WebKit (`web-context.e2e` passes). Attempt 1 failed only the `search-volume.int` 2-char Chinese timing check (2385 ms against 2000 ms, known CI noise); attempt 2 (failed job only) green. Later commits are docs only.
