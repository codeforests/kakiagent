# UI Design: FEAT-052 — Owner alerts by email, quiet hours, digest, notification preferences

> Screens: SCR-APP-056 (My notifications, new), plus an entry in the account menu and a card on SCR-APP-055 (My account), and the alert and digest emails · Mode: per-feature · Status: Draft · Date: 2026-11-01

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screen is a code-native spec. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `card`, `toggle` (the existing native `button role="switch"` pattern from `assistant.tsx`), `field`, `text-input` (`type="time"`, as in `business-profile.tsx`), `button` (`primary`, `secondary`), `alert`, `toast`, `skeleton`, `error-state`, `list`, `menu`. No new component or token. Copy says "alert" and "email"; never "notification event", "channel" or "mute".

## SCR-APP-056 — My notifications

- Route `/account/notifications`, every role, inside the app shell (a workspace is needed: preferences are per business). The page has a back link "← My account" (`ghost`, to `/account`) above the `h1` "Notifications", then the `page-lede` "Choose what we alert you about at {business name}, and when to hold alerts." Three `card`s, each with an `h2`, stacked with `--space-6` between, the settings pages' max content width.
- **Contract bindings:** `GET /api/v1/me/notifications`, `PUT /api/v1/me/notifications`, `POST /api/v1/me/notifications/test`.

### Alerts card (`h2` "What to alert me about")
- Help under the heading: "Alerts go to {sendTo.email}." (email in weight 500) followed by a `ghost` link "Change email" to `/account`.
- A `list`, one row per event in `events` (row min-height 56, divider `--color-border-default`): left, the event label (`--type-body`, weight 500) and a one-line help (`--type-body-sm`, `--color-text-secondary`); right, one switch per channel in `channels` with a column header above the list ("Email", `--type-body-sm`, weight 500, `--color-text-secondary`; hidden below 640, where each switch shows its own visible "Email" label to its left).
  - escalation: "A customer asks for a person" / "When the assistant hands a chat to your team."
  - approval_pending: "A reply needs approval" / "Quotes, discounts or promises waiting for you to approve." (only shown when the API lists it)
  - hot_lead: "New hot lead" / "When a customer looks ready to buy."
- Switch accessible name "Email alerts: {label}"; `aria-checked`. It applies on change (design.md `toggle`): optimistic, the whole body is sent with `PUT`; while pending the switch is `aria-busy` and not re-pressable. Success: `toast` "Saved." Failure: the switch returns to its previous position and an `alert` danger appears at the top of the card: "We couldn't save that. Try again." (dismissed by the next successful save). Focus stays on the switch.
- All switches off: an `alert` info in the card: "You won't get any email alerts at {business}. You'll still see everything in the inbox."

### Quiet hours card (`h2` "Quiet hours")
- Switch "Hold alerts during quiet hours" (label to the left, switch right), on by default.
- When on: two `field`s side by side (stacked below 640): "From" and "To", each `text-input` `type="time"` (`step` 60), values from `quietHours`. Help below: "Singapore time. Alerts that arrive in this window come as one email when it ends. Urgent alerts, like a customer asking for a person or an approval about to miss its deadline, still come straight away." When the window crosses midnight, the help starts with "Overnight, " (for example "Overnight, 22:00 to 08:00.").
- When off: the two fields are hidden and help reads "Every alert is emailed as it happens."
- The switch saves on change like the alert switches (and shows or hides the fields). The times save with a `primary` "Save quiet hours" button below the fields, enabled only when a time differs from the saved one ("Saving…" while pending). Validation on submit: the same From and To → field error on "To": "Pick a different end time."; an empty time → "Enter a time." Errors move focus to the first invalid field. Success: toast "Quiet hours saved." Server 422 maps to the same field errors; other failures show the card's danger `alert` "We couldn't save your quiet hours. Try again."

### Test card (`h2` "Test")
- Text: "Send yourself a test alert to check it reaches your inbox. It ignores quiet hours."
- `secondary` "Send me a test alert" ("Sending…" while pending).
- Success: toast "Test alert sent to {sentTo}. It should arrive within a minute." Focus stays on the button.
- 429: an `alert` warning under the button, "You just sent one. Try again in {retryAfterSeconds} seconds." (`role="status"` is not used: the alert is static text that replaces itself; the button stays enabled.) Other errors: `alert` danger "We couldn't send a test alert. Try again."

### States
- **Loading:** `skeleton` for the three cards (heading bar plus two lines each).
- **Error:** `error-state` in place of the cards: "We couldn't load your notification settings." [Try again].
- **No workspace** (a user without an active membership): the shell's existing no-workspace handling; the page isn't reachable from the menu then.
- Covered: default (all on, quiet hours 22:00–08:00), approval row hidden (Agent without rights), one event off, all events off, saving, save failed (rolled back), quiet hours off, overnight window, daytime window, same-time error, quiet hours saved, test sent, test rate-limited, test failed, loading, error.
- Width: one column at every width; at 375 px nothing scrolls horizontally; switches have a 44 px hit area on touch.

## Account menu and My account (SCR-APP-055, partial)

- Account menu (`shell/account-menu.tsx`): a `menu` item "Notifications" after "My account", linking to `/account/notifications`, shown when the user has a workspace.
- My account (`pages/account.tsx`): a fifth `card` after Devices, `h2` "Notifications", text "Choose which alerts you get by email and set quiet hours." and a `secondary` link-button "Notification settings" to `/account/notifications`. Hidden when the user has no workspace.

## Alert and digest emails (not a screen; `templates.ts`)

- Plain layout, readable in text and HTML: the subject as in technical-design §5.1; first line what happened ("A customer asked to talk to a person at Kaki Bakery."); one link "Open in KakiAgent" (HTML: a bordered link-styled button with inline styles using the light theme's accent value from `tokens.json`, since email clients don't load CSS variables); footer in smaller text: "You get this because of your notification settings for Kaki Bakery. Change them: {link}".
- Digest: "While your quiet hours were on, you got {n} alerts at Kaki Bakery:" then one line per alert, "{h:mm a} · {event label} · Open", oldest first.
- No visitor names, contact details or message text.

## Tokens used

`--space-4`, `--space-6`, `--color-text-secondary`, `--color-border-default`, `--type-body`, `--type-body-sm`, and the tokens of the components above. The email's inline colours come from `tokens.json` light values at build time (`templates.ts` imports `@kaki/design-tokens` values if exported, otherwise a constant with a comment naming the token).

## Gaps and escalations

- Telegram and web push columns appear when FEAT-037 and FEAT-048 add them to `channels`; the layout already handles more than one column.
- The top bar's notifications control (ux-foundations IA) has no feature in the plan; not part of SCR-APP-056.
- Manifest: SCR-APP-056 added with FEAT-052, `code-native`, the states above and the three bindings; SCR-APP-055 gains the "notifications card" state as a supplement.
