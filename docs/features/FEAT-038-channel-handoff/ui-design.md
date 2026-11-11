# UI design: FEAT-038 — Continue on another channel with the history

> Screens: SCR-WGT-004 (new), SCR-WGT-002 (partial: menu item, moved), SCR-APP-015 (partial: moved divider, recap) · Contracts: [technical-design.md](technical-design.md) §3 · Design system: `docs/02-design/design.md` (§4.9 widget `handoff-card`, `panel-header`, `system-notice`; §4.2 `field`, `text-input`; §4.1 `button`, `link`; §4.3 `alert`) · Anchor: `anchors/scr-wgt-002-chat-panel.html` (card styling as `consent`) · Strategy: code-native · 2026-11-11

Widget copy is given in English; every widget string also has a `zh-Hans` entry in `strings.ts`. `{business}` is the business name, `{bot}` the assistant's name.

## SCR-WGT-004 — Continue elsewhere

The handoff card sits in the message log: under the agent message that carries it (`card.kind === 'handoff'`), or at the end of the log when opened from the menu (a local card, not stored; opening it again moves focus to the open one rather than adding a second). Styled like the consent card: full log width, `--kaki-surface` fill, 1 px `--kaki-border`, `--kaki-radius`, padding 16, `role="group"` with `aria-labelledby` its title. Only the active card is interactive; an earlier unanswered one shows "Not answered".

**Options**
- Title (body, weight 600): "Continue this chat elsewhere"
- Body: "Your messages so far come with you."
- One button per live channel, full width, stacked, 44 px targets, secondary style with the channel icon (decorative, `aria-hidden`): "Continue on Telegram", "Continue by email". Only channels in the card (stored) or `config.handoff` (local) appear; a stored card whose channel has gone offline since shows the error state for it on press.
- Ghost "Stay here" collapses the card to "You stayed in this chat." (local). Focus returns to the composer.
- Arrival: focus stays in the composer; the log's live region announces "{bot} offers other ways to continue".

**Telegram — link ready** (after `POST …/handoff` 200)
- The card shows: "Open Telegram and tap **Start**. This link works for 30 minutes." and a primary link-button "Open Telegram" (`href` = the deep link, `target="_blank"`, `rel="noopener"`, hidden text "(opens Telegram)"), plus a ghost "Back" to the options.
- Focus moves to "Open Telegram". The panel stays as it is until the redeem arrives (the moved state below).
- Expired while open (past `expiresAt`, a local timer): the text becomes "This link has expired." with a secondary "Get a new link".

**Email — form**
- `field` "Your email", `type="email"`, `inputmode="email"`, `autocomplete="email"`; help text under it: "We'll use this email only to continue this chat." then the privacy notice link when the business has one (D1).
- Buttons: primary "Send link", ghost "Back".
- Invalid (client `checkLead` email rule, then 422 `invalid_email`): error text under the field "Enter an email address, like hello@example.com" (`aria-invalid`, `aria-describedby`, `--kaki-danger` with the icon), focus to the field.
- Sending: input read-only, primary shows the spinner with "Sending…" (`aria-busy`).

**Email — sent**
- The card collapses to: success icon (`--kaki-success`) + "Check your inbox at m***@gmail.com and tap **Continue** in our email. The link works for 24 hours." and a ghost "Send again" (re-posts; same states) and "Use a different email" (back to the form, empty).
- Focus moves to the sent line (`tabindex="-1"`).

**Errors** (inline danger `alert` inside the card, buttons enabled again)
- `channel_unavailable`: "Telegram isn't available right now. You can keep chatting here." (or "Email isn't …"); that option is removed.
- `rate_limited`: "Too many tries. Please wait a while and try again."
- `conversation_closed`: "This chat has ended. Start a new one to continue elsewhere."
- network / 5xx: "Couldn't do that. Try again."

**Confirm page (hosted, `GET /continue/:code`)** — a plain server-rendered page outside the widget, max width 480, centred, the widget's colours mapped through the `--kaki-*` tokens inline:
- Heading "Continue your chat with {business}", body "We'll continue by email at m***@gmail.com.", primary button "Continue" (form POST). Caption: "If you didn't ask for this, you can close this page."
- Done (`POST` 200): heading "You're all set", body "We've sent our chat so far to m***@gmail.com. Reply to that email to carry on." No auto-redirect.
- Expired / used / unknown: heading "This link has expired", body "Go back to {business}'s website to ask again." (no business name when the code is unknown: "Go back to the website to ask again.").
- `lang` follows the conversation's language; the page has one `h1`, a visible focus ring, and works without JavaScript.

## SCR-WGT-002 — Chat panel (partial: menu item, moved)

- **Menu item** "Continue on Telegram or email" (only the live one's name when one: "Continue on Telegram"), placed after "Talk to a person", shown under the conditions in technical-design §5.8. Choosing it closes the menu and opens the local handoff card; focus moves to the card's first button.
- **Moved** (the `conversation` event with `movedTo`, a 409 `moved`, or resume): the stored `handoff_moved` notice ("This chat continues on Telegram." / "This chat continues by email.") is the last line of the log, and the composer area is replaced by a footer bar: for Telegram, primary link-button "Open Telegram" (`https://t.me/<bot>` without a token, from config) and ghost "Start a new chat here"; for email, the caption "Reply to our email to carry on." and the ghost button. The menu shows only "Privacy notice". Focus moves to the notice when the event arrives while the panel is open; the live region announces it. "Start a new chat here" clears the log and starts a widget conversation as after End chat.

## SCR-APP-015 — Conversation (partial: moved divider, recap)

- **Divider** from the `conversation.moved` thread event, styled like the existing state dividers (caption, `--color-text-secondary`, centred rule): "Moved to Telegram · 2:31 pm" / "Moved to email · 2:31 pm". The header's channel chip shows the new channel.
- **Recap notice** (`handoff_recap`): rendered as a system message with the label "Recap sent on Telegram" (or "by email") and the text collapsed to its first two lines with a "Show all" disclosure (`aria-expanded`); it was delivered, so its delivery status shows as for other channel messages (FEAT-036).

## Tokens used

Widget: `--kaki-surface`, `--kaki-border`, `--kaki-radius`, `--kaki-accent`, `--kaki-on-accent`, `--kaki-text`, `--kaki-text-secondary`, `--kaki-danger`, `--kaki-success`, `--kaki-focus`. Dashboard: `--color-text-secondary`, `--color-border-default`, `--color-surface`, `--space-2`…`--space-4`, `--type-caption-size`.

## Gaps and escalations

- The hosted confirm page is a state of SCR-WGT-004 rather than a new screen ID (it exists only for this flow); no ux-foundations change.
- If Ken picks the consent card for email (technical-design D1), the email form opens after the FEAT-049 consent card and its help text drops the purpose sentence.
- Telegram inline buttons on the recap are out of scope.
