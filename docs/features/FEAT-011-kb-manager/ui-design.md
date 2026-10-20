# UI Design: FEAT-011 — KB manager

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-027 (extended), SCR-APP-028 (extended) · Mode: per-feature · Status: Verified · Date: 2026-10-20

No design tool is connected and the manifest policy is `code-native`. Both screens already have code-native entries from FEAT-022, so this document **extends** those specs ([FEAT-022 ui-design](../FEAT-022-grounded-verified-answer/ui-design.md#scr-app-027--facts)) and doesn't restate what is unchanged: the page heads, the empty, loading, error and permission states, and the form validation pattern. The manifest entries keep `feature: FEAT-022` (provenance). Their spec locators gain this file, and their bindings gain the new endpoint.

## SCR-APP-027 — Facts

- **Strategy and source:** code-native (this section, on top of FEAT-022's). Route `/knowledge`.
- **Composition changes:**
  - **Filter row:** search (placeholder now "Search facts, e.g. cake or refund"), then a `select` **Type**: All types · Products and services · FAQs · Policies · Promotions. Then the **Status** `select`: All · Approved · Disabled · Needs review · Rejected · Conflicted · **GST to check**. "GST to check" sends `gst=unknown` instead of a status. The filters wrap to two lines below 768 px.
  - **Table:** the same columns. Type shows "Product", "FAQ", "Policy" or "Promotion". Value shows:
    - Product: `S$55.00 · GST incl.`, or for an unknown treatment the warning `chip` "GST to check" in place of the GST label.
    - FAQ: the answer's first line.
    - Policy: kind label and the details' first line ("Refunds · Whole cakes can be refunded…").
    - Promotion: price with its GST label, if it has a price, then "Until 31 Oct 2026". When `validUntil` is past, a neutral `chip` "Ended" replaces it, and when `validFrom` is in the future, "Starts 1 Nov 2026".
  - **Row actions:** a last, unlabelled column holds an `icon-button` (⋯, `aria-label` "Actions for {fact title}") opening a `menu`:
    - "Stop using in answers" (approved facts) or "Use in answers" (disabled facts).
    - Then, after a divider, "Delete…" in danger text.
    - Needs-review, rejected and conflicted facts show only "Delete…", because their approval belongs to Review (FEAT-013/014).
  - On the mobile stacked list, the ⋯ button sits after the status chip, and the 44 px target is kept.
  - **Pagination:** below the table, a `secondary` button "Load more facts" while `nextCursor` is set. It appends the next 50 rows, and its loading state is "Loading…". The live region announces "{n} facts shown".
- **Content and data mapping:** `GET /api/v1/kb/facts?type&status|gst&q&cursor` (`limit` defaults to 50). Disable and enable use `PATCH /api/v1/kb/facts/:id` `{ version, status }`. Delete is `DELETE /api/v1/kb/facts/:id?version=` with the row's version.
- **Conformance:** pass, with one recorded decision on pagination (below).

### default, loading, empty, filtered-empty, error, permission
These are as in FEAT-022. "Clear filters" also resets Type.
### row-updating
After a menu choice, the row's status chip shows a spinner and the menu button is disabled until the server answers. On success, the row updates in place, and the toast reads "Fact disabled. Your assistant no longer uses it." or "Fact enabled. Your assistant uses it from now on.". The update is never optimistic.
### delete-confirm
`confirm-dialog`:
- **Title:** "Delete this fact?"
- **Body:** "{fact title} will be removed and your assistant stops using it straight away. This can't be undone."
- **Buttons:** `secondary` "Cancel" on the left, which gets initial focus; `danger` "Delete fact" on the right.
- While the delete is in progress, the confirm button shows its loading state, and Esc and the scrim don't close the dialog.
- On 204, the dialog closes, the row is removed, focus moves to the list heading, and the toast reads "Fact deleted."
### delete-failed
- **409 `version_conflict`:** the dialog stays open with a warning `alert`: "This fact changed since you opened the list. Close this and try again." The list refreshes in the background.
- **404:** the dialog closes, the row is removed, and the toast reads "This fact was already deleted."
- **Any other failure:** a danger `alert` in the dialog: "We couldn't delete the fact just now. Nothing was changed."
### load-more-error
If a next page fails, the rows already shown stay. The button is replaced by an inline danger `alert` "We couldn't load more facts." with [Try again] (design.md §4.3 error-state, "if it's partly loaded, show what loaded").

- **Responsive notes:** the stacked list below 768 px, unchanged otherwise. The dialog becomes a bottom sheet below 640 px.
- **Decisions:**
  - **"Load more" on desktop too.** Driver: design.md's numbered pages are specified for the inbox (INB-01). The fact list uses a keyset cursor (technical design D5), which can't jump to page *n*, and a page number would drift while the owner edits rows to the top. Rejected: an offset for desktop only, which skips rows while editing.
  - **No typed DELETE** in the confirm dialog. Driver: design.md reserves the typed word for tenant-scale irreversible actions (delete tenant, PDPA deletion). A single fact can be re-entered in a minute.

## SCR-APP-028 — Fact

- **Strategy and source:** code-native (this section, on top of FEAT-022's). Routes `/knowledge/facts/new` and `/knowledge/facts/:id`.
- **Composition changes:**
  1. **Type** (create only), a `radio` group: "Product or service" · "Question and answer (FAQ)" · "Policy" · "Promotion". In edit mode the type is shown as text.
  2. **Product or service:** as FEAT-022, but the name placeholder is "e.g. Chocolate fudge cake or Cake delivery".
  3. **Policy:**
     - `select` "Kind (required)": Refunds · Delivery · Booking · Payment · Other.
     - `field` "Title (required)", e.g. "Refunds on whole cakes".
     - `textarea` "Details (required)", e.g. "Cancel at least 2 days before collection for a full refund."
     - Help under Details: "Your assistant quotes these details as written."
  4. **Promotion:**
     - `field` "Title (required)", e.g. "Deepavali bundle".
     - `textarea` "Details (required)", e.g. "Any 2 boxes of kueh with a free ondeh ondeh box."
     - `field` "Promotion price in S$" (optional, `S$` adornment). When a price is typed, the GST `radio` group appears below it, as for products, and is required.
     - Two native date `text-input`s side by side (stacked below 480 px): "Starts on" (optional) and "Ends on (required)". Help: "Dates are in Singapore time. Your assistant stops mentioning it after the end date."
  5. **GST review prompt** (edit, product or promotion with an `unknown` treatment): a warning `alert` above the form: "Choose whether this price includes GST. Your assistant won't quote it until you do." The GST radios start unselected. Choosing one and saving approves it (KB-15).
  6. **Delete** (edit mode): a `danger-ghost` button "Delete fact" at the right end of the sticky action bar, apart from Save and Cancel. It opens the same delete-confirm dialog as SCR-APP-027 and is also available for not-editable (rejected or conflicted) facts.
  7. **Validity display** (edit, a promotion that has ended): an info `alert` "This promotion ended on 31 Oct 2026, so your assistant no longer mentions it. Change the end date to run it again."
- **Content and data mapping:**
  - Create: `POST /api/v1/kb/facts` with `type`, `value`, `gstTreatment` (product, or promotion with a price), and `validFrom` / `validUntil` (promotion).
  - Edit: `PATCH` with only what changed. Clearing "Starts on" sends `validFrom: null`.
  - Delete: `DELETE …?version=` with the loaded version.
- **Conformance:** pass. Every component is from design.md §4 (`field`, `select`, `textarea`, `radio`, `alert`, `button` danger-ghost, `confirm-dialog`). Dates use the format "31 Oct 2026" and prices "S$21.80" (design.md §6, NFR-10).

### validation
Messages are added in the FEAT-022 pattern:
- "Choose the kind of policy"
- "Enter the title"
- "Enter the details"
- "Enter the price in dollars and cents, like 55.00" (promotion price, when given)
- "Choose whether the price includes GST" (promotion with a price)
- "Choose the end date"
- "The end date must be on or after the start date"
### saved
As FEAT-022 ("Fact saved. Your assistant uses it from now on."). For a promotion that starts later, the toast reads "Fact saved. Your assistant starts using it on 1 Nov 2026."
### deleted
After a confirmed delete: back to `/knowledge` with the toast "Fact deleted." On 404: the same, with "This fact was already deleted." On 409: the warning alert in the dialog, as in SCR-APP-027, but the action is [Reload], which reloads the fact.
### not-editable
As FEAT-022, but Delete stays enabled.

- **Responsive notes:** the action bar wraps below 480 px, with Delete on its own line, left-aligned.
- **Decisions:**
  - **Native date inputs**, not the `date-time` / `hours-editor` component. Driver: that component is the weekly hours grid (ONB-03). A single calendar day is a plain `text-input` of type date, which brings the platform's accessible picker on phones. Rejected: a custom picker, which isn't in design.md.
  - **Policy kind as a `select`.** Five options with no consequences between them fit a select. Radios are kept for choices with consequences (GST).

## Cross-screen decisions

- **`ConfirmDialog`** is added to `@kaki/ui` on Radix Dialog (design.md §4.3 `dialog` and `confirm-dialog`): title, body, cancel `secondary` left, confirm on the right with its variant (`danger` here), initial focus on Cancel, focus returned to the trigger, bottom sheet below 640 px, and no close while busy. It's the first dialog in the app, so later confirm flows (Approve all, kill switch) reuse it.
- Terminology follows design.md §6: "fact", never "entity". The owner sees "Products and services" and "Policies", not "product type".

## Escalations and open items

- None filed. Both decisions on SCR-APP-027 stay within design.md's stated scope for those rules.
- The manifest gaps carried over: sources, review interval and version history with restore on SCR-APP-028 (FEAT-012, FEAT-018, FEAT-021). The SCR-APP-027 gap "disable or delete from the list" is closed by this feature.
