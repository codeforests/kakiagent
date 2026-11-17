# Design reference: Resend dashboard (signed in)

Captured 2026-11-17 from the built-in browser (resend.com domain detail page, 1440×900, light mode) by reading computed styles. **Reference only, not a design decision.** Nothing here changes `tokens.json` or `design.md`; adopting any of it goes through a UX-foundations amendment and owner sign-off. Take the design language, not Resend's assets: no copying their stylesheet, fonts (ABC Favorit is a licensed typeface), dot-pattern image or icons.

## Measured values

| Element | Resend value | Harbour today (design.md §2) | Gap |
|---|---|---|---|
| Page background | `#fdfdfd` (near-white, neutral) | canvas `#F5F7F9` + white cards | Resend has almost no canvas/card contrast; separation is by border only |
| Text primary / secondary | `#191919` / `#4d4d4d` (pure neutral grey) | `#0F1720` / `#5B6B7C` (cool blue-grey) | Resend is warmer/neutral; Harbour is blue-tinted |
| Border | `#d7d7d7` (gray-3); hover/fill tints are black at 8% (`rgba(0,0,0,.08)`) | `#D9E0E7` | Similar weight; Resend uses alpha-black fills everywhere |
| Body font | Inter, 14/20 for UI text | IBM Plex Sans, body 14/20 | Same scale; family differs |
| Page title | Display face 28/34, weight 500, letter-spacing −0.72px | heading 24/32, weight 600 | Resend title is larger, lighter, tight-tracked |
| Card heading | 20/28 weight 700, −0.16px | title 20/28 weight 600 | Harbour forbids 700 (keep 600) |
| Overline label (CREATED, STATUS) | 12/16, uppercase, weight 400, `#4d4d4d`, no tracking | 12px uppercase, 0.04em tracking | Close already |
| Sidebar | 250px wide, 16px padding, same bg as page, no divider | — | |
| Nav item | 32px tall, 0 12px padding, radius 12, 14px/400, icon 18px, gap 8; idle `#4d4d4d`; **active = `rgba(0,0,0,.08)` fill + `#191919` text**, no accent colour | — | Main trait you liked |
| Segmented tabs | 32px, radius 12, 14px/600; active = 8% black fill + primary text; idle = transparent + secondary text | — | Same recipe as nav |
| Secondary button ("Debug with AI") | 32px, radius 12, 8% black fill, 1px `rgba(0,0,0,.15)` border, 14/500 | radius-md 6 | Resend controls are much rounder |
| Card | 1px `#d7d7d7` border, **radius 24**, padding 24, no shadow | radius-lg 8, padding 20, border, no shadow | Same idea, Resend far rounder |
| Status pill | 24px tall, 0 8px padding, radius 8, 12/16 weight 500, transparent 1px border | radius-full chips + icon | Resend pills are rounded-rect, not full pills |
| Pill — success | text `rgba(0,101,20,.84)` on `rgba(0,151,0,.086)` | | |
| Pill — info | text `rgba(0,109,203,.95)` on `rgba(0,143,245,.098)` | | |
| Pill — neutral | text `#4d4d4d` on `rgba(0,0,0,.08)` | | |
| Success banner | radius 16, padding 16, 1px `rgba(0,147,5,.21)` border, background `linear-gradient(90deg, rgba(0,159,7,.145) 0%, transparent 40%)`; text 14px | | Gradient fade from the left is the distinctive touch |
| Event timeline | 162px area, padding 32, dotted-grid background image, round icon nodes joined by a 1px line, status pill + timestamp under each node | — | Fits KakiAgent's crawl/ingest job progress, channel-connect steps |
| Dark mode | background `#000`, greys `#141517`→`#f0f0f0`, accent flips to white | Harbour has dark mode | Same recipe |

## Traits worth adopting (proposal input)

1. **Neutral grey palette with one alpha-black fill (8%)** for every hover, active nav, active tab and neutral pill. Fewer tokens, consistent feel.
2. **No brand accent in navigation.** Active state is a grey fill, which leaves colour for status only.
3. **Rounder geometry:** controls 12, pills 8, banners 16, cards 24.
4. **Tinted status pills** (alpha tint background + darker same-hue text, no icon border). Keep Harbour's rule that status pairs colour with an icon (NFR accessibility).
5. **Gradient-edge banners** for success/info/warning callouts.
6. **Event timeline component** with a dotted-grid well (draw the dots with a CSS `radial-gradient` token, not Resend's image).
7. **Larger, lighter page titles** (28/34, weight 500, slight negative tracking).

## Constraints to check before adopting

- **Contrast (design.md §5, WCAG AA):** alpha-based pill text must be checked as flattened colours on the real surface; `gen_tokens_css.py` and `pnpm tokens` fail below AA. `#4d4d4d` on `#fdfdfd` passes easily.
- **Weight 700** is banned in Harbour; keep 600 for headings.
- **Font:** Inter is OFL and self-hostable like Plex; switching is a token change plus the self-hosting setup in §2.2 (keep the CJK fallbacks).
- **Widget** uses only `--kaki-*` variables (ADR-016); decide whether the restyle touches the widget or only the dashboard and operator console.
