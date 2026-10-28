# UI Design: FEAT-034 — Channel framework: adapter contract, go-live and go-offline per channel, health and degraded alerts

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E5) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-036 (new), SCR-WGT-005 (new, partial: not live), plus the dashboard's degraded-channel banner (design.md `banner` #3) · Mode: per-feature · Status: Draft · Date: 2026-10-27

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables (the widget only `--kaki-*`). Components: `card`, `chip`/`status-badge`, `button` (`primary`, `secondary`, `danger-ghost`, `danger`), `confirm-dialog`, `radio`, `field`, `textarea`, `alert`, `banner`, `toast`, `skeleton`, `error-state`, `link`; widget: `panel-header`, `system-notice`. No new component or token.

**Status chip** (one per channel, text and icon always): Live — success-soft, check icon, "Live"; Offline — neutral (subtle fill, text-secondary), circle-pause icon, "Offline"; Not working — warning-soft, alert-triangle icon, "Not working", shown **next to** Live or Offline when health is degraded (D4).

**Health reason copy** (`healthReason` → sentence): `credential_revoked` "The connection was removed or its access was revoked."; `credential_invalid` "The saved login for this channel no longer works."; `unreachable` "We couldn't reach the service for the last 10 minutes."; `send_rejected` "The service refused our last message." Fix line for all: "Reconnect it, or take it offline so visitors aren't left waiting." (Reconnect arrives with each channel's own screen, FEAT-036+.)

## SCR-APP-036 — Channels

- **Strategy and source:** code-native (this section).
- **Route:** `/settings/channels`, linked from the Settings row "Channels" ("Where your assistant answers"). Breadcrumb "Settings / Channels". Roles: Owner, Admin (`settings.manage`); Agents get the permission state "Only the Owner and Admins can change channels."
- **Contract bindings:** `GET /api/v1/channels`, `POST /api/v1/channels/:id/live`, `POST /api/v1/channels/:id/offline`, `PUT /api/v1/channels/:id/offline-settings`, `POST /api/v1/channels/:id/check`.
- **Layout:** title "Channels", lede "Where your assistant answers visitors. Your assistant never replies on a channel that's offline." One column at reading width; one `card` per channel in registry order.
- **Channel card:**
  - Header row: channel icon (Lucide `message-circle` for the widget, 20 px), name ("Website chat widget"), status chip(s) on the right (stacked under the name below 480 px).
  - Meta (body-sm, text-secondary): live "Live since {d MMM yyyy, h:mm a}"; offline after being live "Offline since {…}"; offline never changed "Not live yet". When `checksHealth`: "Last checked {relative time}" or "Not checked yet".
  - Action (right-aligned, one per card): offline → `primary` "Go live"; live → `danger-ghost` "Go offline". Busy state: the dialog's confirm button shows "Going live…" / "Going offline…" and the card's button is disabled.
  - Degraded: an `alert` (warning) inside the card under the header: title "This channel isn't working", body = reason copy + fix line, action `secondary` sm "Check again" (only when `checksHealth`). After a check: still degraded → the alert stays with "Still not working. Checked just now."; recovered → toast "{name} is working again." A 429 → inline caption "You can check again in a few seconds."
  - **"While offline" section** (inside the card, under a divider, always visible so the owner sets it before going live): heading (title-sm) "While it's offline"; `radio` group "What visitors see" with only the modes in `offlineModes`:
    - "Hide the chat button" — help "Visitors don't see the chat on your website."
    - "Show a message" — help "Visitors see the chat button, your message and your contact details, but can't chat."
    - With "Show a message": `field` "Message (English)" `textarea` (max 300, counter), placeholder = the English default; `field` "Message (中文)" `textarea` (max 300), placeholder = the Chinese default, help "Shown to visitors whose browser is set to Chinese. Leave empty to use the default." The English field's help: "Leave empty to use: “{default}”".
    - Contact line (caption): with profile contacts "Visitors also see {email} and {phone} from your Business profile." / without "Add an email or phone in your Business profile so visitors can reach you." Both end with `link` "Business profile" (`/settings/business-profile`).
    - Preview (subtle fill, radius md, `aria-label` "What visitors see"): the resolved English message, then the contact lines as they will appear. Hidden for "Hide the chat button".
    - Footer: `secondary` "Save" (disabled until changed; there may be one `primary` per region, and Go live is it), toast "Saved. Visitors see this while {name} is offline." Errors: "Keep the message under 300 characters ({n} now)."
- **Go live** `confirm-dialog`: title "Go live on {name}?"; body "Your assistant will start answering visitors here. It answers only from facts you've approved, and you can go offline at any time."; buttons `secondary` "Cancel" (left), `primary` "Go live". Success: toast "Your assistant is live on {name}." Focus returns to the card's action button (now "Go offline").
- **Go offline** `confirm-dialog`: title "Take {name} offline?"; body "Your assistant stops answering here right away. While it's offline, visitors {see your message and contact details | don't see the chat button}. Visitors in a chat now get your offline message." (the clause follows the saved mode); buttons `secondary` "Cancel", `danger` "Go offline". Success: toast "{name} is offline."
- **Connect a channel:** rendered only when `connectable` isn't empty (D10): heading "Connect a channel", one `secondary` link-button per entry to its `connectPath`.
- **States:** loading (one skeleton card); error (`error-state` "We couldn't load your channels." [Try again]); live; offline never live; offline since; degraded (alert in the card, banner); confirming (dialog open); acting (confirm busy, never optimistic: the chip changes only after the server answers); saving (offline form read-only, button "Saving…"); validation errors (summary `alert` danger listing fields as links, focus to it); conflict (`alert` danger in the card "Someone else changed this channel. Reload to see the latest." [Reload]); action failed (`alert` danger in the dialog "We couldn't {go live | go offline}. Check your connection and try again.", dialog stays open); permission.
- **Responsive:** below 768 px the card's action moves under the meta line, full width; dialogs become bottom sheets (design.md `dialog`).
- **A11y:** chips carry text; the radio group has a `legend`; the preview is a labelled region; dialogs trap focus and return it to the trigger; status changes are announced through the toast (`role="status"`).

## Banner — Degraded channel (app shell, `shell/banners.tsx`)

- design.md `banner` #3, warning, for Owners and Admins only, on every authenticated page; dismissible for the session (dismissing hides it until another channel degrades or the page reloads). Priority order and the two-banner limit live in the slot so FEAT-057's "AI paused" (#1) slots in above it.
- Copy: one channel "{name} isn't working. Visitors there may not get replies." [Fix in Channels]; more than one "{n} channels aren't working. Visitors there may not get replies." [Fix in Channels]. The link goes to `/settings/channels`. Hidden on the Channels page itself (the card alert says it).
- Data: `useChannels()` refetched every 60 s and on window focus; no banner while loading or on error.

## SCR-WGT-005 — Fallback (partial: not live)

- **Strategy and source:** code-native (this section; anchor-screens.md "fallback" state).
- **Contract binding:** `GET /widget/v1/config` → `availability`.
- **Hidden** (`{ live: false, mode: 'hidden' }`): the loader adds nothing to the page (no launcher, no host element). The install is still recorded.
- **Message** (`{ live: false, mode: 'message' }`): the launcher shows as usual. The panel opens with the normal `panel-header` (bot name, "AI assistant" label, menu with the privacy notice when set; no "End chat" since there's no chat), then one `system-notice` card in place of the log:
  - The message in the panel language: zh text when the browser locale starts with `zh`, else en (FEAT-033's chrome follows the same rule before any reply).
  - Contact lines, each only when present: mail icon + `link` "{email}" (`mailto:`), phone icon + `link` "{phone}" (`tel:`, shown as stored, e.g. +65 6123 4567). Chinese chrome labels: "电邮" / "电话"; English: "Email" / "Phone" (visually hidden prefixes for screen readers, the icons are decorative).
  - No composer, no greeting, no disclosure row (no AI speaks). The privacy footer link shows when set.
  - Focus on open: the card's text (`tabindex="-1"`), so screen readers read the message first.
- **Mid-chat offline:** no special view; the agent's offline message arrives as a normal `system` message in the log and the composer stays (staff can still see and answer what the visitor writes).
- **Strings** (`strings.ts`): `notLiveEmail` "Email" / "电邮", `notLivePhone` "Phone" / "电话", `notLiveRegion` "Message from {business}" / "来自{business}的消息" (the card's accessible name).
- **Out of scope here:** the contact form (FEAT-049, UX-R4), the AI-paused text and banner pill (FEAT-057), the provider-outage notice (already the agent's fallback message).
- **A11y:** the card is a labelled region; links have visible focus; `--kaki-*` colours only, clamped as the rest of the panel.

## Gaps and escalations

- Reconnect actions on the degraded alert wait for each channel's connect screen (FEAT-036 email, FEAT-037 Telegram, FEAT-040 Meta).
- Email and Telegram alerts for degraded channels: FEAT-052, FEAT-037 (technical-design D6).
- No escalation against design.md: every component exists; the status chip's "Offline" uses the neutral chip already used for "Draft" states.
