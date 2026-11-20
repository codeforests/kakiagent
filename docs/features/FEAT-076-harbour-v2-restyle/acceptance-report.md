# Acceptance report: FEAT-076 — Harbour v2 restyle

> Verified 2026-11-20 · Branch `feat/FEAT-076-harbour-v2-restyle` · PR https://github.com/codeforests/kakiagent/pull/75 · Head audited: `4b36020` (GitHub CI run 144, all green, attempt 1)
> **Independence note:** this verify ran in the same session that designed and built the feature (Ken asked for it in that thread), not in a fresh session as `feature-stage` intends. To compensate, every check was re-run fresh with Turbo's cache bypassed, the E2E and axe evidence comes from GitHub CI, and the one judgement call (the phone viewport, below) rests on an A/B against `main`.

## Verdict

**Accepted.** Every AC (technical-design §6) is met on `4b36020`. CI run 144 is green in every job, including E2E on Chromium, Firefox and WebKit with the new `harbour-v2.e2e.ts`. The only changes made during verify were to the new spec (its viewport and wait), never to production code or to an existing test.

## Audit standard

technical-design §6 (AC-1…AC-10), ui-design (SCR-APP-024 states, shell and components), design.md v2 §2.2, §4.1, §4.3–§4.5, §4.9, AGENTS.md invariants (widget isolation), Ken's decisions D9–D11 (mockup approved, teal selected inbox row, success alert on ready sources).

## Audit table

| AC | Tests | Asserts the criterion? | Result |
|---|---|---|---|
| AC-1 Inter self-hosted | `harbour-v2.e2e` "Inter is served from the dashboard and operator origins…": `document.fonts.check('500 14px Inter')` (dashboard) and `600` (operator) are true, every `.woff2` request is same-origin, no `fonts.googleapis.com`/`gstatic.com` request. Verify build: `apps/dashboard/dist` and `apps/operator/dist` each hold exactly 4 `inter-latin-*.woff2`, no `.woff`, no Google Fonts reference | Yes | Pass |
| AC-2 Widget unchanged | `pnpm size` PASS (fresh); no `.woff*` in `apps/widget/dist`; `git diff origin/main...HEAD -- apps/widget` is empty; the widget doesn't depend on `@kaki/ui` | Yes | Pass |
| AC-3 Selection by fill | `harbour-v2.e2e` "selection is the neutral fill…": the Knowledge nav link has `aria-current="page"`, background = `--color-bg-fill`, color = text-primary; at 375 px the active tab-bar icon pill = fill | Yes | Pass |
| AC-4 Segmented tabs | Same test: the Knowledge "Sources" tab has the fill, `border-bottom-width: 0`, 12 px radius; at 375 px `/inbox` has no sideways scroll. The existing `inbox.e2e` views-fit check (FEAT-075 AC-4, at 1440 and 1024) passed on all three browsers in runs 143 and 144 | Yes | Pass |
| AC-5 Alerts | `harbour-v2.e2e` Source test: the success alert has a 1 px border and 16 px radius, its `background-image` contains `--color-success-soft`, and `::before` is 20 px. No alert copy changed (production diff touches no alert text; the existing alert-text assertions in all specs pass) | Yes | Pass |
| AC-6 Badges, cards, headers, buttons, titles | Build-stage stubbed scripts (tasks.md T2, T6): secondary border `#D7D7D7`, ghost text `#191919`, badge 24 px / 8 px, section card 24 px radius and padding, `th` transparent, title −0.56 px. No E2E asserts each one; rendered by every E2E screen visit and checked by axe | Partly by E2E; directly measured | Pass |
| AC-7 meta-grid and event-timeline | `harbour-v2.e2e` Source test (stubbed processing/ready/failed details): the meta-grid shows Status, "Not yet", "Confirmed by you on…"; the "Steps" list has 5 items with exactly one `aria-current="step"` ("Find facts", "In progress · 18 of 38"); ready shows Finished; failed shows "Stopped here" and "Failed". Unit: `sources.test.ts` (11 cases: steps per kind, current/waiting/retry/map captions, ready and failed endings, banned words) and `timeline.test.ts` (3 cases: `<ol>` label, one current step, empty live region on first render) | Yes | Pass |
| AC-8 Source states and existing texts | Existing `sources.e2e`, `files.e2e`, `spreadsheets.e2e`, `chats.e2e` pass unchanged on all three browsers (the strict `'Ready'` exact, `'Facts found'`, `'Pages read'`, malware text, `.source-figures`, `page-table`, Retry). The new spec covers processing, ready (with the D11 success alert and "Review facts" → `/review`) and failed with Retry | Yes | Pass |
| AC-9 axe | `harbour-v2.e2e`: Source in each state at 1440 and 375 × 5000; Home, Inbox, Knowledge, Sources, Team at 1440 and 375 × 5000; operator console at 1440. No serious or critical issues on Chromium, Firefox or WebKit (run 144) | Yes, after the viewport correction below | Pass |
| AC-10 Existing E2E unchanged | `git diff origin/main...HEAD -- e2e/tests` adds only `harbour-v2.e2e.ts`; run 144: every spec passes on all three browsers | Yes | Pass |

## Changed tests during verify (reviewed, not weakened)

- **Run 143** (`2e7d4d3`): the new axe loop failed on all three browsers with `target-size` at 375 × 812, each time on whichever control sat under the sticky tab bar ("at its bottom: a.tab-bar-item"). An A/B on stubbed `/knowledge` built from `main` and from the branch gave the same result on both: a violation at 375 × 812 and none at 375 × 5000. That makes it a viewport artifact, not a FEAT-076 regression. The other phone-width axe checks in the suite already use 375 × 5000 (`team.e2e` "tall, so the tab bar covers nothing", `account`, `audit-log`, `inbox-search`…). Fixed in `386a6fc` (PHONE = 375 × 5000, with the A/B written into the spec's comment).
- `4b36020`: before axe, the loop now waits for no `main [aria-busy="true"]`, so it runs on settled pages, as the other specs do by waiting for content. Loading skeletons carry `aria-label` on a role-less `div` (pre-existing on `main`; seen on Team's "Loading two-step verification"), which axe flags as `aria-prohibited-attr` while they show. Follow-up below.
- **Telegram spec, Chromium, run 143:** "Check again" stayed at 429 with the channel re-marked degraded every ~10 s. This is the known CI-only case in STATE.md (runs 135, 137); FEAT-076 changes no channel code, and the spec passed on WebKit in run 143 and on all browsers in run 144.
- **Production code untouched in verify:** `git diff 2e7d4d3 4b36020 --stat` changes only `e2e/tests/harbour-v2.e2e.ts`.

## Independent execution

Fresh, cache bypassed, at `2e7d4d3` (production code identical to `4b36020`):

- `pnpm format:check` PASS
- `pnpm turbo run lint --force` PASS
- `pnpm boundaries` PASS
- `pnpm rtm` PASS
- `pnpm turbo run typecheck --force` PASS
- `pnpm --filter @kaki/e2e typecheck` PASS
- `pnpm turbo run test --force` PASS (172 files, 1,947 tests)
- `pnpm turbo run build --force` PASS
- `pnpm size` PASS

After the spec edits: `pnpm --filter @kaki/e2e typecheck` and `pnpm format:check` PASS.

## Direct verification

- **Invariants:** no schema, RLS, contract, endpoint, outbox, model or channel change (`git diff --stat` touches no `packages/db`, `contracts`, `apps/api`, workers or `llm-gateway`). The widget is untouched and keeps only `--kaki-*` variables (ADR-016). Dashboard and operator CSS use token variables only; the only computed colours are `color-mix` of two tokens in the operator chrome (D7: current item 11.5:1, idle 11.0:1).
- **Module boundaries:** `@kaki/ui/fonts.css` is declared in `package.json` `exports` and in `.dependency-cruiser.cjs` beside `styles.css`.
- **Design deviations,** recorded in tasks.md and technical-design D12 and judged acceptable:
  - section cards are any `section.card`;
  - alert actions stay under their text;
  - the Source page filter stays a `<select>`;
  - the timeline shows on website and file sources (spreadsheets and chats render SCR-APP-025/026);
  - files label the date "Uploaded".
- **NFR-09:** axe-clean on the touched screens in three engines (above). WCAG 1.4.11 for fill-only selection goes to the M6 manual audit (technical-design O1); forced-colours outlines are in place.

## Follow-ups (not blocking)

- Loading skeletons with `aria-label` on a role-less element (`team.tsx`, `account.tsx`, `approval.tsx`, `assistant.tsx`, `business-profile.tsx`, `channels.tsx`, `audit.tsx`, `coach.tsx`): give them `role="status"` so axe passes mid-load. Pre-existing; for Ken's backlog.
- The sticky tab bar covers content at the bottom of short phone viewports, so axe's target-size flags whatever sits there. Pre-existing on `main`; worth a look at M6 together with O1.
- Telegram "Check again" 429 in CI: unchanged, already tracked in pending actions.

## RTM

`node scripts/check-rtm.mjs FEAT-076 --stage verify`: `RTM check passed (FEAT-076).`

Test refs appended: KB-12 (partial: status shown as an event-timeline on SCR-APP-024 for website and file sources), NFR-09 (partial: the v2 restyle is axe-clean on the touched APP and OPS screens at 1440 and 375 px).

## CI

- GitHub CI run 144 at `4b36020`, 2026-11-20: all jobs green on attempt 1. Covers format/lint/boundaries/typecheck, unit, integration with coverage, build and size, eval, scanning, Terraform, and E2E on Chromium, Firefox and WebKit.
- Run 143 at `2e7d4d3`: red only on the new spec's phone axe viewport (all browsers) and on the known Telegram 429 (Chromium); both are explained above.
