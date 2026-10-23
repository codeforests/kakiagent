# UI Design: FEAT-014 — Conflict detection and side-by-side resolution

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-020 (new, built here), SCR-APP-019 (p: counts), SCR-APP-008 (p: the conflict alert) · Mode: per-feature · Status: Verified · Date: 2026-10-23

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so SCR-APP-020 is specified here. It is the Review hub's second tab and reuses SCR-APP-019's anchor vocabulary (page head, `tabs`, single-column queue of max 880 px per anchor amendment A1, the source passage well, `toast`, `empty-state`, `error-state`) plus design.md's `conflict-compare` component, which this file binds to the FEAT-014 contracts. Every value comes from design.md and `tokens.json`; no new component or token is introduced.

## Cross-screen

- **Counts.** The Conflicts tab shows `conflicts` (open conflicts, not facts) as a danger count pill with the screen-reader text "conflicts". The Facts tab keeps `needsReview + conflicted`. The sidebar and tab-bar Review pill now shows `needsReview + conflicted`, still with "facts to review": a conflicted fact is waiting for the owner too (FEAT-013 showed `needsReview`; conflicts were always 0 then).
- **Value line**, as SCR-APP-019: Price "S$28.50 · GST incl." (GST unknown: "S$28.50" and the warning chip "GST treatment unknown"); Policy: title, then details as body; Promotion: title, "S$… · until 31 Oct 2026", details; FAQ: question, answer as body. Prices tabular.
- **Source line** under each value: the passage well (as SCR-APP-019: `before`, `<mark>` quote, `after`, text only) with the caption "Website · kakibakery.test · read 21 Oct 2026" and the page link (new tab). A fact entered by hand has no well; its caption reads "Entered by you · confirmed 20 Oct 2026". Dates in SGT (NFR-10).
- **Copy.** Toasts: "Conflict resolved. Your assistant uses S$28.50 from now on." (use, enter; the policy, promotion or FAQ title in place of a price) · "Disabled. Your assistant won't use {name} until you enable it in Knowledge." · "This conflict changed since you loaded it. Check it again." (409).

## SCR-APP-020 — Review · Conflicts

- **Strategy and source:** code-native (this section). Route `/review/conflicts`. Owner, Admin (`kb.manage`); an Agent gets "You can't review facts. Only the Owner or an Admin can resolve conflicts."
- **Composition:** page head as SCR-APP-019 (h1 "Review", lede "When your sources disagree, your assistant uses neither until you choose."; no Approve all on this tab), the hub `tabs` with Conflicts current, then one `conflict-compare` card per conflict, in the list's order (prices, policies, promotions, FAQs), max 880 px, single column.
- **Content and data mapping:** `GET /api/v1/kb/conflicts` (the cards), `GET /api/v1/kb/review/summary` (tab counts), `POST /api/v1/kb/conflicts/resolve` (every action; the request carries every member's `{ id, version }` from the card).

### default
Each card (`section`, labelled by its heading, `data-testid="conflict-card"`): a header row with the danger `status-badge` "⚠ Conflict", the type label (Price, Policy, Promotion, FAQ) and the h2 entity name ("Pandan chiffon cake · 20 cm"; FAQ: the question; policy and promotion: the title), and the line "{n} sources disagree. Your assistant won't use this until you choose." Then the **columns**, one per member in the API's order (newest first): two per row from 640 px, stacked below; each column a bordered panel (radius md, padding 16) with the value line, the "Newer" tag (an `info` chip with a clock icon, on the `newer` member only, and "Suggested" in its accessible name: "Newer, suggested"), the confidence for extracted facts ("90% confidence", as SCR-APP-019), the source line, and **Use this value** at the foot: `primary` on the suggested member, `secondary` on the others (all `secondary` when nothing is suggested). Below the columns, a footer row: `secondary` "Enter a different value…" and `ghost` danger-text "Disable this fact…". On desktop each card reads as a side-by-side comparison; the columns have equal height.
### gst-unknown column
"Use this value" on a column whose price has GST `unknown` first shows, inside that column, the radio group "Does this price include GST? (required)" ("Price includes GST" / "Price is before GST") and the help "Your assistant won't quote this price until you choose."; the button then sends the choice. Pressing it without a choice shows the field error "Choose whether the price includes GST" and moves focus to the group (as SCR-APP-019's GST card).
### enter dialog
A Radix dialog (bottom sheet below 640 px), title "Enter the right value", the kept fact's type-specific fields (the shared `FactFields` of SCR-APP-028, prefilled from the suggested member, or the first when none is suggested), the line "The other values will be rejected. You can see them later in the fact's history.", Cancel (`secondary`, first focus) and "Use this value" (`primary`, "Saving…" while it runs). Validation and the error summary as SCR-APP-028. A 409 closes the dialog and refreshes (the conflict toast).
### disable confirm
`ConfirmDialog`: title "Disable {name}?", body "Your assistant won't use any of these values. You can enable the fact again in Knowledge.", Cancel (first focus) and `danger` "Disable fact" ("Working…").
### resolved row
After a resolution the card collapses to a one-line row: "✓ Resolved · Pandan chiffon cake · 20 cm · using S$28.50" (success badge) or "Disabled · …" (neutral badge), with a "View in Knowledge" link to the kept fact. The row stays until the next refresh (no Undo, technical design D7); the toast confirms; the tab count updates.
### working and error
While a resolve runs, every action of that card is disabled and the pressed button shows its loading label ("Saving…"). A failed resolve shows an inline `danger` alert in the card, "We couldn't save this just now. Nothing was changed.", with the actions re-enabled. A 409 `conflict_changed` replaces the card with the fresh conflict from the response (or removes it if null), and the toast says it changed.
### loading
One skeleton card in the final layout (header, two columns with a value bar, a passage well and a button), `aria-busy`.
### empty
`empty-state` with a check icon: "No conflicts", "When two sources state different prices or rules for the same thing, you'll choose the right one here." and `secondary` "Back to facts" (→ `/review`). With facts still waiting for review: the same, plus the line "{n} facts are waiting for review."
### error
`error-state`: "We couldn't load your conflicts", "Nothing you resolved was lost." `secondary` "Try again".
### permission
An Agent opening `/review/conflicts` sees the permission empty state (403 from the API).

- **Responsive notes:** below 640 px the columns stack (newest first), every action is full width at 44 px, and the footer actions stack under the last column; dialogs are bottom sheets. No horizontal scroll at 375 px.
- **Live regions:** the toast is `role="status"`; a polite region announces "{n} conflicts to resolve" after each refresh.
- **Accessibility:** each column is a `group` labelled "From kakibakery.test, read 21 Oct 2026" (or "Entered by you"); "Use this value" carries the value in its accessible name ("Use S$28.50 from kakibakery.test"); the Newer chip has text, never colour alone.
- **Decisions:** the per-column action carries the value in its name (driver: several "Use this value" buttons on one screen are otherwise ambiguous to screen readers). The suggested column's button is `primary` (driver: KB-17 "suggests the newer one"; design.md's one-primary-per-region rule); with no strictly newer source, none is primary so the screen doesn't suggest what the data doesn't. The disable action is `ghost` with danger text behind a confirm (driver: it takes the entity out of answers; design.md destructive-action pattern).

## SCR-APP-019 — Review · Facts (partial)

- **Changes:** the Conflicts tab shows the `conflicts` pill instead of no count; the conflicted card's "Resolve conflict" link goes to `/review/conflicts` (unchanged), and its flag reads "Conflicts with another source" (unchanged). No other change; the anchor spec and FEAT-013 ui-design stand.

## SCR-APP-008 — Wizard · Review your facts (partial)

- **Changes:** when `conflicts > 0`, a `warning` alert above the queue: "{n} conflicts need your choice. Facts that disagree stay out of answers until you resolve them." with the link "Resolve conflicts" (→ `/review/conflicts`). It closes FEAT-013's gap "conflicts in the wizard" for this screen; the wizard frame stays FEAT-035's.
