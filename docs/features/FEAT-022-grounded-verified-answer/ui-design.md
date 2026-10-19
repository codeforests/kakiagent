# UI Design: FEAT-022 — Grounded, verified answer from a hand-entered fact

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §6 · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-WGT-002 (reused anchor; this feature's states), SCR-APP-027 (p), SCR-APP-028 (p) · Mode: per-feature · Status: Verified · Date: 2026-10-19

No design tool is connected and the manifest policy is `code-native`, so each section below is the design. SCR-WGT-002 already has an anchor entry; this feature reuses it, adds its contract bindings, and designs the states its anchor listed as gaps that this slice now produces (error). SCR-APP-027 and SCR-APP-028 are new in the manifest and get anchor-level scrutiny, because they are the first dashboard forms built.

## SCR-WGT-002 — Chat panel

- **Strategy and source:** code-native. The anchor spec ([anchor-screens.md](../../02-design/anchor-screens.md#scr-wgt-002--chat-panel)) and its prototype stay the reference for layout and look; this section specifies the states FEAT-022 builds.
- **Composition (built now):** `panel-header` (bot name, "AI assistant" label, close), the log with `disclosure-row`, `message`s and the typing indicator, `system-notice` for errors, and the composer. Not built here: the header menu (FEAT-033), `feedback-buttons` (FEAT-031), consent and lead cards (FEAT-049/051), quick-action chips (FEAT-038/044).
- **Content and data mapping:**
  - visitor and stored replies ← `Message` (`POST /widget/v1/conversations/:id/messages` response, SSE `event: message`); `author` picks the bubble (`visitor` right in `--kaki-accent`; `agent` and `system` left on `--kaki-subtle`).
  - `disclosure-row` ← `Message.disclosure` of the first agent or system message, shown above that message as a caption row in `--kaki-muted` with a small info glyph. Never hidden, never dismissible (AGT-11).
  - growing bot bubble ← SSE `event: segment` (`turnId`, `seq`, `text`), grouped by `turnId`, ordered by `seq`, de-duplicated by `(turnId, seq)`.
  - the growing bubble is replaced by the stored `Message` whose `inReplyTo` equals the `turnId`.
- **Conformance:** pass. Only `--kaki-*` variables; the typing indicator reuses the anchor prototype's `.typing` style (three 6 px dots on `--kaki-subtle`, pulse disabled under `prefers-reduced-motion`).

### greeting
Before any message: the existing empty line "Ask us anything. We usually reply right away." The disclosure arrives with the first reply (server-rendered, AGT-11), so it is not duplicated in the greeting.
### typing
From the moment the visitor's message is accepted (POST returns) until the first segment of that turn arrives: the typing indicator as the last log item, `aria-label` "{bot name} is typing". It stays visible between segments while the turn is open.
### replying
Each verified segment is appended to one bot bubble for the turn, separated by a space, so the visitor sees whole sentences appear one at a time (ADR-008: never token by token). The log is `aria-live="polite"`, so each sentence is announced. When the stored message arrives, the bubble is replaced by it in place (same position, final text) and the typing indicator is removed. If the stored message arrives first (a reconnect), it is shown directly.
### fallback
A `system` message (AI paused, model unavailable, or the "let me confirm with the team" escalation text) renders as a normal bot bubble: these texts are the assistant speaking for the business. The lead form that follows the fallback in the anchor is FEAT-049.
### error
If sending fails, the existing `system-notice` "Couldn't send. Check your connection and try again." stays, with the typed text kept in the composer. If no reply (segment or message) arrives within 30 s of sending, the typing indicator is replaced by the notice "This is taking longer than usual. We'll show the reply here when it's ready." The reply still appears if it arrives later.

- **Responsive notes:** unchanged from the anchor (full screen below 480 px).
- **Decisions:** the growing bubble is replaced, not appended to, by the stored message (driver: the stored text is the record and may differ by whitespace; rejected: keeping both, which would duplicate the reply).

## SCR-APP-027 — Facts

- **Strategy and source:** code-native (this section is the design). Route `/knowledge` (the sidebar's Knowledge item; FEAT-011 adds Sources and other Knowledge tabs above this list).
- **Composition:** dashboard shell; page head with h1 "Facts", the line "What your assistant knows. Facts you add here are used in answers right away." and `Add a fact` (`primary`); a filter row with a `text-input` search ("Search facts", e.g. "cake") and a `select` for status (All, Approved, Disabled, Needs review); then a `table` at ≥ 768 px, a stacked `list` below. Max content width 1200 px.
- **Content and data mapping** (`GET /api/v1/kb/facts?status&q`): columns Fact (product name with unit, or the FAQ question) · Type (Product / FAQ) · Value (products: `S$55.00 · GST incl.` or `S$55.00 · GST excl.`; FAQs: the answer's first line, truncated with an ellipsis) · Status (`status-badge` with `--color-fact-*` aliases: Approved → approved, Needs review → review, Disabled → rejected colours with the text "Disabled", Rejected → rejected, Conflicted → conflict) · Updated (e.g. "19 Oct 2026, 2:30 pm"). The whole row is a link to `/knowledge/facts/:id`. Prices use tabular numerals.
- **Conformance:** pass.

### default
Rows newest first, as returned. On mobile each stacked item shows the fact name, then the type and value as secondary text, with the status chip on the right.
### loading
Five skeleton rows in the table layout (`aria-busy="true"` on the region).
### empty
`empty-state`: "No facts yet" · "Add your prices and common questions, and your assistant will answer with them." · [Add a fact]. Search and filter are hidden.
### filtered-empty
"No facts match your search" · [Clear filters].
### error
`error-state`: "We couldn't load your facts" · "Nothing you saved is lost." · [Try again].
### permission
For the `agent` role the API returns 403: "Only the Owner or an Admin can manage facts." (design.md §4.8 permission-limited view). The nav item stays visible.

- **Decisions:** Disabled uses the rejected colour pair with its own label (driver: tokens.json has no `fact-disabled` alias and both mean "not used in answers"; rejected: adding a token, which needs a design-system amendment for no visible gain).

## SCR-APP-028 — Fact

- **Strategy and source:** code-native. Routes `/knowledge/facts/new` and `/knowledge/facts/:id`. Version history with restore, sources, review interval and delete are FEAT-011/FEAT-017; not shown.
- **Composition:** dashboard shell; back link "Facts"; h1 "Add a fact" or the fact's name; a single-column form, max 720 px, in a `card`:
  1. Type (create only): `radio` group "Product and price" · "Question and answer (FAQ)". Fixed after creation (shown as text).
  2. Product: `field` "Name (required)" e.g. "Chocolate fudge cake"; `field` "Size or unit" e.g. "1 kg"; `field` "Price in S$ (required)" with a leading `S$` adornment, `inputmode="decimal"`, e.g. "55.00"; `radio` group "GST (required)": "Price includes GST" · "Price is before GST", with help text "If you're GST-registered, your assistant always quotes prices with GST included." (design.md §6, KB-15).
  3. FAQ: `field` "Question (required)" e.g. "Do you have eggless cakes?"; `textarea` "Answer (required)" e.g. "Yes, on request, 3 days ahead."
  4. Edit mode only: a status row with the `status-badge` and a `toggle` "Use in answers" (on = approved, off = disabled; applies on Save).
  5. Sticky action bar: `Save fact` (`primary`), `Cancel` (`ghost`, back to the list).
- **Content and data mapping:** create → `POST /api/v1/kb/facts`; edit loads `GET /api/v1/kb/facts/:id` and saves `PATCH …` with the loaded `version`.
- **Conformance:** pass, after one correction while designing: the GST choice was first drafted as a `select`; design.md §4.2 has no rule against it, but two options with consequences read better as radios with help text, matching the "say what on means" rule for toggles.

### default
Create: empty fields, product selected. Edit: fields filled from the fact; `Save fact` is disabled until something changes.
### saving
`Save fact` shows its loading state; fields are read-only until the response.
### saved
Back to the list with a toast "Fact saved. Your assistant uses it from now on." (design.md §4.3).
### validation
Validate on blur and on submit (design.md §4.2). On submit with errors, an inline danger `alert` at the top lists each error as a link to its field and takes focus. Messages: "Enter the product name", "Enter the price in dollars and cents, like 55.00", "Choose whether the price includes GST", "Enter the question", "Enter the answer".
### conflict
On 409 `version_conflict`: a warning `alert` "Someone else saved this fact while you were editing. Reload to see their version, then make your change again." with [Reload]. Unsaved input stays in the fields until Reload.
### not-editable
On 409 `invalid_state` (rejected or conflicted facts, which other screens resolve): an info `alert` "This fact can't be edited here." and the form read-only.
### loading, error, not-found
Edit only: skeleton fields while loading; `error-state` "We couldn't load this fact" [Try again]; for 404 the SCR-APP-059 not-found page.
### unavailable
On 503: a danger `alert` "We couldn't save the fact just now. Nothing was changed. Try again in a moment." with the input kept.

- **Responsive notes:** below 768 px the form is full width with 16 px gutters and the action bar sticks above the tab bar.
- **Decisions:** the toggle reads "Use in answers" rather than exposing the status words (driver: design.md §6 plain voice; the badge still shows the status name).

## Cross-screen decisions

- Prices are written the same way everywhere: `S$55.00` with tabular numerals (design.md §6, NFR-10). The dashboard shows the stored price and its GST label; the widget shows the price as rendered for visitors (GST-inclusive for registered tenants, KB-15).
- Microcopy follows design.md §6 terminology: always "fact", never "entity".

## Escalations and open items

- None filed. The disabled-state colour reuse (SCR-APP-027 decision) is recorded in case a `fact-disabled` alias is wanted later.
- The 中文 chrome strings for the new widget texts (typing label, slow-reply notice) are added to the existing `zh-Hans` table (design.md §4.9 owner decision); full Chinese chrome review is FEAT-033.
