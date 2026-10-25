# @kaki/widget

The embeddable chat widget (ADR-016): a small loader (`dist/w/v1/loader.js`, budget 14 KB gz) that renders a launcher into a closed Shadow DOM and lazily imports the Preact chat panel (`panel.js`).

## Embed snippet

```html
<script async src="https://<cdn>/w/v1/loader.js" data-key="<widget key>" data-api="https://<api>"></script>
```

The dashboard shows the exact line on Settings → Website widget and the setup step "Add to your website" (FEAT-032). `data-api` is the API origin (`PUBLIC_API_URL`; without it the loader uses its own origin, which only works when the api serves the loader). The API answers the config request only for a known key, on an allowed origin, of an active tenant (the channel go-live check arrives with FEAT-034); otherwise the loader stays silent and the host page is untouched (NFR-14).

## Outputs (`dist/w/v1`)

| File | What it is |
|---|---|
| `loader.js` | The IIFE sites load. Fetches the config, applies the theme as one constructed sheet on the shadow host, follows the page's light/dark and colour changes live (media query plus a debounced observer), and places the launcher bottom-right or bottom-left, with the logo if one is set. |
| `panel.js` | The chat panel, imported on first open. |
| `preview.html` + `preview.js` | The dashboard's preview iframe (`sandbox="allow-scripts"`). It posts `{ type: 'kaki-preview-ready' }` to its parent, then renders whatever valid `{ type: 'kaki-preview', theme, botName, greeting, scheme?, site? }` it receives (`src/preview-message.ts`); composer disabled. |
| `detect.js` | Sets `window.__kakiDetect`; the ingest-worker evaluates it in Chromium on the tenant's site to detect accent, font, radius and scheme (ADR-016 decision 5). |

## Theme

The look resolves per token as owner override > live page > stored detection > default, then the accent is clamped to WCAG AA for the scheme in use (`@kaki/channels/theme`: `resolveTheme`, `clampAccent`). The dashboard uses the same `clampAccent` for its "Adjusted to … so text stays readable" note. Fonts are only ones the site already loads; nothing is downloaded.

## Development

`pnpm dev` (from the root, or `pnpm --filter @kaki/widget dev`) rebuilds on change and serves a dev host page at http://localhost:5175 with deliberately hostile CSS (`dev/hostile.css`). `WIDGET_API_URL` and `WIDGET_DEV_KEY` set the page's snippet.

Fixture host sites for theme matching are served at http://localhost:5175/sites/{wordpress,wix,shopify,plain}.html (from `dev/sites/`, snippet filled in; each file's comment lists the accent, font, radius and scheme it should resolve to). The ingest-worker's theme-probe test and the E2E spec `widget-install.e2e.ts` use them; the dev tenants allow `http://localhost:5175`.

`pnpm build && pnpm size` checks the budgets in `.size-limit.json`.

The widget uses only `--kaki-*` variables from `@kaki/design-tokens/widget`, never hard-coded values (design.md §4.9).
