# UI design: FEAT-029 — Web context and first-party intent tracking; consent mode

> Screens: SCR-WGT-007 (new), SCR-WGT-002 (partial: menu items), SCR-APP-037 (partial: tracking section), SCR-APP-015 (partial: Intent block) · Contracts: [technical-design.md](technical-design.md) §3 · Design system: `docs/02-design/design.md` (§4.9 widget `panel-header`, consent-card styling; §4 `toggle`, `card`, `context-sidebar`, `alert`, toast) · Anchor: `anchors/scr-app-015-conversation.html` (Intent: Now on / Viewed / Source), `anchors/scr-wgt-002-chat-panel.html` (card styling) · Strategy: code-native · 2026-11-12

Widget copy is given in English; every widget string also has a `zh-Hans` entry in `strings.ts`. `{business}` is the business name.

## SCR-WGT-007 — Tracking consent

Shown only in consent mode, when the visitor has no stored choice, at the top of the message log the first time the panel opens (D1). Styled like the consent card: full log width, `--kaki-surface` fill, 1 px `--kaki-border`, `--kaki-radius`, padding 16, `role="group"` with `aria-labelledby` its title.

**Asked**
- Title (body, weight 600): "Help us help you faster?"
- Body: "Let {business} see which pages of this site you visit, so answers fit what you're looking at. We don't use cookies or share this." then the privacy notice link when the business has one ("Privacy notice", opens in a new tab).
- Buttons side by side (stacked under 320 px), 44 px targets: primary "Allow", secondary "No thanks".
- Arrival: focus stays in the composer (the visitor may just type); the log's live region announces the title. The greeting and composer work whether or not it is answered; asking a question doesn't answer it.

**Accepted** — collapses to one caption line with the success tick (`--kaki-success`): "Thanks. You can stop this from the menu." Focus moves to the composer.

**Declined** — collapses to the caption "OK, we won't track pages. You can change this from the menu." Focus moves to the composer.

**Error** — the choice is kept locally even if saving fails (technical-design §5.8), so there is no error state.

## SCR-WGT-002 — Chat panel (partial: menu items)

In consent mode only, the header menu adds, after "Privacy notice":
- With `accepted`: "Stop sharing pages" → declines (deletes the visitor's events), adds the local notice "We've stopped tracking pages and removed what we had." to the log; focus to the notice.
- With `declined` (or after stopping): "Share pages I view" → re-shows the SCR-WGT-007 card at the end of the log, focus to "Allow".
Not shown when tracking is `on` or `off` (no choice to make; the privacy notice covers `on`).

## SCR-APP-037 — Website widget (partial: tracking section)

A new `card` section after "Sites", heading "Visitor tracking" (`h2.section-title`, `id="widget-tracking"`), owner/admin only like the rest of the page.

- Intro (body-sm, text-secondary): "The widget can note which pages of your site a visitor views, so the assistant's answers fit and your team sees what they looked at. It uses no cookies, and the data stays anonymous until the visitor leaves their details."
- `toggle` "Track pages visitors view" (on = `on`/`consent`). Help: "When off, only the page a visitor is on when they send a message is used."
- `toggle` "Ask visitors first (consent mode)" (on = `consent`), disabled with `aria-disabled` and the help "Turn on tracking to use this." while tracking is off. Help when enabled: "Visitors see a short prompt when they open the chat. Nothing is tracked until they allow it."
- Each toggle applies immediately (design.md `toggle`): saving shows the toggle's spinner, then the toast "Tracking settings saved."; an error reverts the toggle and shows the inline `alert` "Couldn't save. Try again." under the section heading.
- Caption at the bottom: "Page history is kept for 180 days." and, when `updatedAt` is set, "Last changed {date}".
- Permission: a staff member doesn't see this page (existing gate).

## SCR-APP-015 — Conversation (partial: Intent block)

The sidebar's Intent section (design.md `context-sidebar`; anchor) becomes a `dl` (key/value, body-sm) followed by the existing triage signals list:

- **Now on**: the current page path (mono), or "—" when none (non-widget channel: the row is omitted).
- **Viewed** (scope `full`, at least one other page): up to 10 paths, newest first, each "/catering · 3 min" (`formatDwell`: under 1 min → "under a minute", minutes rounded, ≥ 60 → "1 h 5 min"); more than 5 → the first 5 and a "Show all" disclosure (`aria-expanded`).
- **Source** (scope `full`): `utm_source=google · utm_campaign=cny` (mono, only keys present), else "From {referrer host}", else "Direct".
- **Returning**: "Returning visitor" chip (neutral) when true; nothing when false.
- Scope `page_only`: only Now on, plus the caption "Page history isn't shared for this visitor." (tracking off or not consented; same text for both so staff don't learn the visitor's choice beyond that).
- Then "Signals" (caption) with the existing triage list, or "No signals yet."
- Phone width: same content in the bottom sheet.

## Tokens used

Widget: `--kaki-surface`, `--kaki-border`, `--kaki-radius`, `--kaki-accent`, `--kaki-on-accent`, `--kaki-text`, `--kaki-text-secondary`, `--kaki-success`, `--kaki-focus`. Dashboard: `--color-text-secondary`, `--color-border-default`, `--color-bg-surface`, `--space-2`…`--space-5`, `--type-body-sm-*`, `--font-mono`, `--radius-full` (toggle, chip).

## Gaps and escalations

- None. Proactive greetings on SCR-APP-037 stay with FEAT-030.
