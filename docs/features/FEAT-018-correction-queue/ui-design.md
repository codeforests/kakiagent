# UI Design: FEAT-018 — Correction queue and old-versus-new replay

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-021 (new), SCR-APP-022 (new); SCR-APP-030 (extended: confirm card link) · Mode: per-feature · Status: Draft · Date: 2026-10-24

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so both screens are code-native specs. Every value comes from design.md and `tokens.json`; front ends use `var(--…)` only. They use design.md §4.6's `correction-item` (built here) and `answer-compare` (FEAT-028's rendering, moved to a shared file), plus `tabs`, `chip`, `data-list`, `dialog`/`form-dialog`, `alert`, `progress`, `empty-state`, `error-state`, `skeleton`, FEAT-011's fact fields and FEAT-027's `quick-coach-panel`. No new component or token.

Origin labels (chip text, neutral soft fill with a 12 px icon): `coaching` "Coaching", `stale` "Overdue for review" (warning-soft), `thumbs_down` "Visitor 👎", `staff_reply` "Staff reply", `staff_edit` "Staff edit", `oversight` "Oversight", `coverage_gap` "Coverage gap". The last five appear once their features produce items.

## SCR-APP-021 — Review · Corrections

- **Strategy and source:** code-native (this section).
- **Route:** `/review/corrections`, the third Review tab ("Facts · Conflicts · Corrections", count pill = open items). Roles: Owner, Admin (`kb.manage`); others get the permission state "Only the Owner and Admins can work the correction queue."
- **Contract bindings:** `GET /api/v1/corrections`, `GET|PUT /api/v1/kb/review-intervals`, `GET /api/v1/kb/review/summary`.
- **Page head:** title "Review", the tabs, lede "Signals that something your assistant says may be wrong. Nothing changes until you accept a fix." Secondary action `ghost` "Review intervals".
- **Filters:** a segmented control "Open · Closed" and a source `select` ("All sources", then the origin labels present). Filters live in the query string.
- **Open list** (`data-list`, newest first): each row is a compact `correction-item`: origin chip, a one-line fix summary ("Price of Chocolate fudge 1 kg: $52.00 → $58.00", "New FAQ: Do you deliver on Sundays?", "Opening hours for Sat, Sun", "Re-confirm: Chocolate fudge 1 kg, last confirmed 7 months ago"), the facts involved as chips (a "Deleted" chip when a fact is gone), and relative age. The row links to SCR-APP-022. Stale rows also carry an inline `secondary` "Re-confirm" (one tap, KB-17): success → row leaves the list with a toast "Re-confirmed. Chocolate fudge 1 kg stays as it is."; 409 → the row's inline alert "This fact changed since it was flagged." with a link to the item.
- **Closed list:** the same rows with the decision chip ("Accepted", "Edited and accepted", "Closed", "Closed automatically") and decision time, newest first.
- "Load more" `secondary` at the end when `nextCursor`.
- **empty (open):** `empty-state` "Nothing to correct", body "Corrections you teach in Coach and facts due for a check appear here." with a link "Practise in Coach". **empty (closed):** "No decisions yet." **empty (filtered):** "No open items from {source}." with "Show all sources".
- **loading:** five skeleton rows. **error:** `error-state` "Couldn't load corrections." [Try again].
- **Review intervals dialog** (`form-dialog`, title "Review intervals"): body "Facts not confirmed within these times are added here to check. They stay in use until you act." Four number fields with the suffix "months" (Products, FAQs, Policies, Promotions), 1–24, default 6; inline validation "Enter 1 to 24 months."; `primary` "Save", `ghost` "Cancel"; saved toast "Review intervals saved. The next daily check uses them."
- **Keyboard and a11y:** rows are links with the fix summary as their name; the inline Re-confirm is a separate button after the link; the segmented control is a radio group; axe clean.

## SCR-APP-022 — Correction

- **Strategy and source:** code-native (this section).
- **Route:** `/review/corrections/:id`. Roles as SCR-APP-021.
- **Contract bindings:** `GET /api/v1/corrections/:id`, `POST …/accept`, `POST …/close`, `POST …/replay/next`.
- **Page head:** back link "Corrections", title = the fix summary, the origin chip and "Suggested {relative time}".

### open

- **Where it came from** (section, h2): coaching item: the owner's message as an owner bubble and the assistant's proposal text, with a link "Open in Coach" to the session; item with a conversation: the excerpt as message bubbles (FEAT-042 will add a link to the conversation); stale item: "Last confirmed {date}, {n} months ago. Your interval for {type} is {m} months." with a link "Change intervals" (opens the dialog on SCR-APP-021).
- **Facts involved** (h2): each fact's label, status chip and "Last confirmed {date}", linking to the Fact screen (SCR-APP-028).
- **Proposed fix** (h2): the diff (`correction-item`): per changed field, old value struck through on danger-soft, new on success-soft, with a text prefix ("Was", "Now") so colour is never the only signal. New FAQ: question and answer on success-soft. Hours: per changed day "Sat 9:00–17:00 → 10:00–18:00". Re-confirm: the current value, no diff, caption "No change. Re-confirming keeps this value and resets the review clock."
- **Actions:** `primary` "Accept" (re-confirm item: "Re-confirm"), `secondary` "Edit fix" (re-confirm item: "Edit fact"; hidden for hours items, with caption "To change other days, edit them in Business profile." linking the Business profile screen (SCR-APP-006)), `ghost` "Close with no change" (confirm dialog: "Close this suggestion? Nothing in your knowledge changes." [Close suggestion] [Cancel]).

### editing

- `form-dialog` "Edit fix": a fact item shows FEAT-011's fields for its type prefilled with the proposed value (the "Was" value as a caption above each field); an FAQ item shows question and answer. `primary` "Accept edited fix", `ghost` "Cancel". 422 `invalid_correction` shows the field errors or the alert "This edit doesn't change anything."

### applying

- The pressed button shows its spinner and the others disable. 409 `correction_stale`: page alert (warning) "This fact changed after the suggestion was made, so it wasn't applied." [Reload]. 409 `correction_closed`: "This suggestion was already decided." and the page reloads into the closed state.

### applied (comparison)

- Success banner: "Fix accepted. Your assistant now uses it." (re-confirm: "Re-confirmed. The review clock restarts today.").
- **Past answers** (h2, only when a replay exists): lede "{n} recent customer questions used this fact. Here's what they got and what your assistant says now." Over 20: caption "The 20 most recent of {matched}." Then FEAT-028's progress pattern: `progress` "Replaying {done} of {total}…" with `aria-live="polite"`, one `button` Pause / Continue replay; done: "Replay complete. {k} answers changed."
- **Turns:** one `answer-compare` row per question (ordered list, newest first): the customer's question bubble with its date; columns "What the customer got" and "What your assistant says now" (stacked below 768 px, original first); the `answer-explainer` and effect lines as in FEAT-028; a chip "Answer changed" (accent-soft) when `answerChanged`; nothing when the same. Pending: skeleton bubble "Waiting to replay"; answering: typing indicator.
- **No replay:** new FAQ: caption "No past answers used this yet, so there's nothing to compare."; hours: "Opening-hours answers aren't linked to past chats, so there's nothing to compare."; fact edit with no past use: "No customer has asked about this fact yet."
- **Errors:** a failed `…/replay/next` stops the loop with the turn's inline alert "Couldn't replay this question." [Retry]; 429 "Replaying quickly. Wait a minute, then continue." with Continue disabled for 60 s.

### closed

- Decision chip and time ("Closed by {name}" or "Closed automatically: the fact was confirmed or changed since."). For accepted items the comparison (if any) stays viewable; for edited ones the diff shows the accepted fix with a caption "Edited before accepting" and a disclosure "Show the original suggestion".
- **not-found:** `empty-state` "This suggestion isn't available." [Back to corrections]. **loading:** head skeleton and three skeleton sections. **error:** `error-state` "Couldn't load this suggestion." [Try again].
- **Keyboard and a11y:** sections have h2 headings; focus moves to the success banner after accept; replay results never steal focus; the diff reads "Was $52.00, now $58.00" to screen readers; axe clean.

## SCR-APP-030 — Coach (extended)

- The confirmed-correction card adds a link "See {n} past answers" to `/review/corrections/:id` when `replayQuestions` > 0. No other change.

## Gaps and escalations

- Gaps: the conversation link from an item (FEAT-042, SCR-APP-015); KB health tiles on Home (FEAT-065); "Add FAQ" for coverage gaps (FEAT-019, UC-16 3b); the "last confirmed" line on the Fact screen (FEAT-021).
- Escalations: none. No design-system change.
