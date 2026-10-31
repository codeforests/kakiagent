# UI design: FEAT-042 — Inbox and conversation

> Screens: SCR-APP-014 Inbox (new), SCR-APP-015 Conversation (p: completes the anchor's layouts and the waiting-for-approval, closed and flagged states; FEAT-043/045/047 add takeover, composer, suggestion, notes) · Contracts: technical-design §3 · Strategy: code-native (this file is the spec; SCR-APP-015's < 768 px anchor prototype stays the visual reference)
> Status: designed · 2026-10-31

Design values come only from design.md and tokens (`var(--…)`). Product voice per design.md §6; the UI never names internal codes.

## Layout (design.md §3, inbox rule)

- **≥ 1280:** three panes inside the shell's content area at full width: list 360 px · thread (flexible) · context sidebar 320 px. With no conversation selected the thread pane shows an `empty-state` "Pick a conversation" (no action) and the sidebar pane is absent.
- **1024–1279:** list 360 px · thread; the sidebar is a right drawer (the `slide-over` from `@kaki/ui`, 320 px) opened by the header's "Conversation details" icon button (`aria-label`, Lucide `info`).
- **< 1024:** one pane at a time. `/inbox` shows the list; `/inbox/:id` shows the thread full-screen with a back button to the list (keeps the view's query string). The sidebar opens as a bottom sheet (`dialog` < 640 behaviour; on 640–1023 the same right drawer).
- The thread pane scrolls inside a fixed-height region so the header and dock stay visible (anchor responsive notes); safe-area insets on header and dock below 768.
- Selecting a row navigates to `/inbox/:id` (a link: `<a>` row, `aria-current="true"` on the selected row at ≥ 1024).

## SCR-APP-014 — Inbox

### Page header
`h1` "Inbox" with the live state (testid `live-state`, kept): "Live" (success dot), "Connecting…", "Reconnecting…" (warning dot). Reconnecting also shows an inline `alert` (info) above the list: "Reconnecting. New messages will appear when the connection is back." The list stays visible (stale data is kept, design.md §4.8).

### Views and filters
- `tabs` (underline, scroll horizontally on mobile): **Open** · **Escalated** · **Waiting for approval** · **Flagged** · **Closed**, the first four with a neutral count pill from `counts` (hidden at 0). The selected tab sets `?view=` (Open is the default and leaves the URL as `/inbox`).
- A `select` "Channel": "All channels" · "Website chat" (one option per `channel` value; more arrive with FEAT-036+). Sets `?channel=`.
- Assignee filter: not shown until FEAT-043.

### Row (`list` row, testid `conversation-row`, inside `ul` testid `conversation-list` labelled "Conversations")
- `avatar` (28 px, initials "WV" for Website visitor) with the channel badge glyph (widget).
- Primary: "Website visitor"; secondary: the last message, one line, ellipsis (testid `conversation-preview`; "No messages yet" when null).
- Right: time (`Intl` en-SG, Asia/Singapore: time today, "Yesterday", else `d MMM`) with `<time dateTime>`; below it the state `chip` from `--color-conversation-<state>-fg/-bg` with its icon and label: AI handling · Escalated · Human · Waiting for approval · Closed. A flagged conversation adds a danger `chip` "Flagged" (Lucide `flag`) before the state chip.
- Rows are 64 px (72 on touch), divider `--color-border-default`, hover subtle, selected `--color-accent-soft`.

### Pagination
"Load more" `button` (secondary, full width) under the list while `nextCursor` is set; shows a spinner while loading; an error keeps the rows and shows an inline `alert` (danger) "Couldn't load more conversations." [Try again].

### States
- **Loading:** skeleton rows (6) in the row layout, `aria-busy`.
- **Empty (Open view, no conversations at all):** `empty-state` "No conversations yet" — "New chats appear here as soon as a visitor writes." [Check your widget] → `/settings/widget`.
- **Empty view:** per view, no action: Escalated "Nothing escalated. Conversations a visitor asks to hand to a person appear here." · Waiting for approval "Nothing waiting for approval." · Flagged "No flagged conversations. Conversations with abuse or a crisis message appear here." · Closed "No closed conversations yet."
- **Filtered-empty** (a channel filter is set): "No conversations match these filters." [Clear filters].
- **Error:** `error-state` "Couldn't load conversations" [Try again].
- **Live update:** a row that matches the view moves to the top; one that leaves the view (closed in Open) is removed; an `aria-live="polite"` region announces "New message from Website visitor" at most once per 5 s (not on every segment).

## SCR-APP-015 — Conversation

### Header
Back (icon button, < 1024 only, "Back to inbox") · avatar · "Website visitor" (`h2`) · state `chip` · Flagged `chip` when flagged · caption "Website chat · started 14:02" · right: "Close conversation" (`button` secondary, sm; in an overflow `menu` "More actions" below 640) when the state isn't closed · "Conversation details" icon button below 1280.

### Thread (`role="log"`, `aria-label="Conversation"`, `aria-live="polite"` only for new messages)
- `message-bubble` per message: visitor left (surface + border), AI right (`--color-accent-soft`, label "Assistant"), staff right (`--color-info-soft`, label the staff name, FEAT-043 onward), author label and time above. Masked values appear as stored (GOV-04).
- **Fact chips** under each AI message with `factIds`: small neutral chips "Used: Chocolate fudge 1 kg" (one per fact, label from the sidebar's fact list, link to `/knowledge/facts/:id`); a fact no longer approved shows its status in the chip ("· disabled"). More than 3 collapse into "+2 more" (a button expanding the list).
- **System notices** stored on messages (after hours, chat ended) render as their own caption under the message, as the widget showed them.
- **Dividers** (centred caption rows with a rule) from `events`, placed by time between messages: "Closed by Mei Ling · 14:32" · "Closed after 30 minutes without messages · 14:32" · "Visitor ended the chat · 14:32" · "Assistant stopped: repeated abuse · 14:32" · "Reopened by a new visitor message · 15:10" · "Flagged: crisis message · 14:05" / "Flagged: abuse" · later features' changes "Escalated", "Waiting for approval", "Handed back to the assistant" (generic: "Status changed to {state}"). The name falls back to "A team member" when null.
- **Show earlier messages** button at the top when `hasEarlier`; loads the previous page and keeps the scroll position.
- On open the log scrolls to the latest message; a new message while scrolled up shows a "New message ↓" pill instead of jumping.

### Dock (bottom region; FEAT-043 replaces the AI states' text with the takeover bar)
- **AI handling / escalated:** "The assistant is handling this conversation." (escalated: "The visitor asked for a person. The assistant keeps answering until someone takes over.")
- **Human:** "A team member is handling this conversation."
- **Waiting for approval:** "Waiting for approval. The assistant keeps answering other questions."
- **Closed:** "Closed {reason text} {time}. A new message from the visitor reopens it." For visitor or abuse closes: "Closed. This chat can't be reopened; the visitor can start a new one."
- Dock text is `--type-body-sm`, text-secondary, on subtle fill, with the state's icon.

### Close
"Close conversation" sends `{ version }`; the button shows a spinner and is disabled meanwhile. Success: toast "Conversation closed", the chip, divider and dock update (from the response and the WebSocket event). 409 `already_closed` or `state_changed`: inline `alert` (warning) at the top of the thread "This conversation changed while you were looking. It's now {state}." and the thread refetches. Other errors: alert (danger) "Couldn't close the conversation." [Try again]. Focus stays on the header after closing (the button is gone, so focus moves to the `h2`).

### Context sidebar (`context-sidebar`; collapsible sections, all open by default; `aside` labelled "Conversation details")
- **Contact:** "Website visitor" · "First seen 12 Oct" · "2 earlier conversations" (or "First conversation"). Caption: "Names and contact details appear once the visitor shares them." (FEAT-049).
- **Channel:** "Website chat".
- **Intent:** a list of signals with counts, from `intents`: Asked questions (3) · Wants to order or book · Left contact details · Asked for a person · Wants another channel · Privacy request · Out of scope · Abuse · Crisis message. None: "No signals yet."
- **Lead:** "No lead yet." (FEAT-049 fills it.)
- **Facts used:** fact chips with use count ("×2"), linking to the fact; none: "The assistant hasn't used any facts in this conversation yet."
- Bottom sheet / drawer: title "Conversation details", close button, focus to the title on open and back to the trigger on close; Esc closes.

### States
- **Loading:** skeleton header, 4 bubble skeletons and skeleton sidebar sections.
- **Not found** (404, e.g. another workspace's link): `empty-state` "This conversation isn't available" — "It may belong to another workspace." [Back to inbox].
- **Error:** `error-state` "Couldn't load this conversation" [Try again].
- **AI handling, escalated, human, waiting for approval, closed, flagged:** the chip, dock and dividers above.

## Tokens used
`--color-conversation-{ai,escalated,human,approval,closed}-{fg,bg}`, `--color-danger-*` (Flagged), `--color-accent-soft`, `--color-info-soft`, `--color-surface`, `--color-subtle`, `--color-border-default`, `--color-text-secondary`, `--space-*`, `--radius-{md,lg,full}`, `--type-*`, `--size-control-*`, `--shadow-lg` (drawer).

## Gaps and escalations
- Takeover bar, composer, suggestion (FEAT-043, FEAT-045), notes and tags (FEAT-047), search box (FEAT-046), assignee filter (FEAT-043) are later partials of these screens.
- The anchor's intent block (current page, pages viewed, UTM) needs page context the widget doesn't send yet (technical-design §8).
