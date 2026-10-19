# @kaki/widget

The embeddable chat widget (ADR-016): a small loader (`dist/w/v1/loader.js`, budget 14 KB gz) that renders a launcher into a closed Shadow DOM and lazily imports the Preact chat panel (`panel.js`).

## Embed snippet

```html
<script async src="https://<cdn>/w/v1/loader.js" data-key="<widget key>"></script>
```

`data-api` overrides the API origin (the default is the loader's own origin). The API answers the config request only for a known key, on an allowed origin, of an active tenant (the channel go-live check arrives with FEAT-034); otherwise the loader stays silent and the host page is untouched (NFR-14).

## Development

`pnpm dev` (from the root, or `pnpm --filter @kaki/widget dev`) rebuilds on change and serves a dev host page at http://localhost:5175 with deliberately hostile CSS (`dev/hostile.css`). `WIDGET_API_URL` and `WIDGET_DEV_KEY` set the page's snippet.

`pnpm build && pnpm size` checks the budgets in `.size-limit.json`.

The widget uses only `--kaki-*` variables from `@kaki/design-tokens/widget`, never hard-coded values (design.md §4.9).
