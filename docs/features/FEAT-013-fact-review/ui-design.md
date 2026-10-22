# UI Design: FEAT-013 — Fact review, bulk approval and Approve all

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-019 (anchor screen; built here), SCR-APP-008 (new, partial: the facts queue in the setup, without the wizard frame or coverage summary) · Mode: per-feature · Status: Verified · Date: 2026-10-22

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`. SCR-APP-019 was designed and signed off as an anchor screen ([anchor-screens.md](../../02-design/anchor-screens.md#scr-app-019--review--facts), [prototype](../../02-design/anchors/scr-app-019-review-facts.html)); this file binds that spec to the FEAT-013 contracts, resolves its "assumed shapes", and adds the states the contracts introduce. Every value comes from design.md and `tokens.json`; no new component or token is introduced. The anchor's component vocabulary is used as is: `fact-card`, `approve-all-dialog`, the sticky bulk bar, `tabs`, `toast`, `empty-state`, `error-state`.

## Cross-screen

- **Review hub tabs.** Under the page head, the underline tab row of the Knowledge pattern (route links in a `nav` with `aria-label="Review"` and `aria-current="page"`): **Facts** (`/review`, warning count pill with `needsReview + conflicted`) · **Conflicts** (`/review/conflicts`, placeholder until FEAT-014) · **Corrections** (`/review/corrections`, placeholder until FEAT-018).
- **Nav badge.** Sidebar and tab-bar entry "Review" show `needsReview` as a warning count pill with the screen-reader text "facts to review" (the Knowledge pill keeps "failed"). It refreshes after every decision and with the Sources poll.
- **Entity-type groups and labels (KB-16 order):** Prices (`product`) · Policies (`policy`) · Promotions (`promotion`) · FAQs (`faq`). The card's type label: Price, Policy, Promotion, FAQ.
- **Fact value line** (title-sm, prices tabular): Price "S$55.00 · GST incl." (GST unknown: "S$36.00" and the flag chip); Policy: its title, kind in the meta; Promotion: title, then "S$… · until 31 Oct 2026"; FAQ: the question, the answer as body under it.
- **Confidence:** "92% confidence" in text-secondary; below 70 % the warning-text colour with a "!" icon (design.md `fact-card`).
- **Source passage well:** `blockquote.passage` with `before`, the quote in `<mark>` (accent-soft highlight), and `after`, as text (never HTML), then a caption "Website · read 21 Oct 2026" and the link "kakibakery.test/cakes ↗" (new tab). Manual facts (rare in review) have no well.
- **Flags:** "GST treatment unknown" (warning chip) on priced facts with `gstTreatment: 'unknown'`; "Conflicts with another source" (danger chip) on conflicted facts.
- **Copy for the decisions' toasts:** "Approved. Your assistant uses it from now on." · "Rejected. Your assistant won't use it." · "12 facts approved." · "41 facts approved." (Approve all) · each with Undo. Undo: "Back in review." Skips: "10 approved. 2 need your choice first: set the GST treatment or resolve the conflict." / "1 changed since you loaded it and was skipped."
- **Dates** in SGT, "21 Oct 2026" (NFR-10).

## SCR-APP-019 — Review · Facts

- **Strategy and source:** code-native: anchor spec plus this section. Route `/review`. Owner, Admin (`kb.manage`); an Agent gets the "You can't review facts" empty state (they don't see Review in the nav, ux-foundations §IA).
- **Composition (as the anchor):** page head (h1 "Review", lede "Your assistant only uses facts you approve. Prices, policies and promotions are listed first.", `secondary` "Approve all…"), tabs, filter row (Source `select`: "All sources" + one option per `bySource` row, "kakibakery.test (12)"; Type `select`: "All types", Prices, Policies, Promotions, FAQs; the keyboard hint at ≥ 640 px), the sticky bulk bar while any card is selected, then the groups with their counts, each a column of `fact-card`s (max 880 px, single column, A1).
- **Scoped Approve all (KB-16 "by source or by entity type"):** with a filter set, the page-head button reads "Approve all from kakibakery.test…", "Approve all prices…", or "Approve all … from …" for both; the dialog then previews that scope.
- **Content and data mapping:** `GET /api/v1/kb/review/facts` (pages of 50, "Load more facts" at the end), `GET …/review/summary` (tab count, filters, empty state), `GET …/review/preview` (dialog), `POST …/approve-all`, `POST /kb/facts/:id/approve|reject`, `POST …/review/approve|reject` (bulk bar), `POST …/review/undo`.

### default
Cards with selection checkboxes ("Select Chocolate fudge cake, 1 kg"). **Approve** (`primary`) on a card: the button loads, then the card collapses to the one-line done row "✓ Approved · Chocolate fudge cake, 1 kg · S$55.00 [Undo]" and the toast confirms; after 5 s (paused while the toast has focus or hover) the row leaves the queue on the next refresh. **Reject** (`ghost`): the same with a neutral "Rejected" badge. **Edit and approve** (`secondary`) opens the edit dialog. A conflicted card shows its flag and only `secondary` "Resolve conflict" (→ `/review/conflicts`), no checkbox.
### gst-unknown card
The flag chip, then inside the card a radio group "Does this price include GST? (required)": "Price includes GST" / "Price is before GST", with the help "Your assistant won't quote this price until you choose." Approve sends the choice; Approve without a choice shows the field error "Choose whether the price includes GST" and moves focus to the group. Its checkbox is enabled: bulk approval skips it and the toast says why.
### edit-and-approve dialog
A Radix dialog (bottom sheet below 640 px), title "Edit and approve", the fact's type-specific fields exactly as SCR-APP-028 (same component), the source passage well under the fields for reference, then Cancel (`secondary`) and "Approve fact" (`primary`, "Approving…" while it runs). Validation as SCR-APP-028 (summary alert, field errors). Saving with nothing changed approves as is. 409 `version_conflict` shows the warning alert "Someone else changed this fact. Close and reload to see it." with Reload.
### bulk-selection
The sticky bar (top of the list ≥ 768 px, above the tab bar below): checkbox "Select all shown" (indeterminate when some), "**3 selected** of 12 shown", `primary sm` "Approve 3", `ghost sm` "Reject", `ghost sm` "Clear". Approve/Reject run the bulk call; approved and rejected cards collapse to done rows, the toast gives the count with Undo, and skipped cards stay selected with the skip message.
### approve-all (dialog)
`approve-all-dialog` on the `ConfirmDialog`: title "Approve 41 facts?" (scoped: "Approve 12 facts from kakibakery.test?"), a table "Type · Facts" with one row per type with a count above 0 and a Total row, a `warning` alert when `excluded` is non-zero: "2 prices with an unknown GST treatment and 1 conflicted fact aren't included. Review them one by one.", and the note "Each approval is recorded in the audit log with your name and the time." Cancel (first focus) and "Approve 41 facts" (`primary`; "Working…" until the server answers). While the preview loads, the dialog shows a skeleton table and the confirm is disabled. On success: the dialog closes, the queue refreshes (to the remaining cards or empty), and the toast says "41 facts approved." with Undo. On 409 `preview_stale` the dialog stays open, the table updates to the fresh preview, and an `info` alert says "Some facts changed while this was open. Check the new count, then approve." With a count of 0 the page-head button is hidden.
### loading
Two skeleton cards in the final layout (badge line, title, passage well, button row), `aria-busy`.
### empty
`empty-state`: "No facts waiting for review", "New facts show up here after a source finishes reading. Your assistant is using {approvedInUse} approved facts." and `primary` "Add a source" (→ `/knowledge/sources/new`). Filters, bulk bar and Approve all are hidden. With filters set and nothing matching: "No facts to review here" with `secondary` "Show all facts".
### still-extracting (info)
When `sourcesBusy > 0`, an `info` alert above the list: "We're still reading 1 source. More facts appear here when it's done." The summary and list poll every 2 s while it shows (FEAT-012 D6), and stop when the tab is hidden.
### error
`error-state`: "We couldn't load your facts", "Nothing you approved was lost." `secondary` "Try again". A failed decision shows an inline `danger` alert on that card ("We couldn't save this just now. Nothing was changed.") with its actions re-enabled; a 409 on a card refreshes the queue and the toast says "This fact changed since you loaded it."
### keyboard
With focus on a card (each card is focusable, `tabindex="0"`, outline on focus): `J`/`K` move focus to the next/previous card, `A` approve, `E` edit and approve, `R` reject. Keys are ignored while focus is in an input, select, textarea or dialog, and when a modifier is held. The hint lists them; `aria-keyshortcuts` is set on each card.
### permission
An Agent opening `/review` sees the empty state "You can't review facts. Only the Owner or an Admin can approve facts." (403 from the API).

- **Responsive notes (as the anchor):** below 640 px the card actions stack full width (44 px) and the source link drops under the badge line; the bulk bar wraps its label; the dialogs are bottom sheets. No horizontal scroll at 375 px.
- **Live regions:** the toast is `role="status"`; a polite region announces "{n} facts to review" after each refresh.
- **Decisions:** the GST choice sits in the card rather than forcing the edit dialog (driver: it is the one missing field, and KB-15 makes it a reviewer's decision; rejected: a disabled Approve, which hides why). Done rows stay until the next refresh instead of disappearing at once (driver: Undo needs a target and the owner's place in the list shouldn't jump).

## SCR-APP-008 — Wizard · Review your facts (partial)

- **Strategy and source:** code-native (this section). Route `/setup/review`. The same `ReviewQueue` component as SCR-APP-019, without the hub tabs: step text "Step 3 of the setup", h1 "Review your facts", lede "Approve what your assistant may tell customers. You can change any fact later in Knowledge.", the queue, and at the bottom a `primary` "Continue" (→ `/`, until FEAT-035's next step) with the caption "Facts you haven't approved stay out of answers." The setup's sources step (`/setup/sources`) gains a `ghost` "Next: review your facts" link to it.
- **States:** loading, still-extracting (the info alert above, which is this screen's "E (still extracting)"), populated, all-approved (`empty-state` "All your facts are reviewed" with the approved count and Continue), error, as SCR-APP-019.
- **Gaps:** the wizard frame (FEAT-035), conflicts in the wizard (FEAT-014), and the coverage summary (FEAT-019).
