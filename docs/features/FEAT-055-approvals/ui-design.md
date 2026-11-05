# UI design: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry

> Screens: SCR-APP-017 (new: Approvals), SCR-APP-018 (new: Approval; link-landing states are FEAT-056), SCR-APP-042 (p: approval SLA, approvers), SCR-WGT-002 (p: waiting for approval, quote card, notices), SCR-APP-014 (p: sidebar approval, dividers) · Mode: per-feature · Status: Draft · Date: 2026-11-05

Components from design.md: `approval-card`, `chip`/`status-badge`, `table`/`list`, `tabs`, `alert`, `dialog`, `confirm-dialog`, `text-input`, `textarea`, `empty-state`, `error-state`, `skeleton`, `toast`, `nav-item` and `tab-bar-item` badges. Terms: *approval*, *quote*, S$ amounts "S$58.00", times "2:30 pm", dates "18 Nov 2026" (SGT).

## SCR-APP-017 — Approvals

`/approvals`, every member (Agents without rights see it read-only, D8). Sidebar and tab-bar Approvals item show the pending count (pill, `--color-pending-soft`; hidden at 0).

- **Header:** `page-title` "Approvals"; lede "Quotes, discounts and promises your assistant needs you to confirm. Nothing is sent to the visitor until someone decides."
- **Tabs:** "Pending" (count pill) · "Decided" (last 30 days). The tab is in the URL (`?view=decided`).
- **Rows** (`table` ≥ 768, stacked `list` below), each one link to `/approvals/:id`:
  - Type `chip` (Quote / Discount / Promise; neutral, with the `approvals` icon), headline ("200 × Vanilla cupcake · 15% off"), contact name or "Website visitor", total "S$595.00" (or "Price to set" when no line matched), asked time ("2:14 pm" / "Yesterday").
  - Pending: SLA `chip`: "Due in 1 h 20 min" (pending), "Due in 25 min" (warning, < 30 min, urgent), "Overdue by 10 min · escalated" (danger). After hours: "Due Mon 10:00 am" (pending). An "Above your 10% max" warning `chip` when `aboveMaxDiscount`.
  - Decided: status `chip` Approved (success) / Approved with edits (success) / Rejected (neutral) / Expired (neutral) / Not delivered (danger), and "by Mei Ling · 2:31 pm".
- **Order:** pending: overdue first, then urgent, then by due time; decided: newest first. "Load more" (cursor).
- **Realtime:** a new or decided approval updates the list and count without reload; a row decided by someone else while visible moves out of Pending with a polite live-region note "Approval for Website visitor was decided by Mei Ling" (`aria-live="polite"`, not `role="status"`: E2E pitfall in code-map).
- **States:** loading (`skeleton` rows), empty Pending (`empty-state` icon approvals, "Nothing waiting for approval", "When a visitor asks for a quote, discount or promise, it appears here for you to confirm." action "Review your rules" → `/settings/rules`), empty Decided ("No decisions in the last 30 days"), error (`error-state` "Couldn't load approvals" + Try again).
- **Agent without rights:** an info `alert` above the tabs "You can see approvals but not decide them. Ask the Owner for approval rights."

## SCR-APP-018 — Approval

`/approvals/:id`. Desktop ≥ 1024: two columns (left 3/5: the `approval-card`; right 2/5: conversation excerpt and prices). Below 1024 one column: card, then prices, then the excerpt. Back link "Approvals" (phones: top-bar back).

- **Header:** `h1` "Quote for {contact or Website visitor}" (Discount / Promise by kind), meta "Asked 2:14 pm · Conversation" (link to `/inbox/:conversationId`), SLA `chip` as on the list.
- **What they asked** (`card`): "Items: 200 cupcakes for our office", "Quantity: 200", "Date: Friday", "Discount: 15%" (rows present only when given; text is the visitor's, shown as text). Above max: warning `alert` "They asked for 15%, above your 10% maximum. You can still approve it."
- **Draft** (`approval-card` body): the message the visitor will get, as a preview of the widget quote card (lines, discount, total, GST note "Prices include GST" / "Prices before GST", note). "Price to set" notice when no line: info `alert` "Your assistant couldn't match a price. Edit to add one."
- **Actions** (pending, can decide): `primary` "Approve and send", `secondary` "Edit", `secondary` danger-text "Reject". On phones the actions sit in a sticky footer above the tab bar.
- **Edit mode** (in place of the preview): a row per line: label `text-input`, quantity (numeric, width 96), unit price ("S$", numeric, 2 decimals), remove icon button "Remove {label}"; "Add a line"; "Discount" % field (0–100) with help "Your maximum is 10%"; "Note to the visitor" `textarea` (500, counter) with help "Sent as you write it, for example a delivery time."; live totals. Buttons "Approve and send" (`primary`) · "Cancel". Validation (on submit, `ErrorSummary`, focus to it): "Enter a quantity from 1 to 100,000", "Enter a price like 3.50", "Enter a whole number from 0 to 100", "Add a line or a note before sending". Leaving edit mode with changes asks "Discard your changes?" (`confirm-dialog`).
- **Reject** (`dialog`, bottom sheet on phones): title "Reject this request?", body "The visitor is told your team couldn't confirm it and will follow up.", `textarea` "Reason (only your team sees this)" required, error "Enter a reason"; buttons "Cancel" · "Reject" (danger).
- **After a decision:** `toast` "Quote sent to the visitor" / "Request rejected. The visitor was told." and the page shows the decided state.
- **Prices used** (`card`, right column): one row per snapshot: name, "S$3.50 / piece", a fact `chip` link to the fact; when the fact has changed since: warning `chip` "Price changed since". None: "No prices from your facts were used."
- **Conversation** (`card`): up to 10 latest messages up to the request, as read-only `message-bubble`s, and "Open conversation".
- **States:**
  - pending (actions enabled); **deciding** (the pressed button busy "Sending…", others disabled; the form is read-only);
  - **decided by someone else** (409, or seen live): `alert` info "Already approved by Mei Ling at 2:02 pm" (or "rejected", "approved with edits"), actions disabled, the decided terms shown; focus moves to the alert;
  - **decided** (by me or anyone; terms and decider shown; rejected shows the reason to staff);
  - **expired**: `alert` neutral "This request expired on 25 Nov 2026. The visitor was told your team will contact them." actions hidden;
  - **not delivered**: `alert` danger "Approved, but we couldn't reach the visitor: their chat has ended and they left no email or phone." with "Open conversation";
  - **cannot decide** (Agent without rights): buttons shown disabled with tooltip "Ask the Owner for approval rights";
  - loading (`skeleton` of the card), not found (`empty-state` "This approval doesn't exist or isn't in this business" + "Back to approvals"), error (`error-state` + Try again).
  - Link expired / already used are FEAT-056.

## SCR-APP-042 — Rules and approvals (partial: Approvals section)

Replaces FEAT-054's caption in section 4 ("Approvals", settings variant only), same Save and re-auth as the rest of the form.

- `field` "Reply within" numeric `text-input` (width 96) with a "business hours" suffix select ("minutes" / "hours"; stored as minutes), default 2 hours; help "Your assistant tells visitors when to expect an answer. If no one decides in time, the conversation is escalated. After 7 days the request expires." Error "Enter a time from 15 minutes to 48 hours".
- "Who can approve": a read-only list of names with role ("Kim Tan · Owner", "Mei Ling · Agent with approval rights") and a link "Manage on Team" → `/settings/team`. Admins see the same.
- Section 2's help text becomes "0% means your assistant never offers a discount. Larger discounts go to you for approval."

## SCR-WGT-002 — Chat panel (partial)

- **Waiting for approval** (`system-notice`, the existing style): "Thanks! Our team is checking this and will reply by 4:15 pm today." / after hours "…will reply on the next business day, Mon 9:00 am." / repeat "Our team is still checking your earlier request and will reply by 4:15 pm." zh-Hans: 「谢谢！我们的团队正在确认，预计今天下午 4:15 前回复您。」, 「…下一个工作日（周一上午 9:00）回复您。」, 「我们的团队仍在确认您之前的请求，预计下午 4:15 前回复。」
- **Quote card** (on a system message; read-only): title "Your quote" / 「您的报价」; lines "200 × Vanilla cupcake" left, "S$700.00" right (tabular), under each "S$3.50 each" muted; a "15% off" row "−S$105.00"; a divider; "Total" bold "S$595.00"; GST caption "Prices include GST"; the note as a paragraph. `--kaki-surface` on `--kaki-subtle` border `--kaki-border`, radius `--kaki-radius`; works at 320 px (labels wrap, amounts don't). `role="group"` with `aria-label="Your quote"`; no list markup inside the message `ol` other than a nested `ul` of lines (axe list rule, FEAT-049 lesson: no `li role`).
- **Rejected:** notice "Our team couldn't confirm this one, but they'll follow up with you." / 「我们的团队暂时无法确认这个请求，稍后会跟进联系您。」
- **Expired:** notice "Sorry for the wait. Our team will contact you about this request." / 「抱歉让您久等了，我们的团队会就这个请求联系您。」

## SCR-APP-014 — Inbox (partial)

- **Sidebar, Approval section** (above Lead): when a pending approval exists: "Waiting for approval" pending `chip`, "Due 4:15 pm", link "Open approval" → `/approvals/:id`. None: the section isn't shown.
- **Dividers:** "Assistant asked the team to approve a quote", "Mei Ling approved the quote", "Mei Ling approved the quote with edits", "Mei Ling rejected the request", "The approval expired" — caption with the time.
- The thread shows the quote card message as a system bubble with the same card (read-only) and the caption "Sent after approval".

## Tokens used

Dashboard: `--color-pending-default`/`-soft`, `--color-conversation-approval-fg`/`-bg`, `--color-warning-soft`/`-fg`, `--color-danger-soft`/`-fg`, `--color-success-soft`/`-fg`, `--color-info-soft`/`-fg`, `--color-bg-surface`, `--color-bg-subtle`, `--color-border-default`, `--color-text-primary`, `--color-text-secondary`, `--radius-md`, `--radius-lg`, `--space-2`…`--space-6`, `--size-control-md`, `--size-control-lg`, `--type-caption-size`, `--font-weight-medium`; amounts use `font-variant-numeric: tabular-nums` (design.md numbers rule, not a token). Widget: `--kaki-surface`, `--kaki-subtle`, `--kaki-border`, `--kaki-text`, `--kaki-muted`, `--kaki-radius`, `--kaki-font`. No new tokens.

## Gaps and escalations

- FEAT-056: signed link landing, link expired, already used (SCR-APP-018). FEAT-066: approval analytics (APR-05). Delivery on other channels arrives with FEAT-036+ (the card's text body is what they send).
- design.md names the type "Commitment"; the UI says "Promise" as plainer English for owners (terminology list doesn't fix this word). If Ken prefers "Commitment", it's a copy change only.
