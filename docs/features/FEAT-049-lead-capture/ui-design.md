# UI design: FEAT-049 — Consent and lead capture

> Contracts: [technical-design.md](technical-design.md) §3 · Design system: `docs/02-design/design.md` (§4.9 widget `consent-card`, `lead-form-card`, `system-notice`; §4.2 `field`, `text-input`, `textarea`, `checkbox`, `toggle`; §4.1 `button`, `link`; §4.3 `alert`, `toast`; §4.4 `card`, `chip`; §4.8 data-view states; `context-sidebar`, `message-bubble`) · Anchor: `anchors/scr-wgt-002-chat-panel.html` states `consent` and `fallback` · Strategy: code-native · 2026-11-04

Copy is given in English; every widget string also has a `zh-Hans` entry in `strings.ts` (design.md §4.9 widget language). Texts the tenant edits (purpose statement, marketing wording) are shown exactly as saved, in the panel's locale (`zh` falls back to `en` when empty).

## SCR-WGT-003 — Consent and details

Both cards sit in the message log directly under the agent message that carries them (`card` on `Message`), full log width, design.md `card` inside the widget: `--kaki-surface` fill, 1 px `--kaki-border`, `--kaki-radius`, padding 16. Each is `role="group"` with `aria-labelledby` its title. Only the active card (technical-design §5.6 `activeCard`) is interactive; an earlier unanswered card shows its collapsed "Not answered" line.

**Consent card — asked**
- Title (body, weight 600): `CONSENT_PROMPT` ("Is it OK for us to use your details for this?").
- The purpose statement as saved (body), then the privacy notice link ("Privacy notice", opens in a new tab, `(opens in a new tab)` hidden text) when the tenant has one.
- When the business asks for marketing (`leadCapture.marketing` not null): a `checkbox`, unticked, labelled with the saved marketing wording, then the caption "Optional. You can say no and still leave your details." A separate checkbox, never pre-ticked, never required (LED-08).
- Buttons, right-aligned, wrapping on narrow panels: secondary "Not now", primary "Agree". 44 px touch targets.
- Footer caption (text-secondary): "You can withdraw consent at any time by telling us here."
- Focus: when the card arrives, focus stays in the composer (a reply arriving must not steal focus); the card is announced through the log's existing live region as "{bot} asks for your consent".

**Consent card — sending / agreed / declined / failed**
- Sending: both buttons disabled, the pressed one shows the spinner with its label kept (`aria-busy`).
- Agreed: the card collapses to one line, success icon + "You agreed · 2:31 pm" (and "· Offers: yes" when ticked); the lead form card appears below it and focus moves to its first field.
- Declined: collapses to "You chose not to share your details." followed by the system-notice "No problem. You can keep asking questions." (a local notice, not stored). Focus returns to the composer.
- Failed (network, 5xx): an inline danger `alert` inside the card, "Couldn't save your answer. Try again.", buttons enabled again.
- Wording changed (409 `wording_changed`): the card's text swaps to the new wording, with an info line "The business has updated this statement. Please read it again." Nothing was recorded.

**Lead form card — form**
- Title: "Your details". Intro caption: "{business} will use these to get back to you."
- One `field` per enabled field, in order name, phone, email, need, budget, preferred time:
  - Name — "Name", `autocomplete="name"`.
  - Phone — "Phone", `type="tel"`, `inputmode="tel"`, `autocomplete="tel"`, help "Singapore number, like 9123 4567".
  - Email — "Email", `type="email"`, `autocomplete="email"`.
  - Need — "What do you need?" `textarea` (3 rows, max 1000).
  - Budget — "Budget".
  - Preferred time — "Preferred date or time" (F&B template default label "Date needed").
  - Required fields get "(required)" in the label text (not an asterisk alone). When phone and email are both optional, a caption above them: "Phone or email is needed so the team can reply."
- Prefill: values from the visitor's own message are filled in and editable; nothing comes from earlier conversations.
- Buttons: primary "Send details", ghost "Cancel" (collapses the card to "You didn't send your details." — consent stays recorded and the next `capture_lead` re-opens a form).

**Lead form card — invalid field / submitting / submitted / failed**
- Invalid (client check on submit, then the server's 422 codes): an error summary at the top of the card (`role="alert"`, "Check 2 fields" with links to each), and per-field error text under the control (`aria-invalid`, `aria-describedby`): "Enter your name", "Enter a Singapore number with 8 digits, like 9123 4567", "Enter an email address, like hello@example.com", "Enter a phone number or an email". Focus moves to the summary.
- Submitting: inputs read-only, the primary button shows the spinner, "Sending…".
- Submitted: the card collapses to a summary ("Details sent · Mei Ling · +65 9123 4567") and the stored system notice (`noticeKind 'lead_captured'`) follows in the log: "Thanks, {business} has your details and will get back to you." Focus moves to the notice. An update reads the same (the visitor isn't told a lead existed, technical-design D4).
- Failed: "Couldn't send your details. Try again." inline alert; values kept.
- Consent required (409, e.g. consent withdrawn elsewhere): the card is replaced by a fresh consent card.

**Withdrawn** (listed state of SCR-WGT-003) is FEAT-051's.

## SCR-WGT-005 — Fallback (adds the contact form)

Shown in two places, only when `leadCapture` is not null (purpose statement saved, and for pre-live also the privacy notice, UX-R4):
- **AI paused** (FEAT-057's `PausedNotice` above the composer): a secondary button "Leave your details" under the business contacts.
- **Not live, message mode** (FEAT-034's `NotLiveCard`): the same button under the contact lines.

Pressing it replaces the notice or card body with the contact form (region `aria-label="Leave your details"`), as the anchor's `fallback` state:
- Intro: "Leave your details and {business} will get back to you."
- The enabled fields as on the lead form card.
- The purpose statement, then a required `checkbox` "I agree to {business} using my details for this." with the privacy link; the marketing checkbox below it when enabled (unticked, optional).
- Buttons: primary "Send", ghost "Back" (returns to the notice).
- States: invalid (as the form card, plus "Tick the box to agree before sending" on the consent checkbox), sending, sent ("Thanks. {business} will get back to you." in a success alert, replacing the form; focus to it), failed, wording changed (as the consent card).

## SCR-APP-043 — Leads and consent (partial: lead fields, marketing wording)

`/settings/leads`, Owner and Admin (others get the no-permission page), linked from the Settings index as "Leads and consent — Fields visitors fill in and the consent they give". Page `h1` "Leads and consent"; max width 720; the settings-form pattern (`privacy-parts.tsx`): one Save per page, sticky footer on mobile.

**Lead fields** card
- Title "Lead fields", body "What the assistant asks for when a visitor leaves their details."
- A list, one row per field: label (Name, Phone, Email, What they need, Budget, Preferred date or time), and a segmented `radio` group "Off · Optional · Required" (a `fieldset` per row, `legend` = field name). On phones the group wraps under the label.
- Validation: phone and email both Off → field error on the Email row and the summary "Keep phone or email on, so the team can reply." Save is blocked.

**Consent** card
- "Purpose statement" — read-only, the saved text (or the default with an info `chip` "Not saved yet"), and a link "Edit on Privacy and data" to `/settings/privacy#purpose`.
- "Marketing opt-in" — a `toggle` "Ask visitors if they want offers and news" (off by default, technical-design D3); help "Shown as a separate, unticked checkbox. Visitors can leave their details without agreeing."
- When on: `textarea` "Opt-in wording (English)" prefilled with the default ("Also send me offers and news from {business}. I can unsubscribe at any time."), and "Opt-in wording (Chinese, optional)". Each saved change is a new version; the card shows "Version 3 · saved 18 Nov 2026" from `marketing.wording`. Empty English text while on → field error "Enter the opt-in wording".
- A caption under the marketing block: "The Do Not Call Registry applies to phone and SMS marketing."

**Not in this feature** (shown as nothing, not as placeholders): qualification criteria (FEAT-050), outbound webhooks (FEAT-053).

**States**: loading (skeleton of both cards), error (`error-state` "Couldn't load lead settings" + Try again), never saved (defaults shown, the F&B defaults for F&B tenants), saving (Save busy "Saving…"), saved (toast "Lead settings saved"), validation errors (summary + field errors, focus to the summary), conflict (409 `stale`: warning alert "Someone else changed these settings. Your changes weren't saved." with "Load their version"), save failed (danger toast "Couldn't save. Try again."), permission.

## SCR-APP-014 — Inbox (partial): contact, lead, consent

- **Sidebar, Contact section** (`context-sidebar`): with a contact, the name as the section heading (else "Website visitor"), then email and phone rows (`formatSgPhone`), each with a copy icon button ("Copy email", announces "Copied"); first seen and previous conversations stay. Without a contact, as today.
- **Sidebar, Lead section**: status `chip` (New / Contacted / Won / Lost; info, accent, success, neutral), "Updated 2:31 pm", "Consent · 18 Nov 2026, 2:30 pm", "Offers · Yes, 2:30 pm" or "Offers · No". No lead: the section shows "No details left yet." Opening the lead is FEAT-050 (no link yet).
- **Dividers** (`message-bubble` system rows): "Visitor agreed to share their details", "Visitor chose not to share their details", "Visitor left their details", "Visitor updated their details" — caption with the time, as the other dividers.
- **Card captions**: an agent bubble with a card gets a caption under it, text-secondary: "Asked for consent" or "Showed the details form".
- **Search results**: a contact hit's row shows, in place of the message excerpt, "{Name|Email|Phone} matches · " + the field value with the hit marked (`mark`, accent-soft, as FEAT-046). Opening it opens the thread at the bottom (no message to jump to).

## Tokens used

Dashboard: `--color-surface`, `--color-border-default`, `--color-text-primary`, `--color-text-secondary`, `--color-accent-soft`, `--color-success-soft`/`-fg`, `--color-info-soft`/`-fg`, `--color-warning-soft`/`-fg`, `--color-danger-soft`/`-fg`, `--radius-md`, `--radius-lg`, `--space-2`…`--space-5`, `--size-control-md`, `--size-control-lg`, `--type-caption-size`, `--font-weight-medium`. Widget: `--kaki-surface`, `--kaki-subtle`, `--kaki-border`, `--kaki-border-strong`, `--kaki-text`, `--kaki-muted`, `--kaki-accent`, `--kaki-on-accent`, `--kaki-info-bg`, `--kaki-radius`, `--kaki-font`. The widget has no danger or success variable yet: field errors and failed alerts need one that passes contrast on both schemes, so T8 adds `--kaki-danger` (and `--kaki-success` for the agreed tick) to `tokens.json` and design.md §4.9 through the generator, never a literal; until then errors carry their meaning in text and an icon, never colour alone.

## Gaps and escalations

- Withdrawal confirmation (SCR-WGT-003 "withdrawn") is FEAT-051; the Lead and Leads screens (SCR-APP-032, -033) and SCR-APP-043's qualification block are FEAT-050; webhooks FEAT-053.
- Consent card wording is UX-R3 (not yet tested with users); the copy here is the anchor's, adjusted to `CONSENT_PROMPT`.
