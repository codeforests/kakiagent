# ADR-016: Widget — small loader, closed Shadow DOM, runtime theme detection

**Status:** Accepted — Q4 (Shadow DOM) decided by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** CHN-14, CHN-02, CHN-03, CHN-11, CHN-13, NFR-02, NFR-09, NFR-14, ONB-07, ONB-10, AGT-05, AGT-10, GOV-13, GOV-14, UC-05

**Context**
CHN-14: the widget detects the host page's main brand colour, font family, corner radius and light/dark mode, matches them, follows the page when it switches modes, keeps WCAG 2.1 AA contrast, lets the tenant preview and override in the dashboard, and isolates styles in both directions, adding ≤ 5 KB gzipped. NFR-02/CHN-02: ≤ 30 KB gzipped initial load, never blocking rendering, Lighthouse change ≤ 2 points. CHN-11: the widget works only on allowed origins. NFR-14: on old browsers it fails silently without breaking the page.

**Decision**
1. **Bundle split** (esbuild, Preact, budgets enforced in CI with `size-limit`):
   - `loader.js` ≤ **14 KB gz**: bootstrap, config fetch, theme detection (≤ 5 KB), launcher button, tracking (CHN-03, ≤ 3 KB), consent mode.
   - `panel.js` ≤ 35 KB gz, **lazy**: chat UI, SSE client, attachments, accessibility features. Fetched on first open, or after `requestIdleCallback` once the page has loaded.
   - The snippet is `<script async src=".../w/v1/loader.js" data-key="…">`, served from CloudFront with immutable, versioned URLs.
2. **Style isolation:** the widget renders into a custom element `<kaki-agent>` with a **closed Shadow DOM**. `:host { all: initial; }` stops inherited host styles, and all widget styles are constructable stylesheets inside the shadow root, so nothing leaks out. Positioning-critical properties on the host element are set inline with `!important`, which outranks host-page stylesheet rules, and a `MutationObserver` restores them if a host script changes them. Widget CSS variables are namespaced `--kaki-*`.
3. **Theme detection** (runs in an idle callback, typically 2–5 ms):
   - *Mode:* the luminance of the computed `background-color` walking up from `body`/`html`, cross-checked with `color-scheme` and `prefers-color-scheme`.
   - *Brand colour:* `<meta name="theme-color">` first; else the most frequent saturated background colour among visible buttons and primary links (`button`, `[class*=btn]`, `a[class*=button]`, `[role=button]`), with neutral greys ignored.
   - *Font:* the computed `font-family` of `body` and of the first heading; host `@font-face` fonts are usable inside the shadow root because font faces are document-global.
   - *Corner radius:* the median `border-radius` of the sampled buttons.
   - *Contrast guard:* WCAG relative-luminance maths adjusts the brand colour's lightness until text on it reaches 4.5:1 and UI borders reach 3:1 (NFR-09).
   - *Following mode switches:* `matchMedia('(prefers-color-scheme: dark)')` listeners plus a debounced `MutationObserver` on `class`, `style` and `data-theme`/`data-mode` attributes of `html` and `body`; detection re-runs and the widget swaps tokens without re-rendering.
4. **Precedence:** tenant override (per token) > live detection > stored detection > platform defaults.
5. **Dashboard preview (UC-05):** the ingest worker's headless Chromium (ADR-018) opens the tenant's site, injects the *same* detection module, captures tokens and screenshots in light and dark emulation, and stores them as `detected_theme`. The dashboard renders the real widget with those tokens and offers per-token overrides.
6. **Origin enforcement (CHN-11) and go-live (ONB-10):** `GET /widget/config` checks the `Origin` header against allowed origins and the channel's live state. It returns either a "not here" response (the loader stays silent) or the config plus a short-lived **visitor token** (signed, bound to tenant, origin and first-party visitor ID). Every widget API call re-checks the `Origin` header and the token's origin claim. The install check (ONB-07) is the first successful config fetch from an allowed origin.
7. **Fail silently (NFR-14):** the loader feature-detects `attachShadow`, `fetch`, `Promise` and `CSS.supports`; the whole loader runs inside `try/catch`, defines no globals other than `window.__kaki`, and never throws into the host page.

**Options considered**
- **Closed Shadow DOM in the host page (chosen)** — the most faithful theme match (host fonts work), the smallest bundle, and isolation in both directions. Con: scripts on the host page (including the tenant's third-party analytics) could, with effort, read chat contents in the page. The host page is the tenant's own site, and the DPA and privacy-notice template will say so.
- **Cross-origin iframe for the chat panel** — the strongest isolation from host scripts. Lost: host webfonts often cannot load inside the iframe (CORS on font files), so CHN-14's font match fails on many sites; a second document adds load weight; and live theme following needs a `postMessage` protocol.
- **Plain DOM with prefixed CSS classes** — smallest. Lost: host CSS resets (`* { … }`, `button { … }`) break the widget, failing CHN-14's isolation criterion.

**Consequences**
Playwright tests load the widget into fixture copies of WordPress, Wix, Shopify and plain-HTML pages, including hostile CSS, to assert isolation, detected tokens and contrast, and run Lighthouse before and after (CHN-02 acceptance). If the owner prefers iframe isolation (Q4), the panel can move into an iframe while the loader and detection stay as they are; the cost is a weaker font match.
