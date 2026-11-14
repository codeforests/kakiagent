# Technical design: FEAT-075 — Inbox redesign

> Implements: INB-01 (p: list layout, views and filters), INB-04 (p: sidebar layout), INB-06 (p: inbox and conversation complete at 375 px) · Realizes: UC-23 (steps 1–3: see the list, open a conversation, read its context) · Screens: SCR-APP-014 (p), SCR-APP-015 (p) (see [ui-design.md](ui-design.md)) · Module: dashboard only (`apps/dashboard`); no package, contract or schema change
> Status: designed · 2026-11-14 · Owner request (Ken, 2026-11-14): redesign approved from the prototype canvas, same functionality

## 1. Intent

A visual and layout redesign of the Inbox (SCR-APP-014) and Conversation (SCR-APP-015) screens, approved by the owner from a prototype on 2026-11-14. Every function built by FEAT-042, 043, 044, 045, 046, 049, 050, 051, 055, 036, 037, 038 and 029 stays as it is; this feature changes how it's laid out, fixes four layout defects found in the review, and changes one behaviour (D2: the selection clears when a view or filter change hides it).

Review findings it closes (2026-11-14, live app at 1440 × 900 and 375 × 812):

1. The search icon covers the placeholder's first letter (`.search-field__input` padding vs `.search-field__icon`).
2. At 1440 × 900 with a channel-health banner, the page scrolls and the takeover bar falls below the fold (PR #66 fixed this at phone width only).
3. Thread author label is "Website visitor" on email and Telegram conversations (`AUTHOR_LABEL.visitor` in `conversation-parts.tsx`; rows already use `PARTY_LABEL`).
4. View tabs need 465 px in a 360 px pane at every width: Flagged and Closed hide behind a scrollbar.

## 2. Codebase context

- `apps/dashboard/src/pages/inbox.tsx` — `InboxPage` (panes), `InboxList` (header, `LiveBadge`, `SearchField`, views `nav`, Channel and Assigned-to selects, rows, load more, `ListEmpty`). `to(f)` keeps the selected id on every view or filter change (the behaviour D2 replaces).
- `apps/dashboard/src/pages/inbox-row.tsx` — `Row`, shared with search results (FEAT-046).
- `apps/dashboard/src/pages/inbox-search.tsx` — `SearchField`, `SearchResults`.
- `apps/dashboard/src/pages/conversation.tsx` — `ConversationPane`: `.thread-header`, thread log, dock (takeover bar, composer, suggestion).
- `apps/dashboard/src/pages/conversation-parts.tsx` — `StateChip`, `UrgentChip`, `FlaggedChip`, `VisitorAvatar`, `AUTHOR_LABEL`/`authorLabel`, message bubble, dividers, notices, sidebar sections (contact, channel, intent with FEAT-029 web context, lead, facts used, approval).
- `apps/dashboard/src/lib/inbox.ts` — `VIEWS`, `VIEW_LABEL`, `CHANNELS`, `PARTY_LABEL`, `viewFromSearch`, `searchFromView`, `rowTime`, `escalationText`, `ownerText`.
- `apps/dashboard/src/app.css` — inbox block from `.content:has(.inbox)` (~l. 453) to `.conversation-row__chips` (~l. 650), `.thread-header`, `.context-sidebar`.
- E2E that read copy or controls this feature changes: `inbox.e2e.ts` and `skeleton.e2e.ts` (`live-state` text "Live"), `takeover.e2e.ts` (`assignee-filter` select, now inside the Filters panel).

## 3. API contracts

None. Counts, list, conversation and sidebar responses are used as they are. The empty-state shortcut uses `counts.escalated` (D6), which the list response already returns.

## 4. Schema changes

None.

## 5. Component design

### 5.1 Selection rule (D2)

New pure helper in `lib/inbox.ts`:

```ts
/** Whether a conversation belongs in a view + filter, from the summary the client already has. */
export function inView(c: ConversationSummary, f: InboxFilter, meId: string | null): boolean
```

- View: `open` = status ≠ `closed`; `escalated` = status `escalated`; `approval` = status `waiting_approval`; `flagged` = `flaggedAt` set; `closed` = status `closed`. These mirror the server's `viewFilter` in `packages/inbox/src/views.ts`; a unit test pins each.
- Channel: `f.channel` null or equal to `c.channel`.
- Assignee: same rule as the server's assignee filter (FEAT-044: the owner, else the escalation assignee; `me` = `meId`; `none` = neither).

`InboxList`'s `to(f)` keeps `/:id` only when the open conversation's summary is known and `inView(summary, f, meId)` is true; otherwise it links to `/inbox{qs}` (empty state). The summary comes from the React Query cache (list pages or the conversation query); when it's unknown the id is dropped.

A conversation that leaves the current view through a live event (closed by a teammate while open) is **not** deselected: the staff member keeps reading it, and the row leaves the list as today (FEAT-042 live update).

### 5.2 Layout

- `.inbox` becomes a full-height flex row inside `.content` (height = viewport − top bar − banner stack), each pane scrolling on its own; no page scroll at ≥ 1024. The thread log scrolls; header and dock are `flex: none`. This also covers the banner case PR #66 fixed at phone width.
- Pane widths: list 400 px at ≥ 1280, 360 px at 1024–1279; details 320 px at ≥ 1280, drawer below (unchanged).
- No conversation selected: the thread pane shows the new empty state across the remaining width; the details pane isn't rendered (already true; now styled per ui-design).

### 5.3 Components

- `FiltersButton` + `FiltersPanel` (in `inbox.tsx`): a disclosure button (`aria-expanded`, `aria-controls`) showing the active-filter count; the panel holds the existing Channel and Assigned-to `select`s (labels, values, `data-testid="assignee-filter"` and `aria-describedby` unchanged). Below it, `ActiveFilterChips`: one removable chip per active filter (`Remove filter Channel: Email`) and "Clear all". URL params unchanged.
- Views `nav`: labels from a new `VIEW_SHORT_LABEL` (`approval` → "Approval"; others unchanged) with `title` = `VIEW_LABEL`. Below 640 px, Flagged and Closed move into a "More" menu (Radix `DropdownMenu`, the same pattern as the conversation header's More actions in `conversation.tsx`) whose trigger shows the Flagged count; the selected view inside More shows as the trigger label ("Flagged ▾").
- `Row`: new layout (ui-design §Row); `StateChip` gains an `urgent` prop that renders the merged danger chip, and `UrgentChip` is no longer used by rows (kept for any other caller; remove if none).
- `LiveBadge`: copy "Connected" / "Connecting…" / "Reconnecting…" (D4).
- `authorLabel`: visitor messages use the contact name when known, else `PARTY_LABEL[channel]` (finding 3).
- `.search-field__input` padding-left = icon inset + icon size + `--space-3` (finding 1).

## 6. Acceptance criteria

| AC | Criterion | Traces to |
|---|---|---|
| AC-1 | At 1440 × 900 with a channel-health banner showing, the document doesn't scroll; the thread log scrolls; the takeover bar (or dock) is fully visible. | INB-01, review finding 2 |
| AC-2 | With no conversation selected (`/inbox`), the thread pane shows the empty state and no details pane is in the DOM at any width. | INB-04, UC-23 step 2 |
| AC-3 | Switching view or filter keeps `/inbox/:id` only when that conversation belongs in the new view and filters (`inView`); otherwise the URL becomes `/inbox{qs}` and the empty state shows. A conversation closed live while open stays open. | UC-23 step 2, D2 |
| AC-4 | All five views are reachable without horizontal scrolling at 1024, 1280 and 1440 px; below 640 px, Flagged and Closed are in the More menu, with Flagged's count on its trigger. | INB-01, INB-08, AGT-13, finding 4 |
| AC-5 | Channel and Assigned-to filters live in the Filters panel; each active filter shows as a removable chip; Clear all resets both; URLs and results are as before. | INB-01 |
| AC-6 | Rows show name · channel · time, subject (email), a preview that uses the full row width, then chips and owner or escalation text; an urgent escalation shows one chip "Escalated · Urgent". Search results use the same row. | INB-01, INB-11 |
| AC-7 | The search placeholder is fully visible (not covered by the icon) at 375 and 1440 px. | INB-11, finding 1 |
| AC-8 | Visitor messages are labelled with the contact name, else "Website visitor" / "Email customer" / "Telegram customer" by channel. | INB-01, finding 3 |
| AC-9 | The connection badge reads "Connected" when live; Reconnecting keeps its alert. | INB-01 |
| AC-10 | The conversation header is one row (title, chip, caption, actions) at ≥ 640; at 375 px it is at most two text lines with Back, details and More as 44 px targets. | INB-06 |
| AC-11 | Every function on SCR-APP-014/015 still works: existing inbox, takeover, escalation, suggested-reply, search, lead, approval, consent, email-channel, handoff and web-context E2E specs pass unchanged except for the copy and control changes listed in tasks T9. | INB-01, INB-02, INB-03, INB-04, INB-11 |
| AC-12 | axe reports no violations on `/inbox` and `/inbox/:id` at 1440 × 900 and 375 × 812, and keyboard order is: search, Filters, views, rows, then thread. | NFR-09, INB-06 |

## 7. Decisions

- **D1 — A new feature, not an edit of FEAT-042.** FEAT-042's ui-design is accepted and its acceptance report cites it; the redesign gets its own folder and plan row, and the manifest lists it as the current spec for the layout (FEAT-042 and the partials stay the source for behaviour and copy not restated here).
- **D2 — The selection clears when a user's view or filter change hides it** (owner, 2026-11-14: the old conversation staying open after switching to Escalated was confusing). Replaces FEAT-042's "switching views keeps the open conversation on screen". Live changes don't deselect (§5.1).
- **D3 — No reference to the SCR-APP-015 anchor prototype** (owner, 2026-11-14). The approved prototype canvas replaces it as the visual reference for both screens.
- **D4 — Connection badge copy "Connected"**, so it isn't read as the AI status pill's "Live"/"AI live". E2E expectations change with the copy (not a weakened test).
- **D5 — "Approval" as the tab label**, full "Waiting for approval" in `title`, chips, empty state and the page title of the view.
- **D6 — The empty-state shortcut uses `counts.escalated`** ("2 escalated conversations are waiting · Show escalated"). The prototype's "escalated to you" would need a per-user count the API doesn't return; out of scope (no API change).
- **D7 — No unread state.** Raised in the review; it needs per-user read markers (API + schema). Kept out: same functionality.

## 8. Escalations and open items

- Unread markers (D7) and a per-user escalated count (D6): candidates for a later feature if Ken wants them.
- FEAT-048 (PWA, M7) still owns the rest of INB-06 (install, push).
- FEAT-074 (dark mode): the redesign uses tokens only, so dark mode needs no extra work here.

## 9. Self-check

- No contract, schema, RLS, outbox or agent change; module boundaries untouched.
- Tokens only (`var(--…)`); no new tokens needed.
- Every SCR-APP-014/015 state listed in the manifest's `covered` list is kept (ui-design §Unchanged).
