# UI design: FEAT-043 — Take over and hand back, single owner

> Screens: SCR-APP-015 Conversation (p: takeover bar, composer, owned-by-someone-else bar, takeover dividers, staff bubbles), SCR-APP-014 Inbox (p: assignee filter, owner on rows), SCR-WGT-002 Chat panel (p: staff joined and left notices, staff messages with the name) · Contracts: technical-design §3 · Strategy: code-native, extending FEAT-042's ui-design.md and the anchors (anchor-screens SCR-APP-015 ai-handling, human-mine, human-other; SCR-WGT-002 human) · design.md §4.6 `composer`, `message-bubble`; §4.9 widget `system-notice`, `message`
> Status: designed · 2026-10-31

## SCR-APP-015 — Conversation (partial)

The dock (FEAT-042's bottom region) now switches by `dockMode(summary, me)`. It stays docked above the safe-area inset; the thread scrolls above it.

### Takeover bar (state AI handling, escalated or waiting for approval, no owner)
- Text: AI handling "The assistant is handling this conversation." · escalated "The visitor asked for a person. The assistant keeps answering until someone takes over." · waiting for approval "Waiting for approval. The assistant keeps answering other questions."
- `Take over` (`button` primary, md). "Suggest a reply" is FEAT-045 and not shown.
- Pressing it: the button shows a spinner, "Taking over…", disabled. Success → the composer replaces the bar, focus moves to the textarea, toast "You took over. The assistant is paused here." and a divider "You took over · visitor sees "Mei Ling joined the chat."" (the `notice.notice` text from the response).
- 409 `owned`: inline `alert` (warning) above the dock "Mei Ling took this over just now." and the dock becomes the owned bar. 409 `state_changed`: "This conversation changed while you were looking. It's now {state}." and the thread refetches (FEAT-042's alert). 409 `closed`: "This conversation was closed." Other errors: alert (danger) "Couldn't take over." [Try again].

### Composer (state human, owner = me)
- `composer`: label "Reply to visitor" (visually hidden `label`), textarea auto-growing to 6 lines, placeholder "Write a reply…", `Send` (`button` primary). Ctrl/Cmd+Enter sends; Enter adds a line (phones have no modifier). Attach and saved replies are FEAT-041/047 and not shown.
- Above it a caption row: "You're handling this conversation. The assistant is paused." and `Hand back to assistant` (`button` secondary, sm; in the "More actions" `menu` below 640 alongside Close).
- Sending: Send shows a spinner and is disabled, the text stays in the box until the 201, then clears; the message appears in the log from the response (and the socket event, deduped by `seq`). Empty or whitespace-only: Send disabled. Over 4000 characters: inline error "Keep replies under 4,000 characters." under the textarea, `aria-describedby`.
- Send failure: the text stays, inline `alert` (danger) "Couldn't send. Your reply is still here." [Try again] (retries with the same `clientMessageId`). 409 `not_owner`: alert (warning) "{name} has taken over this conversation. Your reply wasn't sent." and the dock becomes the owned bar; the draft text is kept in the textarea's place as a read-only quote with [Copy] so it isn't lost.
- Hand back: no confirmation (it is undone by taking over again). Spinner, then toast "Handed back to the assistant", divider "You handed back · visitor sees "Mei Ling left the chat. The assistant will keep helping you."", the takeover bar returns and focus moves to `Take over`.
- Close (FEAT-042) stays in the header for the owner.

### Owned bar (state human, owner ≠ me)
- Text "Mei Ling is handling this conversation." (`ownerText`, "A team member" when the name is missing), with the owner's `avatar` (initial).
- `Ask Mei Ling to hand over` (`button` secondary). Sent: the button becomes "Request sent" (disabled, check icon) for 60 s, toast "Mei Ling has been asked to hand over." 409 `not_owned` (it was handed back meanwhile): the takeover bar returns with alert "It's back with the assistant. You can take it over."
- For owners and admins (`Me.canReassign`, D1): a second `button` tertiary "Take over from Mei Ling" opening `ConfirmDialog`: title "Take over from Mei Ling?", body "Mei Ling can no longer reply here. They'll be told you took over.", confirm "Take over" (primary), cancel "Cancel"; `busyLabel` "Taking over…". Focus returns to the trigger on cancel and to the composer on success.
- Close is hidden for non-owners (D6).

### Owner's notifications (any page)
- `handover_requested`: toast (info, stays 10 s, not auto-dismissed while focused) "Ken asks you to hand over a conversation." [Open conversation] → `/inbox/:id`.
- `taken_from_you`: toast (warning) "Ken took over a conversation you were handling." [Open]; an open thread refetches and its dock becomes the owned bar.
- Toasts announce through the existing `aria-live` region.

### Thread
- Staff bubbles (FEAT-042's `message-bubble` staff variant, right, `--color-info-soft`): label is the author's name ("You" for your own), time above.
- Notice-only system messages (`staff_joined`, `staff_left`) render as a caption row "Visitor saw: Mei Ling joined the chat." (text-secondary, the widget glyph) rather than a bubble.
- Dividers from events: "Mei Ling took over · 14:05" · "Mei Ling handed back to the assistant · 14:20" · "Ken took over from Mei Ling · 14:12" · "Ken asked Mei Ling to hand over · 14:10". Names fall back to "A team member".

### States added
- human-mine (composer), human-other (owned bar), take-over pending, send pending, send failed, not owner, request sent, take-from dialog, owner conflict alert.

## SCR-APP-014 — Inbox (partial)

- **Assignee filter**: a `select` labelled "Assigned to" next to the channel filter: Anyone (default) · Mine · Unassigned · then each teammate by name (`GET /api/v1/inbox/members`, cached 5 min). URL `?assignee=me|none|<userId>`; the default leaves no parameter. Below 640 it sits in the same filter row, which wraps. A filter with no results shows FEAT-042's filtered-empty state with Clear filters (which also clears the assignee). Members failing to load: the select shows Anyone, Mine and Unassigned only.
- **Rows**: a human conversation's row shows the owner under the preview: small avatar initial + "Mei Ling" (or "You"), caption, text-secondary.
- **Live update**: a `conversation` event whose owner changes moves the row in or out of the filtered list (`matchesView`).

## SCR-WGT-002 — Chat panel (partial; state human)

- **Joined**: the `system-notice` row "Mei Ling joined the chat." (server text, in the chat's language). The assistant's typing indicator is not shown while staff handle the chat (D8).
- **Staff message**: bubble on the left on `--kaki-info-bg` (existing `.msg.staff`) with a name line above the text: "Mei Ling" (caption, `--kaki-muted`), else "A team member" / "团队成员". Screen readers hear "Mei Ling: {text}" (the name is part of the bubble's text, not `sr-only` only).
- **Left**: `system-notice` "Mei Ling left the chat. The assistant will keep helping you."; the next visitor message shows the typing indicator again.
- **Reconnect**: notices and staff messages replay over SSE like other messages, so a reloaded panel shows the same rows.
- The disclosure row and header ("AI assistant") are unchanged: the visitor is still told the chat includes an AI (AGT-11).

## Tokens used
`--color-info-soft` (staff bubbles), `--color-surface`, `--color-subtle`, `--color-border-default`, `--color-text-secondary`, `--color-warning-*` / `--color-danger-*` (alerts), `--space-*`, `--radius-{md,lg,full}`, `--type-*`, `--size-control-*`; widget `--kaki-info-bg`, `--kaki-muted`, `--kaki-text`.

## Gaps and escalations
- "Suggest a reply" in the takeover bar and the suggestion in the composer: FEAT-045. Attachments and saved replies in the composer: FEAT-041, FEAT-047. A staff typing indicator in the widget: not planned (D8).
