# UI design: FEAT-044 — Escalation routing, "talk to a person", reminders

> Screens: SCR-WGT-002 Chat panel (p: Talk to a person enabled, asking and failed states, escalation notice), SCR-APP-014 Inbox (p: assignee and wait on escalated rows, Urgent chip, assignee filter rule), SCR-APP-015 Conversation (p: escalation strip, divider), SCR-APP-045 Team (p: Escalation routing card, D2) · Contracts: technical-design §3 · Strategy: code-native, extending FEAT-033's, FEAT-043's and FEAT-007's ui-design.md · design.md §4.2 `radio`, `select`, `text-input`; §4.3 `toast`, `alert`; §4.4 `card`, `chip`; §4.6 `composer` (takeover bar); §4.9 widget menu and `system-notice`
> Status: designed · 2026-11-01

## SCR-WGT-002 — Chat panel (partial)

- **Menu item** (FEAT-033's header menu, first item): "Talk to a person" / "转人工客服", now shown whenever `controls.talkToPerson` is true and the chat isn't ended, escalation-pending or staff-handled (`menuItems`). Same 44 px item, icon none.
- **Asking**: pressing it closes the menu, returns focus to the menu button, and adds a transient `system-notice` row at the log's end "Asking the team…" / "正在联系团队…" (`askingTeam`) with the existing three-dot pulse (respects `prefers-reduced-motion`: static dots). It is replaced by the stored notice from the response (or SSE, deduped by `seq`).
- **Escalated** (stored notice, server text in the chat's language): business hours "I've asked the team to join. Someone will be with you shortly; I can keep answering questions until then." · after hours "I've let the team know. We're closed now, so they'll reply from tomorrow 9:00 am. I can keep answering questions until then." Rendered as the existing `system-notice` row; announced by the log's `aria-live="polite"` like other messages. The menu item stays hidden until a `staff_joined` then `staff_left` notice, or a new chat.
- **Already with a person** (`with_person`, a race): no row; the menu item hides (staff notice already shown).
- **Failed**: the transient row becomes the existing error row "Couldn't reach the team. Try again." / "无法联系团队，请重试。" (`escalateFailed`) with the `Retry` button (FEAT-022's error-retry pattern); 409 `closed` shows FEAT-033's ended state instead.
- **No conversation yet**: the panel creates it silently, then escalates; the greeting and disclosure rows stay above the notice.
- **Disclosure row**: the core now ends "A person can take over at any time." / "您可以随时要求真人客服接手。" (server text; AGT-11).
- Tokens: `--kaki-surface`, `--kaki-subtle`, `--kaki-muted`, `--kaki-text`, `--kaki-border`, `--kaki-accent` (focus); nothing new.

## SCR-APP-014 — Inbox (partial)

- **Escalated rows**: under the preview, where FEAT-043 shows the owner, an unowned escalated conversation shows "For Mei Ling · 6 min" (or "For you · 6 min"; "For a team member" when the name is missing), caption, text-secondary; the time is `waitingFor(since)` ("just now", "N min", "N h", then the date), refreshed with the list's existing minute tick. An owned conversation shows the owner as before.
- **Urgent chip**: a `chip` "Urgent" (`--color-danger-soft` / `-fg`, 12 px alert icon) after the state chip when `escalation.urgent`. The text is always present, never colour only.
- **Assignee filter**: unchanged control; "Mine" and a named teammate now also list unowned escalations assigned to them, "Unassigned" lists neither owned nor assigned. The helper text under the select (visually hidden, `aria-describedby`): "Who has it, or who it was escalated to."
- **Live update**: a `conversation` event carrying a new or resolved `escalation` moves the row in or out of Escalated and the assignee filter (`matchesView`).

## SCR-APP-015 — Conversation (partial)

- **Escalation strip** (escalated, no owner): FEAT-043's takeover bar text for escalated becomes two lines: "Escalated to Mei Ling 6 min ago. The visitor asked for a person." (source `visitor_button`/`visitor_asked`) or "… A reply couldn't be checked, so the assistant asked the team." (`unverified`), then "The assistant keeps answering until someone takes over." When it's mine: "Escalated to you 6 min ago. …". After hours adds "Asked after hours; the visitor was told when you open." Reminders sent: caption "Reminded 2 times". `Take over` unchanged.
- **Divider**: "Escalated to Mei Ling · visitor asked for a person · 14:02" (or "· reply couldn't be checked"). Notice-only `escalated` messages render as FEAT-043's caption row "Visitor saw: I've asked the team to join…".
- States added: escalated (mine / someone else's / unassigned), after hours, reminded.

## SCR-APP-045 — Team (partial): Escalation routing card

Below the members list and invitations, a `card` titled "Escalations" (h2), intro text "When a customer asks for a person, who should we alert?"

- **Mode** (`radio` group, legend "Send escalations to"): "Take turns — everyone on the team, one after another" (round_robin, default) · "Always one person" (person). Choosing "Always one person" reveals a `select` "Person" listing active members by name (from `GET /api/v1/inbox/members`), required.
- **Reminders**: `text-input` type number, label "Remind them after", suffix "minutes", min 1, max 240, default 10, width 96 px; help "Counted in your opening hours. From the third reminder, owners and admins are reminded too."
- **Save** (`button` primary, disabled until changed) and `Cancel` (secondary, resets). Saving: "Saving…" spinner. Success: toast "Escalation settings saved". Errors: FEAT-058's `ErrorSummary` pattern: "Choose a person" (person mode, none chosen), "Enter a number from 1 to 240", 422 `person_not_member` "That person is no longer on the team. Choose someone else." Network failure: alert (danger) "Couldn't save. Your changes are still here." [Try again].
- **Person inactive** (`personInactive`): alert (warning) at the top of the card "Mei Ling is no longer on the team, so escalations are taking turns. Choose someone else or keep taking turns."
- **Read-only** (Agent): the same card with the settings as text ("Escalations take turns across the team. Reminders after 10 minutes.") and no controls.
- **Loading / error**: the card's skeleton (two lines) and FEAT-008's `CardState` error with [Try again].
- Phone (< 640): card full width, radios stacked, the select and input full width, Save full width; no horizontal scroll.

## Tokens used
`--color-surface`, `--color-subtle`, `--color-border-default`, `--color-border-strong`, `--color-text-secondary`, `--color-danger-soft`/`-fg` (Urgent chip, errors), `--color-warning-*` (person inactive), `--color-conversation-escalated-*` (existing state chip), `--space-*`, `--radius-{md,lg,full}`, `--type-*`, `--size-control-*`; widget `--kaki-*` as above.

## Gaps and escalations
- After-hours lead capture under the escalation notice: FEAT-049. Web push for escalations: FEAT-048; Telegram alerts: FEAT-037.
- "Assign to…" on an escalation without taking over: not designed (technical-design §8).
