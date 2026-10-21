# UI Design: FEAT-024 — Assistant persona and disclosure settings

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E3) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-041 (new), SCR-WGT-002 (p: greeting) · Mode: per-feature · Status: Verified · Date: 2026-10-21

No design tool is connected and the manifest policy is `code-native`, so this document is the design. SCR-APP-041 gets its first entry. SCR-WGT-002 keeps its anchor entry; its `greeting` state gains a supplement here. Everything reuses design.md §4 components; no token, component or variant is added.

## SCR-APP-041 — Assistant

- **Strategy and source:** code-native. Route `/settings/assistant`, reached from the Settings index (below). On desktop a breadcrumb is not used (depth 2, design.md §4.5); a back link "Settings" sits above the h1 on every width.
- **Composition:** dashboard shell; back link; h1 "Assistant"; the line "How your assistant introduces itself and talks to visitors. Changes apply to the next reply."; then at ≥ 1024 px a two-column layout: the form (max 720 px) on the left and a sticky **preview** card (320 px) on the right. Below 1024 px the preview sits after the Persona section, before Messages.
  1. **Persona** (`card`, `h2` "Persona"):
     - `field` "Assistant name", placeholder "e.g. Kaki", help "Shown at the top of the chat. Leave empty to use “Assistant”. Letters only, up to 30 characters."
     - `radio` group "Tone": "Friendly — warm and casual" · "Professional — courteous and businesslike". Help: "Your assistant still answers in the visitor's language. With Professional it doesn't use Singlish particles."
     - `toggle` "Use emoji in replies" (on = the assistant may add an emoji; applies on Save, not immediately, because it's part of the form).
  2. **Messages** (`card`, `h2` "Messages"). A `tabs` row above the fields: "English" · "中文" (each tab's panel holds the same four fields for that language; the 中文 tab carries `lang="zh-Hans"` on its inputs). Help under the tabs: "Leave a message empty to use the default shown. If you only write in English, Chinese-speaking visitors get the Chinese default."
     - **Greeting** `textarea` (2 rows): placeholder = the default greeting. Help: "Shown before the visitor's first message."
     - **AI disclosure**: a read-only `field` (subtle fill, no border, design.md §4.2 read-only) showing the core, e.g. "You're chatting with Kaki, an AI assistant for Kaki Bakery.", label "AI disclosure (always shown)", help "This sentence is always the first thing visitors see. You can add to it, but not remove it." Then a `textarea` "Add to the disclosure", placeholder "e.g. Our team reads every conversation." (200 characters).
     - **After-hours message** `textarea`: label "After-hours message"; above it a read-only line with the fixed part, "We're closed right now. The team will be back {return time}." in text-secondary; placeholder = the default ("I can still answer your questions in the meantime."). Help: "Shown with the time your team is back, from your opening hours."
     - **Fallback message** `textarea`: placeholder = the default. Help: "Sent when the AI is paused or unavailable."
     - Each textarea shows a character counter in caption text-secondary ("42 / 300"), announced only when the limit is reached.
  3. **Preview** (`card`, `h2` "Preview", `aria-live` off): a static mock of the widget panel using `--color-*` dashboard tokens (not the widget's `--kaki-*`, since it isn't the widget): header with the name (or "Assistant") and the "AI assistant" label; the greeting as the empty line; one bot bubble starting with the disclosure core and note. It follows the selected Messages tab's language and updates as the owner types.
  4. **Sticky action bar**: `Save changes` (`primary`), `Cancel` (`ghost`, resets the form to the loaded values). Right-aligned on desktop; full width above the tab bar on mobile.
- **Content and data mapping:**
  - Load: `GET /api/v1/settings/assistant` → fields from `settings`; placeholders, the disclosure core (`defaults.disclosureCore[lang].named` with `{name}` replaced, or `.unnamed` when the name is empty) and the after-hours lead (`defaults.afterHoursLead[lang]` with `{when}` shown as "{return time}") from `defaults`.
  - Save: `PUT /api/v1/settings/assistant` with every field and the loaded `version`; empty text → `null`.
- **Conformance:** pass. Components: `field`, read-only `field`, `textarea`, `radio`, `toggle`, `tabs`, `card`, `alert`, `toast`, `button` primary/ghost. One `primary` per region (Save). Labels say what "on" means ("Use emoji in replies").

### default
Fields filled from `settings` (empty for unset texts, so the placeholder shows the default). `Save changes` is disabled until something changes. The English tab is selected.
### loading
Skeleton blocks in the two cards' layout and the preview card (`aria-busy="true"`).
### validation
Validate on blur and on submit (design.md §4.2), with the contract schema. On submit with errors, an inline danger `alert` at the top lists each error as a link to its field and takes focus; an error in the other language's tab switches to that tab when its link is followed, and the tab label gets "(1 error)". Messages: "Assistant name can't contain numbers", "Assistant name must be 30 characters or fewer", "Greeting must be 200 characters or fewer", "Disclosure addition must be 200 characters or fewer", "After-hours message must be 300 characters or fewer", "Fallback message must be 300 characters or fewer".
### saving
`Save changes` shows its loading state; fields are read-only until the response.
### saved
The form stays on the page with the saved values; toast "Assistant settings saved. Your assistant uses them from the next reply." (`Save changes` is disabled again).
### conflict
On 409: a warning `alert` above the form: "Someone else saved these settings while you were editing. Reload to see their version, then make your change again." [Reload]. The input stays until Reload.
### error
Load failure: `error-state` "We couldn't load your assistant settings" · "Nothing you saved is lost." · [Try again]. Save failure other than 409/400: a danger `alert` "We couldn't save your settings just now. Nothing was changed." with the input kept.
### permission
For the `agent` role (403): the permission-limited view (design.md §4.8): "Only the Owner or an Admin can change the assistant's settings." The Settings nav item stays visible.

- **Responsive notes:** below 768 px single column with 16 px gutters; the tabs stay one row (two short labels); the preview follows Persona. Textareas grow to 6 lines.
- **Decisions:**
  - **Language tabs instead of paired fields.** Driver: eight paired fields would double the form's length on a phone, and most owners write one language. Rejected: a global "language" select at the top, which hides that the other language falls back to a default.
  - **The preview is a static mock, not the live widget.** Driver: the real widget needs a widget key, an allowed origin and the host page's theme (FEAT-032's `widget-preview`); here only the words change. Rejected: an iframe of the host page, which is FEAT-032's job.
  - **Room for the kill switch.** GOV-08's controls on this screen come with FEAT-057 as a third card ("AI replies") above Persona; nothing in this layout has to move for it.

## Settings index (route `/settings`)

Not a screen of its own in the inventory: it is the Settings section's landing list (ux-foundations IA, "Settings" with its groups), replacing the placeholder. h1 "Settings"; one `card` per group from the IA — "Assistant and rules", "Channels and widget", "Business and team", "Privacy and data", "Plan and usage" — each a `list` of its screens. A built screen is a link row (name, one-line purpose, chevron): today only "Assistant — Name, tone, greeting and the messages visitors see". Unbuilt screens are plain rows in text-secondary with "Coming soon" (no link, not focusable), so the section's shape is visible. At < 768 px the cards stack.

- **Decision:** "Coming soon" rows rather than hiding them (design.md §7 "don't hide controls without explanation"); they become links as their features land.

## SCR-WGT-002 — Chat panel (p)

### greeting
Before any message the log shows the tenant's greeting (`WidgetConfig.greeting`, `zh` when the panel locale is `zh-Hans`, else `en`), already resolved to the default when the tenant hasn't set one, in the existing `.empty` style, with `lang` set by the language-of-parts rule. The header and launcher label show the tenant's name (the anchor already binds them to `botName`). Unchanged: the disclosure still arrives with the first reply and isn't repeated in the greeting.

## Escalations and open items

- None filed. The manifest gains SCR-APP-041 with no gaps; SCR-WGT-002 gains the `greeting` supplement.
