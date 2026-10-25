# Acceptance Report: FEAT-032 — Widget install, theme matching, allowed origins, install check

> Verdict: **Accepted** (E2E, renders and axe green in Ken's local CI at `e54ddd3`, 2026-10-25) · Date: 2026-10-25
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-13) · Sources: SRS v0.4 (ONB-07, CHN-11, CHN-14, CHN-02 (p), NFR-02, NFR-09), use-cases v0.4 (UC-05 steps 1–5, 5a), ADR-005, ADR-014, ADR-016
> Repo state audited: `b91497e` (implementation head); test corrections `77ec16d`, `6321d09`, `ea5ee4b`, `da975c9`, `e54ddd3` (E2E only)

## Verdict summary

FEAT-032 is accepted. Each of AC-1..AC-13 has tests that assert what the criterion says, and the criteria encode ONB-07, CHN-11 and CHN-14 faithfully (design §9's trace checked against the SRS rows). One part of AC-8, "a scheme override stops following", had no test; it is added to the E2E follow test here and was observed directly in Chromium. The feature's test diff only adds cases: the one changed existing assertion (`coach.e2e.ts`, Continue now goes to `/setup/website`) follows the designed flow change, and nothing was loosened, skipped or deleted.

E2E (`widget-install.e2e.ts`, `coach.e2e.ts`), screen renders and axe run only in Ken's local CI, which this feature calls for (widget, lockfile and `infra/` changed).

This session didn't write the code. The standard was re-derived from the SRS rows, UC-05 and design §6, not from tasks.md, and every green below was observed in this run.

## Audit standard

- **ONB-07** snippet, four platform steps, install check green once the widget loads on an allowed origin → AC-1, AC-2, AC-3, AC-13.
- **CHN-11** only the tenant's allowed domains; unlisted domain shows nothing and creates no conversation → AC-4, AC-5.
- **CHN-14** detect colour, font, radius, scheme; follow light/dark; preview and override; isolation both ways; AA clamp; ≤ 5 KB gz → AC-6..AC-10, AC-12, AC-13.
- **CHN-02 (p)** brand colour, logo, position → AC-10, AC-11. **UC-05** 1–2 → AC-10, 3 → AC-2, 5 → AC-3, AC-8, 5a → AC-4.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | ONB-07, ADR-005 | api `widget.int` "needs a session and settings.manage; tenant B sees only its own widget"; db `rls.int` 4 `widget_settings` cases (tenant B, zone column grants) | faithful | green |
| AC-2 | ONB-07 | api `widget.int` "returns the snippet, preview and install state…" (key and loader URL); E2E owner flow (Copy, four platform tabs) | faithful | green; E2E pending CI |
| AC-3 | ONB-07, UC-05 5 | channels `widget-settings.int` "records the install once, then last seen at most hourly"; api `widget.int` config "marks the install"; dashboard `widget.test` polling helper; E2E owner flow turns green without reload | faithful | green; E2E pending CI |
| AC-4 | CHN-11, UC-05 5a | api `widget.int` "is a silent 404 on an unlisted origin: no token, no conversation, wrong_domain" (counts conversations, no CORS header, tenant B untouched); channels "records a rejected origin at most once a minute"; E2E unlisted-origin test | faithful | green; E2E pending CI |
| AC-5 | CHN-11 | channels unit `origin.test` (wildcard, IP, user info, no dot, `http:` outside dev); channels int add/remove/duplicate/20 limit/`fromWebsite`; api `widget.int` 201/422/409/404; audit int (codes and hashes only); E2E remove → silent | faithful | green |
| AC-6 | CHN-14 | ingest-worker `theme-probe.int` on the four fixture sites with real Chromium (accent, font, radius, scheme; `blocked`, `timeout`); channels unit detection helpers (`theme-color`, icon fonts, defaults); E2E fixture-site test | faithful | green (11/11 with Chromium); E2E pending CI |
| AC-7 | CHN-14, NFR-09 | channels unit `clampAccent` 6×6×6 grid in both schemes (≥ 4.5 on-accent, ≥ 3 vs panel), anchor colour unchanged, override clamped; dashboard "Adjusted to…" note; E2E contrast per site | faithful | green |
| AC-8 | CHN-14, UC-05 5 | E2E follow test (within 500 ms, same element); **added**: fixed light scheme stays light after the page turns dark | was partial, corrected | observed in Chromium (below); E2E pending CI |
| AC-9 | CHN-14 isolation | E2E: 56 px launcher under hostile CSS; no added style elements; only `__kaki` as new global, against the same page without the snippet | faithful | pending CI |
| AC-10 | CHN-14, ADR-016 4–5, UC-05 1–2 | channels int detection queues one job, `done`/`failed`, stale redelivery ignored; api appearance round trip, 409 `detect_running`, 422 `no_site`/`origin_not_allowed`; channels unit `resolveTheme` precedence; E2E overrides reach the widget | faithful | green; E2E pending CI |
| AC-11 | CHN-02 (p) | api `widget.int` logo: PNG stored, immutable caching, 404 after delete; 413 over 100 KB; 415 on mismatched magic bytes | faithful | green |
| AC-12 | CHN-14, NFR-02, ADR-016 | `size-limit` budgets; loader on `main` measured here | faithful | loader 1.75 → 4.39 kB gz (+2.64 ≤ 5), initial 4.39 ≤ 30, panel 9.67 ≤ 35 |
| AC-13 | ui-design | E2E owner flow with axe on SCR-APP-037 and SCR-APP-011; state renders (T9 evidence, stubbed api) | faithful | pending CI |

## Corrected tests

- `77ec16d` — AC-8: the follow test in `e2e/tests/widget-install.e2e.ts` now also loads the plain site with a `scheme: 'light'` override in the config (route rewrite), turns the page dark and checks the surface stays light after 800 ms. The loader's `if (!theme.overrides.scheme) followPage(apply)` was otherwise untested.

- AC-9 (after Ken's local CI, 2026-10-25): in WebKit, Playwright's trace adds a `__playwright_snapshot_streamer_*` global to the page under test, so the "only `__kaki` is new" check failed on a harness global. The check now ignores names starting with `__playwright`; the widget's own globals are still asserted exactly.

- AC-10 owner flow (after Ken's local CI, 2026-10-25): detection had settled ("Matched to localhost:5175" in the page snapshot), but the test's `getByText(/^(Matched to …)/)` missed it: the caption's text starts with a space after the spinner's slot, so the anchored pattern never matched. The test now reads the preview's status line, first sees "Matching your website…" for this run, then the settled text. A longer timeout tried first was based on a wrong reading and is taken back out.

- Owner flow, third local CI run: it ran out of Playwright's default 60 s after detection (which really waits on the ingest worker), part-way through, with the fixture origin removed. That left the dev tenant's widget silent for the next browser's run: 18 Firefox widget specs failed, and WebKit then found their leftover data (an extra conflict, a duplicate fact). The flow now has 120 s, and an `afterEach` puts the look and the fixture origin back when it fails.

- AC-4 steps (fourth local CI run): Chromium and WebKit report the refused config answer (404 with no CORS header) as a failed request, never a `response` event, so `waitForResponse` hung (reproduced here in Chromium; Firefox does emit it). Both the owner flow's removed-origin step and the unlisted-origin test now read the answer through a route (`route.fetch`, which sends the page's Origin), still asserting 404, no token and a silent page.

## Independent execution

Through `scripts/test-env.sh` (local Postgres 16 + pgvector; no Docker), at `77ec16d`:

- `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser, 498 modules), `pnpm typecheck`, `pnpm test` (24 tasks), e2e typecheck: green.
- `test:coverage` (unit + integration, per-package thresholds): `@kaki/db` 129/129, `@kaki/channels` 24/24, `@kaki/kb` 368/368, `@kaki/identity` 30/30: green. `@kaki/api` 251 passed, 1 skipped, red only on `uploads.int` (FEAT-015's S3 presigner needs LocalStack; untouched). `@kaki/ingest-worker` red only on `files.int` (LocalStack; untouched); `theme-probe.int` + `chromium.int` 11/11 with the real Chromium.
- Feature suites: api `widget.int` 8/8; contracts 3/3, widget 17/17, dashboard 65/65 (no coverage script in these three).
- `pnpm db:generate`: no drift. Migration 0031 applied to a fresh database by the db suite.
- Widget build and `size-limit`: green (AC-12 row).

## Direct verification

- AC-8 in headless Chromium against the widget dev server with the config stubbed: without an override the surface goes `#FFFFFF` → `#121A22` when the page turns dark; with `scheme: 'light'` it stays `#FFFFFF`.
- Config route (`apps/api/src/app.ts`): the tenant comes from the widget key; an unlisted origin is recorded through `withTenant` on the visitor zone and gets the same 404 with no token; `recordRejectedOrigin` stores only a parsed origin (`new URL(...).origin`, ≤ 300 chars, `null` refused), throttled to once a minute. Dashboard routes run in `withTenant` on the dashboard zone with `settings.manage`; the public logo route reads through the visitor zone by key.
- Audit entries carry codes and an origin hash, no origin text (ADR-014). Detection runs in the guarded Chromium context (`assertPublicHost`), the same code as the loader (D4).

## Findings

**Rework:** none. **Design defect:** none.

**Minor:**

1. The RTM Design ref cells for ONB-07, CHN-11, CHN-14 and CHN-02 don't list FEAT-032's `technical-design.md` / `ui-design.md` (FEAT-022 appended its own). That column belongs to detailed design, so it isn't changed here; append it in a later design session.
2. Deviations documented in tasks.md and accepted: detection columns granted to the ingest zone (`app_ingest`), not outbox; the visitor zone also reads the install columns for the throttles; audit uses an origin hash; no screenshots in `detected_theme` (D6, design §8).

## RTM

Test ref appended (Test ref column only):

- ONB-07, CHN-11, CHN-14: `features/FEAT-032-widget-install-theme/acceptance-report.md`
- CHN-02: `features/FEAT-032-widget-install-theme/acceptance-report.md (partial: brand colour, logo, position, theme matching)`

## CI

Due: the feature touches the widget (size budget), the lockfile and `infra/`. Ken runs CI locally in WSL on this branch; E2E (`widget-install.e2e.ts` 4 tests × 3 browsers, `coach.e2e.ts`), renders and axe are read from his summary. A red there is fixed before merge.

Result: four local runs found four E2E test faults (Corrected tests); none was a product defect. The fifth run, at `e54ddd3`, was green in all three browsers (Ken, 2026-10-25).
