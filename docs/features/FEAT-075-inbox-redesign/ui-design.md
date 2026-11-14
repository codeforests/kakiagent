# UI design: FEAT-075 — Inbox redesign

> Screens: SCR-APP-014 Inbox (p: layout, header, filters, views, rows, empty state), SCR-APP-015 Conversation (p: header, thread styling, dock placement, details panel layout) · Contracts: none (technical-design §3) · Strategy: code-native (this file is the spec)
> Visual reference: the approved prototype canvas "Inbox Redesign" (claude.ai artifact H1YQ1GsTSt3TSWQAUwbf2F, private to Ken; artboards Desktop, Phone · Inbox list, Phone · Conversation). It replaces `02-design/anchors/scr-app-015-conversation.html` as the reference for these screens (D3).
> Status: designed · 2026-11-14 · approved by Ken from the prototype

Design values come only from design.md and tokens (`var(--…)`). This file restates only what changes. Behaviour, copy and states not mentioned here stay as specified by FEAT-042 and its partials (FEAT-043, 044, 045, 046, 049, 050, 051, 055, 036, 037, 038, 029).

## Layout

| Width | Panes |
|---|---|
| ≥ 1280 | list 400 px · thread (flexible) · details 320 px. Nothing selected: list · empty state across the rest; no details pane. |
| 1024–1279 | list 360 px · thread; details as the right drawer (unchanged). |
| < 1024 | one pane at a time (unchanged); details as bottom sheet < 640, drawer 640–1023 (unchanged). |

- The inbox fills the height under the top bar and any banners; panes scroll independently and the page itself doesn't scroll at ≥ 1024. In the thread pane, header and dock are fixed and only the log scrolls (AC-1).
- Pane backgrounds: list and details `--color-bg-surface`; thread `--color-bg-canvas`; pane dividers `--color-border-default`.

## SCR-APP-014 — Inbox

### Header (list pane top, `--space-5` padding, `--space-4` gap between rows)
- `h1` "Inbox" (`--type-title`) and, beside it, the connection state as a caption with a 6 px dot (testid `live-state`): "Connected" (`--color-success-default` dot), "Connecting…", "Reconnecting…" (`--color-warning-default` dot). Text `--color-text-secondary`, `--type-caption`. Reconnecting keeps its info alert above the list.
- Row 2: search field (flex 1) + **Filters** button (secondary, `--size-control-md`, Lucide `sliders-horizontal`). Search: icon 16 px at `--space-4` inset; input padding-left `calc(var(--space-4) + var(--size-icon-sm) + var(--space-3))`; placeholder "Search name, phone or message" (AC-7). Phone: both 44 px tall, Filters becomes an icon button `aria-label="Filters"` (with count: "Filters, 1 active").
- Filters button: when filters are active it shows a count pill (`--color-accent-default` bg, `--color-text-on-accent`) and an accent border; `aria-expanded` reflects the panel.

### Filters panel (disclosure under row 2; not modal; Esc and the button close it)
- `--color-bg-surface`, `--radius-lg`, `--shadow-md`, border `--color-border-default`, padding `--space-4`, two columns (one column < 400 px): **Channel** (`All channels` · `Website chat` · `Email` · `Telegram`) and **Assigned to** (`Anyone` · `Mine` · `Unassigned` · teammates). Same selects, labels, values, testid and help text as today.
- Active filters row (shown when any filter is set, panel open or closed): one chip per filter, "Channel: Email ×", "Assigned: Mine ×" (`--color-bg-subtle`, border, `--radius-full`, `--type-body-sm`; button with `aria-label="Remove filter Channel: Email"`), then a text button "Clear all".

### Views (`nav` "Views", underline tabs, `--space-6` gap)
- Labels: **Open** · **Escalated** · **Approval** (`title="Waiting for approval"`) · **Flagged** · **Closed**. Count pills as today (hidden at 0; Closed has none); Escalated and Flagged pills use `--color-warning-soft` / `--color-warning-default`, others `--color-bg-subtle` / `--color-text-secondary`.
- Selected: `--color-text-primary`, semibold, 2 px `--color-accent-default` underline; others `--color-text-secondary`, medium.
- All five fit at ≥ 1024 (no scrollbar, AC-4). Below 640: Open · Escalated · Approval · **More ▾** (`menu` with Flagged and Closed; the trigger shows Flagged's count, and reads "Flagged ▾"/"Closed ▾" while that view is selected).

### Row (testids unchanged: `conversation-row`, `conversation-preview`, `conversation-owner`, `conversation-escalation`)
Grid: avatar 36 px (40 on phone) with the channel badge · content. Padding `--space-4` `--space-5`; divider `--color-border-default`; hover `--color-bg-subtle`; selected `--color-accent-soft`.
1. **Name** (semibold, ellipsis) · "· {channel}" (`--type-caption`, secondary) · time pushed right (`--type-caption`, secondary, `<time>`).
2. **Subject** (medium, one line) when the conversation has one (email).
3. **Preview**, full content width, `--type-body-sm`, secondary; one line on desktop, two lines on phone. Search results put the marked excerpt here.
4. **Chips and meta** (`--space-3` gap, wraps): Flagged chip (if flagged) · state chip · owner or escalation text ("For you · 58 min", "Mei Ling") in `--type-caption` secondary.
- **Urgent escalation:** one chip "Escalated · Urgent" (`--color-danger-soft` bg, `--color-danger-default` text, Lucide `triangle-alert`) in place of the two chips (AC-6). Non-urgent escalations keep the escalated chip.
- Party name: contact name, else `PARTY_LABEL` by channel (unchanged).

### Empty state, nothing selected (thread pane, ≥ 1024)
Centred, max width 360 px: 56 px circle (`--color-accent-soft`) with Lucide `message-square-text` in `--color-accent-default`; `h2` "Pick a conversation" (`--type-title`); "Choose a conversation from the list to read it. The visitor's details open beside it." (secondary). When `counts.escalated > 0` and the current view isn't Escalated, a card below (`--color-bg-surface`, border, `--radius-lg`): warning icon · "{n} escalated conversation(s) waiting." · text button **Show escalated** (→ `?view=escalated`, keeping filters). No details pane (AC-2).

### Selection on view and filter changes (D2)
Changing view, Channel or Assigned to keeps the open conversation only if it belongs in the result; otherwise the thread pane shows the empty state above. No toast or announcement; focus stays on the control that changed. A conversation that leaves the view through a live update stays open.

### States
Loading, empty, empty view, filtered-empty, error, load more and its error, live update and the polite announcement: as FEAT-042, restyled with the new row and pane layout. Filtered-empty's "Clear filters" also clears the chips.

## SCR-APP-015 — Conversation

### Header (≥ 640: one row, padding `--space-4` `--space-6`)
Avatar 36 px · title block: `h2` "{party} · {subject}" (or "{party}") `--type-title-sm` with the state chip (merged urgent chip when urgent) and Flagged chip inline; caption below "{channel} · started {time}" plus FEAT-036's delivery line where it applies · right: **Close conversation** (secondary, sm) · More actions (icon button, existing items) · Conversation details (icon button, < 1280 only).
**< 640:** Back (44 px) · title block (line 1: subject or party + chip, ellipsis; line 2: "{party} · {channel}") · Conversation details (44 px) · More actions (44 px; holds Close conversation) (AC-10).

### Thread (`role="log"`, unchanged semantics)
- Padding `--space-6`; `--space-4` between items; a centred day divider at the top and on day changes ("Today", "Yesterday", "12 Nov"), `--type-caption`.
- Bubbles: max 72% width (82% on phone); author label bold `--color-text-primary` + " · {time}" secondary above; visitor `--color-bg-surface` with border, radius `--radius-xl` with a 4 px corner on the sender's side; AI `--color-accent-soft`; staff `--color-info-soft` (unchanged colours). Visitor author = contact name, else party label by channel (AC-8).
- Fact chips under AI bubbles: "Used: {fact}" as `--radius-full` outlined chips on `--color-bg-surface` (behaviour unchanged).
- "Visitor saw" system notices: a centred box (`--color-bg-subtle`, `--radius-lg`, `--type-body-sm`) with Lucide `eye`, "**Visitor saw:** {text}".
- Event dividers: the caption sits in a pill (`--color-bg-surface`, border, `--radius-full`) on the rule. Copy unchanged.

### Dock (`flex: none`, `--color-bg-surface`, top border)
One row at ≥ 640: status title (medium) + one-line explanation (`--type-body-sm`, secondary) on the left; actions on the right (**Suggest a reply** secondary, **Take over** primary, or the composer when human-owned, as FEAT-043/045). Escalated copy: title "Escalated to you {age} · the visitor asked for a person", line "The assistant keeps answering until someone takes over. Reminded {n} times." **< 640:** text stacked above a two-column button row, buttons 44 px. Composer, suggestion card, takeover by someone else, waiting-for-approval and closed: unchanged content, restyled into this container.

### Details panel (`aside` "Conversation details", 320 px; drawer/sheet below 1280)
Sections separated by dividers, `--space-6` padding, section titles as `--type-caption` semibold uppercase secondary:
1. **Contact** — name (`--type-title-sm`), identifiers with Verified chip and copy button, "First seen … · n earlier conversations", View contact link (FEAT-039/049 content unchanged).
2. **Channel · Lead** — two columns: channel name; lead status or "No details yet" (FEAT-050 score and Open lead link, FEAT-051 consent state go here unchanged).
3. **Intent** — FEAT-029's web context (Now on, Viewed, Source, Returning) first, then triage signals as outlined tags (`--radius-full`, border).
4. **Approval** (FEAT-055, when present) — unchanged content.
5. **Facts used** — chips with counts, or the empty sentence.
Sections stay collapsible as today.

## Unchanged (must keep working, AC-11)
Search idle/searching/results/no results/error/opened-at-match/back-to-results and the top bar search entry (FEAT-046); takeover, hand back, someone else's conversation, concurrency alerts (FEAT-043); escalation assignee and reminders (FEAT-044); suggested reply (FEAT-045); contact, lead and consent sidebar and dividers (FEAT-049/050/051); approval sidebar and dividers (FEAT-055); email subject, delivery line and attachments (FEAT-036); Telegram and moved-channel states (FEAT-037/038); web context (FEAT-029); close, not found, error, loading skeletons (FEAT-042).

## Tokens used
`--color-bg-{canvas,surface,subtle}`, `--color-border-default`, `--color-text-{primary,secondary,on-accent}`, `--color-accent-{default,soft}`, `--color-success-default`, `--color-warning-{default,soft}`, `--color-danger-{default,soft}`, `--color-info-soft`, `--color-conversation-*-{fg,bg}`, `--space-3..6`, `--radius-{lg,xl,full}`, `--shadow-md`, `--type-{caption,body-sm,body,title-sm,title}`, `--size-control-{md,lg}`, `--size-icon-sm`. No new tokens.

## Gaps and escalations
- Unread state and a per-user escalated count were considered and left out (technical-design D6, D7).
