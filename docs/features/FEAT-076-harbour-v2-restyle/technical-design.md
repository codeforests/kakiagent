# Technical design: FEAT-076 — Harbour v2 restyle

> Implements: KB-12 (p: a source's status shown as an `event-timeline` on SCR-APP-024), NFR-09 (p: the v2 restyle keeps the dashboard and operator console at WCAG 2.1 AA) · Realizes: UC-03 (step 5: "showing progress per source") · Screens: SCR-APP-024 (p: `meta-grid`, `event-timeline`); every SCR-APP and SCR-OPS screen (p: styling) (see [ui-design.md](ui-design.md)) · Module: `packages/ui`, `apps/dashboard`, `apps/operator`; no endpoint, contract, schema or widget change
> Status: designed · 2026-11-17 · Owner request (Ken, 2026-11-17): apply design.md v2 (PR #73) with the same functionality; Ken approves the mockup ([mockup/harbour-v2-mockup.html](mockup/harbour-v2-mockup.html)) before any build

## 1. Intent

Harbour v2 (design.md v2, §9) changed token values and component shapes. The token values already reach the apps, because the app CSS is generated from `tokens.json`. The shapes don't: today the app shows v2 colours, Inter as a font name that isn't loaded, and v1 components (teal selection, underlined tabs, full-round chips, flat soft alerts, grey table headers). This feature makes the dashboard and the operator console match design.md v2:

1. Self-host Inter (WOFF2: 400, 500, 600 and 400 italic, Latin subset) from the app's own origin.
2. Restyle the shared and app components listed in design.md §9: nav-item, tab-bar-item, segmented `tabs`, gradient-edge `alert`, 24 px `status-badge`/`chip` with `--radius-chip`, section cards with `--radius-2xl`, table headers without fill, secondary and ghost buttons, page titles with `--type-heading-tracking`.
3. Add the new `meta-grid` and `event-timeline` components and use them on SCR-APP-024 (Source).

Out of scope: the widget (`apps/widget`; its neutral tokens are pinned to v1, design.md §4.9), any copy change E2E tests rely on, any endpoint, contract or schema change, dark mode (FEAT-074), IBM Plex Mono self-hosting (mono keeps its system fallbacks; design.md doesn't require it to be bundled), the operator's tenant table (FEAT-070).

## 2. Codebase context

- **Tokens:** `@kaki/design-tokens` builds `tokens.css` from `docs/02-design/tokens.json`. v2 tokens exist: `--color-bg-fill`, `--radius-chip` 8, `--radius-md` 12, `--radius-lg`/`-xl` 16, `--radius-2xl` 24, `--type-heading-tracking`/`--type-display-tracking` −0.02em, heading 28/34 weight 500, `--font-family-sans` starting with `Inter`. No token change is needed.
- **Fonts:** no `@font-face` and no font file anywhere in `apps/dashboard`, `apps/operator` or `packages/ui`; `Inter` in the stack resolves to a system fallback today.
- **Shared styles:** `packages/ui/src/styles.css` (227 lines): `.kaki-btn--*`, dialogs, `kaki-state`. Secondary uses `--color-border-strong`; ghost uses accent text and accent-soft hover (v1).
- **Dashboard styles:** `apps/dashboard/src/app.css` (~6,750 lines). Anchors: `.nav-item` ~111 (active = accent-soft/accent), `.tab-bar-item` ~129 and ~3166, `.page-title` ~392, `.status-badge` ~2063 and tones ~2762, `.fact-table th` ~2105 (subtle fill), `.card` ~2211, `.alert` ~2302 (flat soft fills, no border, no icon), `.chip` ~2385 (radius-full, 20 px), `.tabs`/`.tabs__tab` ~2541 (underline), `.knowledge-tabs` ~2734, `.inbox__views` ~598–640 (FEAT-075 underline), `.nav-item__count` ~2759, `.privacy-table thead th` ~4561 and `.team-table thead th` ~5303 (subtle fill). 49 rules use `background: var(--color-bg-subtle)`; only table headers among them change.
- **Shell:** `apps/dashboard/src/shell/app-shell.tsx`: sidebar `NavLink.nav-item` (icon, `.nav-item__label`, `NavCount`), tab bar `NavLink.tab-bar-item` (`Icon size={24}`, label, `NavCount`).
- **Source page:** `apps/dashboard/src/pages/source.tsx` (437 lines): head = title, URL line, "Confirmed by you on …", file line, "Checked for malware: none found", `SourceState` badge (from `pages/sources.tsx`); `section.card.source-status` with stage text and `SourceProgress` while busy, `dl.source-figures` when ready, danger alert with Retry when failed; pages table `fact-table page-table`. Helpers in `lib/sources.ts`: `STAGE_LABEL`, `stageLabel`, `stageProgress`, `sourceSummary`, `waitingToMap`. `Source` contract: `kind`, `status` (queued/processing/ready/failed), `stage` (scan/parse/map/import/crawl/extract/promote, nullable), `createdAt`, `updatedAt`, `finishedAt`; there are **no per-stage timestamps**.
- **Stage order** (`packages/kb/src/ingest/job.ts`): website crawl → extract → promote; file scan → parse → extract → promote; chat scan → parse → extract → promote; spreadsheet scan → parse → map (waits for the owner) → import → promote.
- **Operator console:** `apps/operator/src/shell.tsx` is a placeholder shell (dark sidebar of six plain list items, "Operator console" label, `h1` Tenants and an empty state); `app.css` 58 lines.
- **E2E text the restyle must keep** (Playwright `getByText` is a case-insensitive substring match and strict): Source page `'Ready'` exact once (`sources.e2e.ts:58`), `'Facts found'`, `'Pages read'`, `'Checked for malware: none found'`, `'1 read with OCR'`, `'No pages were read.'`, `.source-figures` (`spreadsheets.e2e.ts:142`), `data-testid="page-table"`; tabs by `getByRole('tab', { name })` with `aria-selected` (`assistant.e2e.ts`, `widget-install.e2e.ts`).

## 3. API contracts

None. No endpoint, request or response changes. The timeline is computed from fields `GET /api/v1/kb/sources/:id` already returns.

## 4. Schema changes

None.

## 5. Component design

### 5.1 Inter, self-hosted (design.md §2.2)

- Add `@fontsource/inter` at an exact version (`5.2.8`, Renovate updates it) to `packages/ui` `dependencies`. New `packages/ui/src/fonts.css` imports only `@fontsource/inter/latin-400.css`, `latin-500.css`, `latin-600.css` and `latin-400-italic.css` (each declares `font-family: 'Inter'`, `font-display: swap`, a Latin `unicode-range` and a relative `url()` to its WOFF2). Export it as `@kaki/ui/fonts.css` in `packages/ui/package.json` `exports`.
- `apps/dashboard/src/main.tsx` and `apps/operator/src/main.tsx` import `@kaki/ui/fonts.css` before the tokens. Vite copies the four WOFF2 files into each app's `dist/assets/` and rewrites the URLs, so fonts load from the app's own origin. Nothing loads from Google Fonts; no `<link>` to another origin.
- No preload (four small files, `swap`); revisit only if CLS shows up.
- The widget never imports `@kaki/ui` (`apps/widget/package.json`), so its bundle and budget don't change (ADR-016, NFR-02).

### 5.2 Shared components (`packages/ui/src/styles.css`)

- `.kaki-btn--secondary`: surface fill, `1px solid var(--color-border-default)`, text-primary; hover `--color-bg-subtle`; `:active` `--color-bg-fill`.
- `.kaki-btn--ghost`: transparent, **text-primary** (was accent); hover subtle; active fill.
- Add `.kaki-btn:active` for primary (`--color-accent-active`) if absent. Disabled and loading rules unchanged.
- New `meta-grid` and `event-timeline` styles (§5.6, §5.7) live here, since both surfaces may use them.

### 5.3 Dashboard shell

- `.sidebar`: canvas background, no border or fill of its own. `.nav-item`: height 32 (`--size-control-sm`; 44 under `pointer: coarse`), padding 0 × 12, `--radius-md`, gap 8, icon 18, idle text-secondary, hover subtle + text-primary, `.active` (`aria-current="page"` from `NavLink`) **`--color-bg-fill` + text-primary**, no accent.
- `.nav-item__count`: `--radius-chip`, caption 500; neutral counts on `--color-bg-fill`/text-secondary, review warning-soft/warning, approvals pending-soft/pending, failed danger-soft/danger (the existing tones from `lib/nav-counts.ts`).
- `.tab-bar-item`: wrap the icon in `<span className="tab-bar-item__icon">` (48 × 28, `--radius-md`) in `app-shell.tsx`. Active: text-primary, the icon wrapper on `--color-bg-fill`. The count stays at the icon's top-right.
- Forced colours: `.nav-item.active` and the active tab-bar icon get `outline: 1px solid CanvasText` under `@media (forced-colors: active)`, because a fill disappears there.

### 5.4 Segmented tabs

- `.tabs`: no bottom border, `display: flex`, gap 4, `overflow-x: auto`, never wraps.
- `.tabs__tab`: min-height 32 (44 touch), padding 0 × 12, `--radius-md`, body 500, idle transparent/text-secondary, hover subtle, `[data-state='active']` (Radix) and `.active` (`knowledge-tabs` NavLinks) and `[aria-selected='true']` → `--color-bg-fill` + text-primary. No underline. Counts inside a tab use a neutral pill (`--radius-chip`, fill; on the active tab, surface).
- Remove the per-instance underline overrides: `.knowledge-tabs .tabs__tab.active` and the FEAT-075 `.inbox__views .tabs__tab[data-state='active']` block (~598–640), keeping only their layout rules (the inbox phone "More ▾" menu is unchanged).
- Forced colours: active tab gets a 1 px `CanvasText` outline.
- Keep the FEAT-050 pitfall: an `sr-only` count inside a scrolling tab row needs `position: relative` on the tab.

### 5.5 Alerts, badges, cards, tables, titles

- **`.alert`** (design.md §4.3): grid `20px 1fr` (+ `auto` for a trailing action when one is the last child link/button at ≥ 640), gap 4 × 12, padding 16, `--radius-lg`, `1px solid var(--color-border-default)`, background `linear-gradient(90deg, var(--color-<tone>-soft) 0%, var(--color-bg-surface) 40%)`. The icon is a `::before` (`content: ""`, 20 px, `background: var(--color-<tone>-default)`, `mask` of an inline SVG data URI: info circle, check circle, warning triangle, x-circle), so **no page markup changes** and screen readers read nothing extra. Children sit in column 2. `.alert__title` becomes the lead phrase (body size, weight 500, text-primary); when an alert has a title, its other text is text-secondary (`.alert:has(.alert__title) > :not(.alert__title)`); an alert without a title keeps text-primary (its single sentence is the lead, D3). Remove `.alert__title`'s title-sm size. Under `forced-colors` the border carries the boundary and the gradient drops.
  Contrast (checked against tokens): text-secondary on each `-soft` ≥ 7.2:1, text-primary ≥ 15:1.
- **`banner`** keeps its full-width soft fill (design.md §4.3 didn't change it).
- **`.chip` and `.status-badge`**: height 24 (`min-height: var(--space-7)`), padding 0 × 8, `--radius-chip`, caption 500. Neutral tones on `--color-bg-fill` + text-secondary (was subtle). Existing leading dots/icons stay; badges that lack an icon keep their text (design.md §2.4 icon pairing is unchanged scope).
- **Section cards**: new modifier `.card--section` (`--radius-2xl`, padding 24; 16 below 640). Apply it to every `.card` that is a page section holding a table or a form group (design.md §4.4); small cards (KPI tiles, list cards, review cards, setup-step cards inside a section) stay `.card` (16). The build lists the files it touched in `tasks.md`.
- **Table headers**: every `thead th` loses its fill; caption size 500, text-secondary, `border-bottom: 1px solid var(--color-border-default)` (`fact-table`, `page-table`, `privacy-table`, `team-table`, `audit` table, `confirm-table` and any other `th` rule with `--color-bg-subtle`). Row hover subtle, selected accent-soft (unchanged rule).
- **Page titles**: `.page-title` adds `letter-spacing: var(--type-heading-tracking)` and `text-wrap: balance`; weight comes from `--type-heading-weight` (500). The display step (wizard titles, KPI values) adds `--type-display-tracking` wherever `--type-display-size` is used.

### 5.6 `meta-grid` (`packages/ui`)

`MetaGrid({ items: { label: string; value: ReactNode; testId?: string }[] })` renders `<dl class="meta-grid">` with one `<div>` per pair (`<dt>`, `<dd>`). CSS: `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))`, gap 16 × 24, `dt` 12 px uppercase overline (0.04em, text-secondary), `dd` body text, `overflow-wrap: anywhere`. Margin below 32.

### 5.7 `event-timeline` (`packages/ui`)

`EventTimeline({ label: string; steps: TimelineStep[]; announce?: string })` with `TimelineStep = { key: string; label: string; icon: IconName; state: 'done' | 'current' | 'waiting' | 'success' | 'failed'; time?: string; detail?: string }`.

- Markup: a `div.timeline-well` (canvas fill, `--radius-lg`, 1 px border-default, padding 32 (20 below 640), `background-image: radial-gradient(var(--color-border-default) 1px, transparent 1px)`, `background-size: var(--space-4) var(--space-4)`) containing `<ol aria-label={label}>`; each `<li>`: a 48 px node (surface, 1 px border-default, `--radius-lg`, 20 px Lucide icon in text-secondary; `current`: info colour border and a spinner icon, still under reduced motion; `success`/`failed`: success/danger icon), a `status-badge` naming the step (done: neutral with a check; current: info; waiting: neutral; success: success; failed: danger), and a caption (`time` or `detail`, text-secondary, tabular). The `current` step carries `aria-current="step"`.
- Layout: equal columns joined by a 1 px border-default line at ≥ 640; stacked rows with a vertical line below.
- `announce` renders into a visually hidden `aria-live="polite"` span that is empty on first render and set only when the current step changes (design.md §4.4).
- Icons: the component takes an icon name from a small inline Lucide set in `packages/ui` (plus, globe, file, shield-check, file-search, table, columns, sparkles, save, flag, check-circle, x-circle, loader). No icon package is added.

### 5.8 Source page (SCR-APP-024)

- **Pure helper** `sourceTimeline(source): TimelineStep[]` in `lib/sources.ts` (unit-tested):
  - Steps by kind: website `added, crawl, extract, promote, end`; file and chat `added, scan, parse, extract, promote, end`; spreadsheet `added, scan, parse, map, import, promote, end`.
  - Labels: Added · Malware check · Read file · Map columns · Import rows · Read pages · Find facts · Save facts · Finished (or Failed). Chat exports: parse "Remove personal data", extract "Find questions". None contains "Ready", "Facts found" or "Pages read" (E2E strictness, §2).
  - `added`: done, `time` = `createdAt`. Steps before `stage`: done ("Done"). `stage`: `current` with `detail` = today's `sourceSummary` text minus its stage words (e.g. "18 of 38", "waiting to retry", "Waiting for you"); for `status: 'failed'` the stage step is `failed` ("Stopped here"). Later steps: waiting ("Waiting"). `queued` with `stage: null`: only Added done. `ready`: all done, `end` = success "Finished" with `time` = `finishedAt ?? updatedAt`. `failed`: `end` = failed "Failed" with that time.
  - `announce` text: `Step N of M: <label>, in progress` (never the badge words alone).
  - Time format: the existing `updatedLabel` helper.
- **Head:** title stays the `h1.page-title`; under it the website URL link stays as a sub-line. The other lines become a `MetaGrid`: Status (`SourceState`, moved from the head's right, so "Ready" appears once), Type (`FILE_TYPE_LABEL` + size, or "Website" + page limit, or chat type), Added, Finished ("Not yet" while busy), Ownership ("Confirmed by you on …", websites with `attestedAt`), Safety ("Checked for malware: none found", files with `scannedAt`, exact text kept). The existing Retry/Delete placement is unchanged.
- **Progress section:** `section.card.card--section.source-status` with `h2` "Progress": the failed danger alert (unchanged copy and Retry/Upload again), then `EventTimeline`, then while busy the stage line and `SourceProgress` (unchanged), and when ready `dl.source-figures` (unchanged copy and class).
- No new success alert in this feature (D4, pending Ken's answer to question 3).
- **Pages section:** becomes `card--section`; its filter tabs take the segmented style; the table keeps `data-testid="page-table"`.

### 5.9 Operator console

- `apps/operator/src/shell.tsx`: each nav entry becomes `<span className="nav-item">` with an 18 px icon (the same inline set) inside its `<li>`; Tenants gets `aria-current="page"` (the list has no links until FEAT-070). `h1` gets `className="page-title"`.
- `app.css`: the dark sidebar stays (design.md §4.9). Items: 32 px, `--radius-md`, idle text `color-mix(in srgb, var(--color-bg-surface) 78%, var(--color-text-primary))`, current item background `color-mix(in srgb, var(--color-bg-surface) 14%, var(--color-text-primary))` with surface text (token-derived, no literals; ≥ 4.5:1 checked in T8). `.ops__label`: `--radius-chip`, `--color-bg-fill`, text-secondary. Topbar on canvas.

## 6. Acceptance criteria

| AC | Criterion | Traces to |
|---|---|---|
| AC-1 | The dashboard and operator console render text in Inter loaded from their own origin: `document.fonts.check('500 14px Inter')` is true after load, the four WOFF2 requests are same-origin, and no request goes to `fonts.googleapis.com` or `fonts.gstatic.com`. | design.md §2.2 |
| AC-2 | The widget build is unchanged: `apps/widget/dist` has no WOFF2 and `pnpm size` passes with the same budgets. | design.md §4.9, NFR-02 |
| AC-3 | The active sidebar item and the active tab-bar item use `--color-bg-fill` with text-primary and no accent colour; `aria-current="page"` is kept. | design.md §4.5 |
| AC-4 | Every `tabs` instance (Radix tabs, Knowledge tabs, inbox views) is segmented: no underline, the selected tab has `--color-bg-fill` and text-primary; at 375 px tab rows scroll and the page has no horizontal scroll. | design.md §4.4, INB-06 layout rule |
| AC-5 | Alerts have a 1 px border-default, `--radius-lg`, the leading-edge gradient of their tone, and a tone icon; no alert's text content changes. | design.md §4.3 |
| AC-6 | `chip`/`status-badge` are 24 px tall with `--radius-chip`; section cards have `--radius-2xl`; table headers have no fill; secondary buttons have a border-default border and ghost buttons text-primary; `.page-title` has `--type-heading-tracking`. | design.md §4.1, §4.4, §2.2 |
| AC-7 | SCR-APP-024 shows a `meta-grid` under the title (status, type, added, finished, and ownership or safety where they apply) and an `event-timeline` whose steps follow the source's kind and status (§5.8), with `aria-current="step"` on the step in progress. | KB-12, design.md §4.4 |
| AC-8 | Source states stay covered (NFR-19): processing, waiting to map, waiting to retry, ready, failed (with Retry or Upload again), loading, error, not found; the existing Source E2E texts still match once. | KB-12, NFR-19 |
| AC-9 | axe reports no serious or critical issues on Home, Inbox, Source (each state reachable in E2E), Knowledge, Settings › Team and the operator console at 1440 and 375 px. | NFR-09 |
| AC-10 | Every existing E2E spec passes on Chromium, Firefox and WebKit without edits to its assertions. | Plan §4 row FEAT-076 |

## 7. Decisions

- **D1 — Inter through `@fontsource/inter` (pinned), not committed font files.** The package ships the OFL WOFF2 files with ready Latin-subset CSS; Vite bundles them to the app origin, and Renovate keeps the version current. Only the four needed faces are imported.
- **D2 — Timeline times only where the API has them.** `Source` has no per-stage timestamps and FEAT-076 adds no endpoint or column, so Added shows `createdAt`, Finished/Failed shows `finishedAt` (or `updatedAt`), and the steps between say Done, In progress (with the existing progress words) or Waiting. Per-stage times would need a schema change (a possible follow-up, not proposed).
- **D3 — Alert icons and lead styling from CSS only.** The icon is a masked `::before`; `.alert__title` is the lead phrase. No alert markup or copy changes, which keeps ~60 alerts and their E2E texts untouched.
- **D4 — No new outcome copy on Source unless Ken says so.** design.md suggests pairing the timeline with an outcome alert. Failed already has one; zero-facts already has an info alert. A success alert for a ready source with facts ("Finished reading 38 pages. 6 of the 41 facts need your review." + "Review facts") is drawn in the mockup and asked as question 3; without a yes, the figures stay the outcome.
- **D5 — Inbox view tabs follow v2.** FEAT-075 approved underlined view tabs before v2; design.md v2 (signed off later) makes every `tabs` segmented, so the inbox views change too. Labels, counts, keyboard behaviour and the phone More menu are unchanged.
- **D6 — Selected list rows keep `--color-accent-soft`.** design.md §4.4 keeps this for tables and lists, so the inbox's selected row stays teal-tinted; only navigation and tabs use the grey fill. Asked as question 2.
- **D7 — Operator chrome colours derived from tokens with `color-mix`.** The dark sidebar needs a lighter fill and a muted text that tokens.json doesn't define for light mode; `color-mix` of surface and text-primary keeps "token variables only" without adding tokens.
- **D8 — One build session, UI only.** No backend layer; nine tasks, split by component so each is checked by a stubbed-API Playwright script.

## 8. Escalations and open items

- **E1 (for Ken, mockup review):** approve the v2 look on Source, Home, Inbox, operator Tenants and the phone views (question 1); selected inbox row teal tint or grey fill (question 2, D6); success alert on a ready source (question 3, D4).
- **O1 — WCAG 1.4.11 for selection by fill.** `--color-bg-fill` on the canvas is 1.19:1, so the selected nav item and tab are marked by the fill, the darker text, `aria-current`/`aria-selected` and, in forced colours, an outline. axe doesn't test this. Recorded for the M6 manual audit (plan §7); no design.md change proposed.
- **O2 — `accent` on `--color-bg-fill` is 4.41:1** (below 4.5). No link sits on a fill in this design; the build must not put link-coloured text on the fill (selected tabs and nav use text-primary).
- **O3 — IBM Plex Mono** stays unbundled (system mono fallbacks), as today.

## 9. Self-check

- Visual only: no endpoint, contract, schema or requirement text change; KB-12 and NFR-09 are cited as partial because the timeline is a new presentation of KB-12's status and the restyle must keep NFR-09.
- Widget untouched (no `@kaki/ui` import, pinned v1 tokens).
- Every value comes from tokens; the only computed colours are `color-mix` of two tokens (D7) and the alert icon masks (shape only).
- E2E texts and test IDs that the existing specs use are listed in §2 and kept (§5.8).
- All data states of SCR-APP-024 keep a next action (Retry, Upload again, Map columns, Add a fact).
