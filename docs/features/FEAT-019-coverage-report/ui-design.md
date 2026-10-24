# UI Design: FEAT-019 — Coverage report

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-029 (new); SCR-APP-021, SCR-APP-022 (extended: coverage-gap items); SCR-APP-008 (partial: coverage summary) · Mode: per-feature · Status: Draft · Date: 2026-10-24

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; front ends use `var(--…)` only. Components: `tabs`, `chip`, `data-list`, `form-dialog`, `alert`, `empty-state`, `error-state`, `skeleton`, `button`, FEAT-011's FAQ fields, FEAT-018's `correction-item`. No new component or token.

Topic state chips: `missing` "Not answered yet" (warning-soft), `covered` "Answered" (success-soft, check icon), `skipped` "Doesn't apply" (neutral). Gap reason copy: `unavailable` "Couldn't answer", `unsure` "Wasn't sure", `escalated` "Handed to staff". Colour is never the only signal: every chip has text.

## SCR-APP-029 — Coverage

- **Strategy and source:** code-native (this section).
- **Route:** `/knowledge/coverage`, the third Knowledge tab ("Facts · Sources · Coverage"; the tab's count pill = `topicsMissing + openGaps`, hidden at 0). Roles: Owner, Admin (`kb.manage`); others get the permission state "Only the Owner and Admins can see coverage."
- **Contract bindings:** `GET /api/v1/kb/coverage`, `PUT /api/v1/kb/coverage/topics/:topicId`, `POST /api/v1/kb/facts`, `POST /api/v1/corrections/:id/accept`, `POST /api/v1/corrections/:id/close`.
- **Page head:** title "Knowledge", the tabs, lede "Questions customers often ask that your assistant can't answer yet. Add an answer and it starts using it right away."
- **Summary line** (body-strong): pre-live "{covered} of {total} common questions answered"; live "{openGaps} questions customers asked that your assistant couldn't answer" (plus the topic line below it when topics are missing).

### Sections and order

- **pre-live:** 1. "Common questions for {industry label}" (topics), 2. "Questions from customers" with the pre-live empty text "Once customers start chatting, questions your assistant couldn't answer appear here."
- **live:** 1. "Questions from customers" (gaps), 2. "Common questions for {industry label}"; when every topic is covered or skipped, section 2 collapses to one line "All {total} common questions are answered." with a disclosure "Show them".

### Topics (`data-list`)

- Each row: the question (body), the hint as a caption, the state chip. **missing:** `primary` small "Add an answer", `ghost` small "Doesn't apply". **covered:** caption "Answered by {fact label}" linking to the Fact screen (SCR-APP-028). **skipped:** `ghost` small "Undo".
- "Add an answer" opens `form-dialog` "Add an FAQ": the question field prefilled with the topic's question (editable), the answer field empty with the hint as its help text; `primary` "Save FAQ", `ghost` "Cancel". Saved: dialog closes, the row turns "Answered", toast "Saved. Your assistant uses this answer now." Validation as FEAT-011's FAQ fields.
- "Doesn't apply": no confirm (reversible); the row turns "Doesn't apply" with "Undo"; toast "Marked as not applying to your business."
- **question-only notice** (`checked: 'question_only'`): `alert` (info) above the list "We couldn't check your answers by meaning just now, so only exact questions are matched. Some may already be answered." [Try again].
- **no template** (`template: null`): the section shows `empty-state` "No common questions for your industry yet." with a link "Set your industry" to Business profile (SCR-APP-044) when no industry is set.

### Gaps (`data-list`, report order)

- Each row: the newest question in quotes (body, up to 2 lines), meta "Asked {asks30d} times in the last 30 days · last {relative time}" ("Asked once …" for 1), reason chips, and actions `primary` small "Add an answer", `ghost` small "Not something to answer". The row links to the queue item (SCR-APP-022) through a `ghost` "Details".
- "Add an answer": the same "Add an FAQ" dialog with the question prefilled from the customer's wording and caption "Customers asked this {n} times. Write the question the way you'd like it to read." Save → `…/accept` with the `add_faq` edit; the row leaves the list; toast "Saved. Your assistant uses this answer now."
- "Not something to answer": confirm dialog "Remove this from coverage? Your knowledge doesn't change, and it closes the item in Corrections." [Remove] [Cancel] → `…/close`; toast "Removed."
- 409 `correction_closed` on either: inline alert "This was already handled." and the list reloads.

### States

- **loading:** summary line skeleton and five skeleton rows. **error:** `error-state` "Couldn't load coverage." [Try again]. **all clear (live, no gaps, all topics covered):** `empty-state` "Your assistant can answer everything customers have asked so far." **permission** as above.
- **Keyboard and a11y:** sections have h2 headings; each row's actions are buttons named with the question ("Add an answer: Do you deliver?") via `aria-label`; after a row leaves the list, focus moves to the next row's first action, or the section heading; toasts are `role="status"`; axe clean.

## SCR-APP-021 / SCR-APP-022 — Corrections (extended: coverage-gap items)

- **List row (021):** origin chip "Coverage gap"; summary "Customers asked: “{newest question}”" (one line, truncated) and meta "{asksTotal} times"; no fact chips.
- **Detail (022), open:** "Where it came from" shows "Customers asked" with the newest 5 questions as visitor bubbles, each with its date and reason chip; then "Asked {asks30d} times in the last 30 days, {asksTotal} in all." "Facts involved" is omitted. "Proposed fix": caption "Write an answer to add as an FAQ. Nothing changes until you save it."
- **Actions:** `primary` "Add an FAQ" opens the "Add an FAQ" dialog (question prefilled with the newest question) → accept with the edit; `ghost` "Close with no change" as FEAT-018. No "Edit fix" button.
- **applied:** banner "FAQ added. Your assistant now uses it."; no comparison, caption "No past answers used this yet, so there's nothing to compare." **closed:** decision chip "FAQ added" for an accepted gap item (instead of "Edited and accepted"); the FAQ shown as the accepted fix; "Closed automatically" when its chats were deleted.

## SCR-APP-008 — Wizard · Review your facts (partial: coverage summary)

- Below the review queue, before the footer: a card "Coverage" with "{covered} of {total} common questions answered" and a `secondary` link "Check coverage" to `/knowledge/coverage`. Hidden when the report has no template. Loading: one skeleton line; error: the card is omitted (the setup step works without it).

## Gaps and escalations

- Gaps: link from a gap question to its conversation (FEAT-042, SCR-APP-015); Home KB-health tiles (FEAT-065); the wizard frame (FEAT-035).
- Escalations: none; no change to design.md.
