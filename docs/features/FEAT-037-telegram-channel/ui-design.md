# UI Design: FEAT-037 — Telegram channel

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E5) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-039 (new), SCR-APP-056 (p: Telegram column and link), SCR-APP-036 (p: Connect entry, Telegram card), SCR-APP-014 (p: Telegram conversations) · Mode: per-feature · Status: Draft · Date: 2026-11-09

No design tool is connected and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `card`, `chip`/`status-badge`, `button` (`primary`, `secondary`, `ghost`, `danger-ghost`, `danger`), `confirm-dialog`, `form-dialog`, `field`, `text-input`, `alert`, `toast`, `skeleton`, `error-state`, `empty-state`, `link`, `toggle`, `list`, `message-bubble`. No new component or token. Icons (Lucide, 20 px): `send` for Telegram (with text "Telegram" wherever it's the only cue), `bell` for alerts, `users` for groups.

## SCR-APP-039 — Telegram

- **Strategy and source:** code-native (this section).
- **Route:** `/settings/channels/telegram`; breadcrumb "Settings / Channels / Telegram". Reached from Channels' Connect entry ("Telegram · Set up") and the Telegram card's "Telegram settings" link. Owner and Admin see the whole page; an Agent sees only the "Alerts on Telegram" card (their own link) with the caption "Only the Owner and Admins can change the bot." (tech design §3: the link routes are every member's).
- **Contract bindings:** `GET`/`POST`/`DELETE /api/v1/channels/telegram`, `PUT …/token`, `POST`/`DELETE /api/v1/me/notifications/telegram(/link)`, `GET /api/v1/me/notifications`.
- **Layout:** title "Telegram", lede "Your assistant answers customers who message your Telegram bot, from your approved facts." One column at reading width. When connected, a caption under the lede: "Status: {Live | Offline} · Change it on `link` Channels." (go live and offline stay on Channels).

**Not connected** (`connected: false`), card "Connect your bot":
- Numbered steps (body, ordered list): 1 "In Telegram, open `link` @BotFather (opens Telegram) and send /newbot." 2 "Pick a name and a username ending in “bot”." 3 "BotFather sends you a token like 123456789:AA… Copy it." 4 "Paste it below."
- `field` "Bot token" (`text-input`, `autocomplete="off"`, `spellcheck=false`, mono, help "We store it encrypted. Anyone with this token can control your bot, so don't share it elsewhere.") and `primary` "Connect bot" (busy "Connecting…").
- Errors on the field (NFR-19): `invalid_format` "That doesn't look like a bot token. It's the line BotFather sent, like 123456789:AA…"; `token_rejected` "Telegram didn't accept this token. Copy it again from BotFather, or send /token there for a new one."; `bot_in_use` "This bot is already connected to another business on KakiAgent. Create a new bot with /newbot."; `provider_unavailable` "We couldn't reach Telegram. Try again in a minute."; `already_connected` → reload alert.
- Success: page re-renders connected, focus on the bot card heading, toast "@{username} is connected. Go live on Channels when you're ready."

**Connected**, card "Your bot" (heading = bot name):
- Line: `send` icon, "@{username}", `link` "Open in Telegram" (`bot.link`, new tab), health chip (OK success-soft "Working"; degraded danger-soft "Not working").
- Status line (body-sm): `lastReceivedAt` → check "Last message {relative time}."; none → clock "No messages yet. Send your bot a message to try it." (works only once live; offline: "Messages wait in your inbox until you go live.")
- **Private chats only** note (`alert` info, `users` icon): "Your bot answers private messages only. If someone adds it to a group, it says so once and leaves. To stop that, send /setjoingroups to @BotFather and choose Disable."
- Ignored (title-sm "Ignored in the last 7 days"): "{n} group messages", "{n} stickers, photos or voice messages", "{n} messages from team members' alert chats" (non-zero only; none → caption "Nothing ignored yet.").
- Actions: `secondary` "Replace token" → `form-dialog` "Replace the bot token" (body "Use this after you send /revoke to @BotFather. It must be for @{username}."; the token field; `primary` "Replace" busy "Replacing…"; errors as above plus `different_bot` "This token is for a different bot. Disconnect first to switch bots."; success toast "Token replaced." and focus back to "Replace token"). `danger-ghost` "Disconnect bot" → `confirm-dialog` (`role=alertdialog`) "Disconnect @{username}?" body "Your assistant stops answering on Telegram, and your team's Telegram alerts stop. Past conversations stay in the inbox." "Cancel" / `danger` "Disconnect" (busy "Disconnecting…"); success: not-connected state, focus on the token field, toast "Bot disconnected."
- **Degraded** (`health = degraded`), `alert` danger at the top of the card, by reason: `credential_revoked` "Telegram stopped accepting the bot token, so customers aren't getting replies. Get a new token with /token in @BotFather, then replace it here." with `primary` "Replace token"; `credential_invalid` "Your bot is connected to another service, so its messages don't reach us. Disconnect it there, then check again." with `secondary` "Check again" (FEAT-034's check, 429 caption "You can check again in a few seconds."); `unreachable` "We can't reach Telegram right now. We'll keep trying." with "Check again".
- `409 stale` on any action → `alert` "Someone else changed this. Reload to see the latest." + `link` "Reload".

**Alerts on Telegram** card (`bell` icon; heading "Get your alerts on Telegram"), shown when connected, for every role:
- not linked: body "Get escalations, approvals and hot leads on Telegram as well as by email." `secondary` "Link my Telegram" (busy "Getting link…") → state pending.
- pending: body "Open the link and press Start in Telegram." `primary` link-button "Open Telegram" (`url`, new tab) and caption "The link works for 15 minutes." The page re-fetches every 3 s until linked or expired; linked → toast "Telegram linked. Alerts will arrive there too." and focus to the card heading; expired → back to not linked with caption "The link expired. Get a new one."
- linked: "Alerts go to {name} on Telegram since {date}." `link` "Choose which alerts" → `/account/notifications`; `ghost` "Unlink" (no dialog; toast "Telegram alerts stopped.").
- Owner/Admin caption: "{alertMembers} people on your team get alerts here."

**States:** loading (skeleton cards), error (`error-state` "We couldn't load your Telegram settings." + "Try again"), Agent view, not connected, connecting, each token error, connected offline, connected live, no messages yet, degraded revoked, degraded elsewhere, degraded unreachable, replace dialog (and its errors), disconnect confirm, alert link not linked / pending / expired / linked, conflict.

## SCR-APP-056 — My notifications (partial)

- When `channels` includes `telegram`: the Alerts card's column headers read "Email" · "Telegram"; each event row has a second switch, name "Telegram alerts: {label}". Below 640 each switch keeps its visible label.
- The help line becomes "Alerts go to {email} and to Telegram ({name})." when linked; when not linked, the Telegram switches are disabled with the help "Link your Telegram to turn these on." and a `link` "Link Telegram" to `/settings/channels/telegram#alerts` (the same card, which Agents can see); pending reads "Waiting for you to press Start in Telegram."
- New row `channel_degraded` (Owner/Admin only): "A channel stops working" / "When a channel like Telegram or email can't send or receive."
- Quiet hours help: "Alerts that arrive in this window come as one email (and one Telegram message) when it ends."
- Test card: success toast "Test alert sent to {sentTo} and Telegram." when `telegram` is true.
- All Telegram switches off while linked: no extra alert (the email one stays as FEAT-052).

## SCR-APP-036 — Channels (partial)

- Connect section row "Telegram", `send` icon, caption "Answer customers who message your Telegram bot.", `secondary` "Set up" → `/settings/channels/telegram`.
- Telegram card: `send` icon, "@{username}" in the meta, `link` "Telegram settings". Offline-mode radios: `hidden` "Don't reply" (help "Messages wait in your inbox for your team."), `message` "Reply with a message" (help "Each new chat gets your message once."). The degraded alert's fix line: "Replace the bot token on the Telegram page." with `link` "Telegram settings".

## SCR-APP-014 — Inbox (partial: Telegram conversations)

- Channel filter option "Telegram" after "Email". Rows: the `send` glyph with `aria-label` "Telegram".
- Thread header: contact name, caption "On Telegram · @{username}" (username omitted when null). Sidebar Contact: a `CopyRow` "Telegram @{username}".
- Placeholder messages ("[Sticker]", "[Voice message]", "[Photo]", "[File]", "[Location]") render as an ordinary visitor bubble in `--color-text-secondary` italics with the caption "Not shown: Telegram {kind}".
- Delivery line reason `blocked`: "Not delivered: the customer blocked the bot" (Retry stays).
- Escalation strip: `delivery_failed` reuses FEAT-036's text.

## Tokens used

`--color-success-soft`, `--color-danger-soft`, `--color-info-soft`, `--color-text-secondary`, `--color-danger-default`, `--color-border-default`, `--font-family-mono`, `--space-*`, `--radius-md`, `--radius-lg`. Nothing hard-coded.

## Gaps and escalations

- Inline-keyboard cards (consent, withdraw) on Telegram are a follow-up (technical-design D11); the screens show none.
