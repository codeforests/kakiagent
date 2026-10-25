# Handoff: FEAT-032 — Widget install, theme matching, allowed origins, install check
Branch: feat/FEAT-032-widget-install-theme · PR: https://github.com/codeforests/kakiagent/pull/31 · Updated: 2026-10-25 by verify
Stage done: verify (accepted; Ken's local CI green in all three browsers at `e54ddd3`)
Next: FEAT-033 design, only when Ken says go — kickoff: "Design FEAT-033. Branch feat/FEAT-033-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Report: `acceptance-report.md`. RTM Test ref appended for ONB-07, CHN-11, CHN-14, CHN-02 (partial). Design ref for those rows still lacks FEAT-032's design docs (design column; append in a later design session).

## E2E lessons from the local CI runs (for future specs)
Four runs, four test faults, no product defect. Each cost Ken a full CI run; check these when writing a spec:
- **Cross-origin refusals:** Chromium and WebKit report a cross-origin response without a CORS header as `requestfailed`, never `response`, so `waitForResponse` hangs (Firefox does emit it). Read such answers through `page.route` + `route.fetch()` (it keeps the page's Origin); see `configAnswer` in `widget-install.e2e.ts`.
- **Harness globals:** WebKit's trace adds `__playwright_*` globals to the page; filter them out of "no globals added" checks.
- **Text patterns:** a status line rendered as `{busy && <span/>} {caption}` starts with a space, so `getByText(/^…/)` never matches. Prefer the element's role (`getByRole('status')`) with `toHaveText` and an unanchored pattern; wait for the in-progress text first so an earlier result can't pass.
- **Queue-backed steps:** anything waiting on a worker (detection, crawl, extraction) needs `test.setTimeout` above the default 60 s, as the ingest specs do.
- **Shared dev tenant:** a test that removes shared state part-way (an allowed origin) must restore it in `afterEach` on failure, or the next browser's whole run fails (18 Firefox specs did) and leaves data that breaks later specs. After a failed run, `pnpm stack:reset` + `pnpm db:setup` before the next one.
- **Verify in a cloud session:** run the new spec's tricky steps in the pre-installed Chromium against the widget dev server with a stubbed config (as done for AC-8) before asking Ken for CI; it catches most of the above.

## Left to later
- Lighthouse ≤ 2-point check (CHN-02): M2 close (D1, pending-actions).

## Pending for Ken
- None for this feature. FEAT-033 waits for Ken's go.
