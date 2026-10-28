# Acceptance Report: FEAT-034 — Channel framework: adapter contract, go-live and go-offline per channel, health and degraded alerts

> Verdict: **Accepted** (GitHub CI green at `2d203b6`, 2026-10-28, incl. E2E `channels.e2e.ts` in Chromium, Firefox and WebKit) · Date: 2026-10-27
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-10) · Sources: SRS v0.4 (CHN-01, ONB-10, CHN-12), use-cases v0.4 (UC-25 steps 4, 4a; UC-03 go live), ADR-005, ADR-011, ADR-013, ADR-014, NFR-05
> Repo state audited: `e4a8323` (implementation head); one test strengthened (see Corrected tests)

## Verdict summary

FEAT-034 is accepted. Each of AC-1..AC-10 has tests that assert what the criterion says, and the criteria encode CHN-01 (one adapter contract and a registry; a new channel is an adapter module and a config entry), ONB-10 (explicit Owner/Admin go-live and go-offline per channel; no AI reply on a channel that isn't live; hidden or message before go-live) and CHN-12's detection half faithfully. Partial by design and not claimed: ONB-10's pre-live lead capture (the contact form is FEAT-049, D8; the message mode shows the business's own contacts and collects nothing), CHN-12's alerting by email and Telegram (FEAT-052, FEAT-037, D6) and its queued retry of failed sends (per adapter from FEAT-036, D4). The go-live readiness checks are FEAT-035 (D9).

The test diff adds files and cases only (two contract fixtures gained the now-required `availability` field); nothing loosened, skipped or deleted.

## Audit standard

CHN-01 (M): single `ChannelAdapter` abstraction; acceptance: adding a channel needs only a new adapter module and a config entry. ONB-10 (M): go live and go offline are explicit owner/admin actions per channel; a tenant that is not live never answers real visitors; acceptance: before go-live the widget shows only a configurable message (with lead capture) or stays hidden. CHN-12 (M, partial): a revoked or broken credential is detected, shown as degraded, and the Owner/Admin alerted; detection within 15 minutes; failed outbound sends queued and retried. Design §9's trace was checked against these rows; the deferrals are named in D6, D8 and §8.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 contract, registry, fake adapter passes the suite, listed, health-checked, no core change | CHN-01, ADR-011 | channels `adapter-contract.test.ts` (`adapterContractSuite` on the fake adapter, registry, `connectable`); `connections.int.test.ts` `runChannelHealth` with a test registry | Yes | Green |
| AC-2 Owner/Admin per-channel routes, Agent 403, 409, cross-tenant 404, one audit with kind and ID, no-op on same state | ONB-10, ADR-014 | api `channels.int.test.ts` (round trip, 401/403 on every route, 409, 404); channels "repeating the current state changes and audits nothing" | Yes | Green |
| AC-3 no AI reply while offline: 409 on new conversation, no triage/retrieval/model call, one `not_live` message, no repeat, kill switch wins, mid-reply, coaching `not_live` | ONB-10, ADR-013 | agent `turn.int.test.ts` (4 cases); api 409 case; api `coach.int.test.ts` offline case | Yes, after correction (below) | Green |
| AC-4 `availability` in config; hidden mounts nothing; message shows text in the visitor's language and contacts, no composer; new tenant offline and hidden; install recorded | ONB-10, ADR-016 | api widget config case; db trigger case; widget `availability.test.ts`, `chat.test.ts`; E2E test 1 | Yes | Unit/int green; E2E pending CI |
| AC-5 offline settings: trim, null empty, > 300 and disallowed `hidden` rejected with field errors, audit field names only | ONB-10, ADR-014 | channels offline-settings cases; api 400 `fields`; contracts cases; dashboard `validateOffline` | Yes | Green |
| AC-6 health every 5 min; revoked/invalid degrade at once; unreachable on the second; throw/timeout unreachable; ok recovers; send auth failure degrades; one audit per transition; tenant failures isolated | CHN-12 | channels health cases (5); scheduler `channel-health.test.ts` | Yes | Green |
| AC-7 degraded card alert with Check again, 429 within 30 s, banner for Owners/Admins only | CHN-12 (p) | channels `checkChannelNow` (`TooSoonError`); dashboard `degradedChannels`; E2E test 2; builder's stubbed Chromium checks | Yes | Unit/int green; E2E pending CI |
| AC-8 RLS, credential column denied to dashboard, `visitor_channel` scoping, `channel_health_due` NOLOGIN-owned and outbox-only, sealer, no credential in responses | ADR-005, NFR-05 | db `rls.int.test.ts` channel cases; channels `localSealer` cases; api "no credential fields" | Yes | Green |
| AC-9 page and widget states, confirm first, never optimistic | SCR-APP-036, SCR-WGT-005 | dashboard `channels.test.ts`; E2E tests 1–2; builder's Chromium renders (T8, T9 notes) | Yes | Unit green; renders pending CI |
| AC-10 chips text + icon, focus trap and return, validation convention, axe light/dark | WCAG 2.1 AA | E2E axe (page, dialog, widget panel, light and dark); code review | Yes | Pending CI |

## Corrected tests

- AC-3: the agent not-live case asserted no triage or generation call (`calls.generate` 0) but not the "no retrieval" the criterion names; retrieval embeds the visitor's message, so a regression that started retrieval before the gate would have passed. `llmWith` now counts embeds, and the case asserts zero embeds for the first and the repeated message.

## Independent execution

All in this session through `scripts/test-env.sh` (no Docker), from a fresh `pnpm install` and a token build:
- `pnpm format:check`, `pnpm lint` (ESLint + depcruise, 0 violations), `pnpm typecheck` (26/26), `pnpm test` (24/24): green.
- `test:coverage`: channels 48/48, agent 403/403 (with the corrected test), api 275 passed, 1 skipped, only the S3 presigner red (below); no threshold failures.
- `pnpm --filter @kaki/widget build` and `pnpm size`: loader 4.43 KB gz (≤ 14), panel 12.66 KB gz (≤ 35), initial load 4.43 KB gz (≤ 30).
- Feature suites: db integration 139/139; channels unit 27/27, integration 21/21; agent integration 86/86 (incl. the clock-dependent `language-hours` case the build flagged); api integration 263 passed, 1 skipped, `uploads.int.test.ts` S3 presigner can't start (needs an S3 endpoint; fails on `main` the same way); api unit 12/12; scheduler-worker 6/6; contracts 9/9; widget 30/30; dashboard unit 93/93.
- First run note: channels, widget, dashboard and api suites fail at import until `@kaki/design-tokens` is built (`pnpm tokens`); environmental, not a code fault.

## Direct verification

- Migration `0034_channels.sql`: forced RLS and `tenant_isolation` policy; `channel_connections` in `TENANT_SCOPED_TABLES`; the dashboard zone's column grants leave out `credential_ciphertext` and `credential_key_ref`, and the visitor zone has no table grant (it reads through `visitor_channel()`); `visitor_channel()` SECURITY DEFINER owned by `kaki_tenant_state`, `search_path` pinned, EXECUTE revoked from PUBLIC; `channel_health_due()` and the new-tenant trigger function owned by the NOLOGIN `kaki_channels`, health-due executable by `app_outbox` only.
- The send gate checks the kill switch first, then the conversation, then channel live (`gate.ts`); `runVisitorTurn` returns before triage and retrieval when the gate is closed (`turn.ts` `!gate.open` precedes `triage(` and `retrieve()`), and re-checks before each segment.
- Tenant ID comes from the session or the resolved widget key; audit payloads carry kind, connection ID, reason and field names only (ADR-014).
- Dashboard page copy checked against ui-design SCR-APP-036 and the banner spec (lede, meta lines, alert and fix copy, dialogs, toasts, offline form help and error, conflict, permission, banner one/many); `useChannels` refetches every 60 s and on focus. Dashboard and widget CSS use `var(--…)` / `--kaki-*` only.

## Findings

- Observation (not blocking): the 429 mapping of `TooSoonError` in `apps/api/src/channels.ts` has no API-level test (the domain throw is tested); the route table is shared with the other mapped errors, which are tested.
- Observation: the not-live message is not repeated when the last non-visitor message has the same text; if the owner edits the text while a visitor is still writing, the visitor gets the new text once more. Harmless and arguably right.
- Observation: the widget's not-live region is named after the assistant (`botName`) because the config carries no business name; ui-design said "{business}". Fine until the config carries a business name.

## RTM

Test ref appended: CHN-01, ONB-10 (partial: pre-live lead capture with FEAT-049; readiness checks with FEAT-035), CHN-12 (partial: email and Telegram alerts with FEAT-052, FEAT-037; failed-send retry per adapter from FEAT-036).

## CI

Widget files, the lockfile and a new E2E spec changed, so Ken's local CI is due before merge (STATE.md cadence). E2E `channels.e2e.ts` (2 tests) and its axe checks are judged from that run; a red result goes back to a build fix before merge.

GitHub CI (run 72, at Ken's request once the repo was public), `2d203b6`, 2026-10-28: all 11 jobs green. Run 71 before it had two faults, both fixed on this branch: E2E test 1 in every browser ran axe on a visitor page opened with `browser.newPage()` (axe needs a page from `browser.newContext()`; `visit()` now opens its own context), and `terraform fmt -check` flagged a comment alignment in `envs/prod/main.tf` from FEAT-032 (formatted). The other 55 E2E tests per browser, integration, unit, static, build/size, eval and scanning were green in both runs.
