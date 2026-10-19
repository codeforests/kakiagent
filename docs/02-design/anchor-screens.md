# Anchor Screens

> Design system: [design.md](design.md) (provenance mode: research, fidelity: designed-from-requirements) · Status: **Draft, for product-owner review** · Date: 2026-10-19
> Purpose: check that the design system composes into real screens before features build on it.
> Inventory: [ux-foundations.md](ux-foundations.md) · Registry: [../design-manifest.json](../design-manifest.json) · Prototypes: [anchors/](anchors/)

## Verdict: does the system compose?

**Composes, with three small amendments (A1–A3), all already applied to design.md and tokens.json.**

The three hardest compositions in the inventory were built from the tokens and the design.md §4 components only:
- the dense, provenance-heavy review queue with bulk actions and Approve all (KB-16);
- the mobile conversation with takeover, AI suggestion, internal note and context sheet at 375 px (INB-02/03/04/06/09);
- the embedded widget restyling itself against a hostile host page in three host themes (CHN-14, ADR-016).

No raw colour, spacing or radius values were needed outside the tokens. The only exceptions are the mock host site and the prototype state switcher, which aren't part of the system.

Results:
- **axe-core** (WCAG 2.0/2.1 A and AA rules): **0 violations at any impact level** across 44 checks (3 screens × 375 and 1280 px × light and dark OS scheme × each state). The widget was audited inside its shadow root using the test-only `?a11y` open-shadow mode.
- **No horizontal scroll** at 375 px.
- **Widget contrast clamp:** a pale host brand (#F6C453, 1.62:1 against the panel) was adjusted to #AA8739, which is 3.37:1 against the panel with 5.63:1 dark text on it. An orange brand on a dark host site (#C2410C) passed unchanged at 3.39:1 against the panel and 5.18:1 with white text.

What the anchors exposed:

| # | Finding | Amendment (applied) |
|---|---|---|
| A1 | design.md §3 put the Review hub in a list + detail split. Once each `fact-card` carries its own source passage and actions, a detail pane only repeats the card and halves the reading width for the passage. | §3: Review · Facts and Conflicts are a single-column queue (max 880 px); Edit and approve opens a dialog or sheet. List + detail stays for Corrections and Knowledge lists |
| A2 | At 375 px a pre-filled AI suggestion was cut off after 3 lines, so staff could send text they hadn't read. | §4.6 `composer`: opens at 5 lines while holding a suggestion, up to 50% of the viewport height on mobile |
| A3 | The widget needed surface, text, border and staff-bubble colours as `--kaki-*` variables, but design.md §4.9 only listed accent, font and radius. Reading the dashboard's `--color-*` from inside the shadow root would have been the wrong dependency. | tokens.json `widget.*` now has `surface`, `subtle`, `text`, `muted`, `border`, `border-strong`, `info-bg` and `on-accent` as aliases of the core colours (light and dark). §4.9 lists them |

None of these changes affect the direction, palette or component vocabulary.

---

## SCR-APP-019 — Review · Facts

- **Strategy and source:** code-native. This section is the spec, and [anchors/scr-app-019-review-facts.html](anchors/scr-app-019-review-facts.html) is a clickable rendering of it.
- **Composition:** dashboard shell (sidebar ≥ 768, bottom tab bar < 768, top bar with the `ai-status-pill`), page head (h1 "Review", one-line explanation, `Approve all…` as a `secondary` button: it's a bulk decision, so never `primary`), `tabs` (Facts / Conflicts / Corrections with counts), filter row (two `select`s; the keyboard-shortcut hint is hidden below 640 px), sticky `bulkbar`, then groups by entity type in the KB-16 order (Prices, Policies, Promotions, then the rest), each a column of `fact-card`s. `approve-all-dialog` opens over the page (a bottom sheet below 640 px).
- **Content (assumed shapes, to check in the feature's detailed design):** per fact: `id`, `type`, `state`, `title`, `value` (amount, currency, GST flag), `confidence` (0–1), `source` (name, URL or file and row, captured date), `passage` (text and highlight span offsets), `flags[]` (gst_unknown, stale_since, conflict_count). Approve-all needs counts by type of reviewable facts, excluding conflicted ones.
- **Conformance:** pass. The "64% confidence" warning text uses `--color-warning-default` per the `fact-card` rule (< 70%).

### default
Cards with selection checkboxes. Approving a card collapses it to a one-line row with an `Approved` badge and Undo, and a toast confirms it. A card with a conflict shows a `Resolve conflict` link instead of Approve (conflicted facts can't be approved here — KB-06).
### loading
Two skeleton cards in the final layout (badge line, title, passage well, button row) with `aria-busy`.
### empty
"No facts waiting for review" with the count of approved facts in use, and one action: `Add a source`. The filters and Approve all are hidden.
### error
`error-state`: "We couldn't load your facts", reassurance that no approvals were lost, and `Try again`.
### approve-all
A confirm dialog titled with the count, a table of counts per type, a warning alert naming the excluded conflicted facts, Cancel and "Approve 41 facts". The confirm button shows a spinner until the server acknowledges. Then the queue switches to empty and a toast offers Undo.

- **Responsive notes:** below 640 px the card actions stack full width and the source link drops under the badge. The bulk bar wraps its label.
- **Decisions:** single-column queue instead of list + detail (A1; driver: the passage needs the full width to be readable; rejected: list + detail, which duplicated the card).

## SCR-APP-015 — Conversation

- **Strategy and source:** code-native. This section is the spec, and [anchors/scr-app-015-conversation.html](anchors/scr-app-015-conversation.html) renders the < 768 px layout, which is the anchor target. The ≥ 1024 two-pane and ≥ 1280 three-pane layouts follow design.md §3 and are designed with the inbox feature.
- **Composition:** a thread header (back, contact name, conversation-state `chip`, channel and current page, an "i" button opening the `context-sidebar` as a bottom sheet), a thread `role="log"` of `message-bubble`s (visitor left; AI and staff right; system events as centred dividers; internal note full width), and a docked region at the bottom that switches between the takeover bar, the `composer` and the "owned by someone else" bar.
- **Content (assumed shapes):** conversation `state`, `owner`, `channel`, `current_page`; messages with `author_kind` (visitor, ai, staff, system, note), `author_name`, `sent_at`, `text`, `fact_refs[]` on AI messages; suggestion `text` and `fact_refs[]`; contact, lead and intent blocks per INB-04.
- **Conformance:** pass after amendment A2. Facts used appear as small chips under AI messages, so provenance is visible inline (A5 principle 1).

### ai-handling
The docked takeover bar: "The assistant is holding this conversation…", with `Take over` (primary) and `Suggest a reply` (secondary). The state chip shows Escalated.
### human-mine
The composer is active, holding the AI suggestion with the "AI suggestion · checked against your facts" label and a 5-line height (A2), followed by "The suggestion only uses approved facts. Anything you add yourself isn't checked" and `Hand back to assistant`. The system row "You took over · visitor sees 'Ah Kow joined'" shows what the visitor sees.
### human-other
"Mei Ling is handling this conversation" with `Ask Mei Ling to hand it over` (INB-09).
### context-sheet
A bottom sheet with contact identifiers (verified or not), lead status with the score reason and consent, intent (current page, pages viewed, UTM) and facts used.
### waiting-for-approval, closed, flagged
Follow the same header-chip and docked-bar pattern: the chip from `--color-conversation-*`, and a docked bar saying why replies are paused or the conversation is closed. Not prototyped; covered by design.md §4.6.

- **Responsive notes:** the thread scrolls inside a fixed-height view, so the docked region stays visible. Safe-area insets are applied to the header and dock.
- **Decisions:** the context opens as a sheet from the header rather than as a tab (driver: one-handed reach and fewer navigation levels at 375 px).

## SCR-WGT-002 — Chat panel

- **Strategy and source:** code-native. This section is the spec, and [anchors/scr-wgt-002-chat-panel.html](anchors/scr-wgt-002-chat-panel.html) is a working `<kaki-agent>` custom element with a closed shadow root, on a mock bakery site with hostile CSS (`button { all: unset; background: hotpink }`, `div { line-height: 3 }`).
- **Composition:** `panel-header` (avatar, bot name, "AI assistant · {business}", menu: Talk to a person · Privacy notice · End chat; minimise), log with `disclosure-row`, `message`s, `feedback-buttons`, `system-notice`s and inline cards, quick-action chips (Talk to a person, Continue on Telegram), the composer, and the footer line with the privacy-notice link (CHN-13, GOV-14).
- **Content (assumed shapes):** `bot_name`, `business_name`, disclosure text (editable but not removable), message segments (verified sentences), consent purpose text and version, privacy-notice URL, staff display name.
- **Conformance:** pass after amendment A3. Theme detection reads the host body background (to pick the scheme), the font and the main CTA's colour and radius, then clamps the accent (design.md §4.9). The prototype mixes toward black or white in sRGB; production uses OKLCH lightness as specified, with the same thresholds.

### greeting
The disclosure line, then the greeting.
### replying
A typing indicator, then **whole sentences appear one at a time** (≈ 0.9 s apart in the prototype), with the indicator between them and the feedback buttons once the reply is complete. There is no token streaming (ADR-008). The `aria-live` log announces each segment.
### consent
An inline card: purpose statement with the privacy-notice link, an unchecked optional marketing checkbox (LED-08), `Not now` and `Agree` (equal size, so neither is pushed), and the withdrawal reminder (LED-07).
### human
"Asking the team…" with the expected wait, then "Mei Ling from Kueh & Co. joined", then staff messages labelled with the name in the `--kaki-info-bg` bubble.
### fallback
AI paused or not live: the tenant's fallback text, then a name and contact form with a consent checkbox and `Send` (SCR-WGT-005 shares this state).
### error, rate-limited
A `system-notice` with a retry or the polite limit message (GOV-13). Not prototyped.

- **Responsive notes:** below 480 px the panel is full-screen (100dvh) and the launcher hides while the panel is open. Inputs use 16 px text to avoid iOS zoom.
- **Decisions:** the bot bubble uses `--kaki-subtle` (neutral) rather than a tint of the host accent, so a clamped or unusual host colour never affects message readability.

## Escalations and open items

- **A1–A3** were found by the anchors and applied directly to design.md (§3, §4.6, §4.9) and tokens.json (`widget.*`), because the design system is still an unsigned draft in this same phase. Signed-off versions will need the ux-foundations amendment path instead.
- **Not covered by anchors:** the desktop three-pane inbox, Home KPIs (charts depend on the data-visualisation gap in design.md §9) and the operator console's dark chrome. These are validated by the first features that build them, with anchor-level scrutiny.
- **Dark mode in the dashboard prototypes:** SCR-APP-019 and SCR-APP-015 still render dark when your OS is in dark mode. This previews the fast-follow; the launch build of APP is light only (design.md §9).
- **Prototype limitations:** the IBM Plex font loads from Google Fonts in the prototypes only (production self-hosts it). The state switcher overlaps the header at 375 px and isn't part of the design.
