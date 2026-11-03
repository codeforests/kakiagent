# UI design: FEAT-046 — Conversation search

> Contracts: [technical-design.md](technical-design.md) §3 · Design system: `docs/02-design/design.md` (§4.2 `text-input`, §4.1 icon `button`, §4.3 `alert`, §4.4 `chip`, §4.8 data-view states, §3 top bar) · Strategy: code-native · 2026-11-03

## SCR-APP-014 — Inbox (partial): search

**Search field** (top of the list pane, above the view tabs, every width)
- One `text-input` `type="search"`, full width of the list pane, with a 16 px `search` glyph inside on the left (text-secondary, `aria-hidden`) and, once there is text, a Clear icon button (×, "Clear search", 32 px; 44 on coarse pointers) on the right.
- Accessible name: a visually hidden label "Search conversations"; `aria-describedby` → hidden help "Search by name, email, phone or anything said in a chat." Placeholder (example only): "e.g. Mei Ling, 9123 4567".
- Starts searching 300 ms after typing stops once there are 2 or more characters; Enter searches at once. 1 character shows nothing new (the inbox stays as it was) and the hidden help is enough; no error text.
- Escape in the field, or Clear, ends the search: the text empties, the tabs, filters and list return as they were, and focus stays in the field.

**While a search is active** (2+ characters) the view tabs and the Channel and Assigned to filters are hidden and the list area becomes the results region (`role="region"`, `aria-label="Search results"`). A status line at its top (`role="status"`, polite, caption, text-secondary) announces the outcome once per completed search:
- Searching (first page): skeleton rows as the list's loading state, `aria-busy="true"`; status "Searching…".
- Results: "N conversations match" (no more pages) or "Showing N conversations" (more available).
- No results: empty state (design.md §4.8) title "No conversations match “{q}”", body "Check the spelling, or search part of a name, email or phone number.", secondary button "Clear search". The query in the title is the user's text, rendered as text (never HTML).
- Error: `ErrorState` "Couldn't search conversations" with a secondary "Try again" (re-runs the same query); the field keeps its text.
- Load more: the list's existing "Load more" button at the end; while loading, "Loading…" and `aria-busy`; a failed page shows the inline "Couldn't load more. Try again." as the list does.

**Result row** (same `conversation-row` layout, link, selection and focus styles as the list)
- Title "Website visitor" (until FEAT-049 adds contact names), avatar, time (`rowTime(lastMessageAt)`) and chips (flagged, state, urgent) as the list row.
- In place of the preview: the author label in `--font-weight-medium` ("Visitor:", "Assistant:", "Team:", "Update:") then the excerpt, two lines max (`-webkit-line-clamp: 2`), each hit in a `<mark class="search-hit">`: `--color-accent-soft` background, `--color-text-primary` text, `--radius-sm`, no other colour change (design.md: accent-soft is the passage highlight). The mark is announced as normal text; the hit is never colour only because the excerpt itself shows the matching words.
- Owner and escalation lines as on the list row.
- Link target `/inbox/{id}` (no query in the URL); selection (`aria-current`) follows the open conversation.

**Opening a result** opens the conversation pane as from the list. When the matched message is among the loaded messages, the thread scrolls it to the middle and gives its bubble a 2 px `--color-accent-default` outline with `--color-accent-soft` behind it (`bubble--match`) until another conversation opens; `prefers-reduced-motion` scrolls without smooth behaviour. Below 1024 (one pane) Back returns to the same results with the field filled and the row scrolled into view; the results are not re-fetched within 30 s.

**Top bar search entry** (every page): an icon button with the `search` glyph after the tenant switcher, `aria-label="Search conversations"`, 36 px (44 coarse). It goes to `/inbox` and puts focus in the search field (keeping any text already there). On the inbox page itself it only moves focus.

**Layout and widths**
- ≥ 1024: the field sits in the list pane (360 px at ≥ 1280) above the tabs; results replace the list pane's rows; the thread pane is unchanged.
- < 1024: the field is the first thing on the list screen; at 375 px the field, Clear and every row fit without sideways scroll; the excerpt wraps within two lines.
- The workspace switch clears the search text (lib `resetInboxSearch`).

**States covered:** search idle, typing (under 2), searching, results, more results, no results, error, load more, load more error, opened at match, back to results, top bar entry.

## Tokens used

`--color-accent-soft`, `--color-accent-default`, `--color-text-primary`, `--color-text-secondary`, `--color-border-strong`, `--radius-sm`, `--radius-md`, `--space-1`, `--space-2`, `--space-3`, `--size-control-md`, `--size-control-lg`, `--type-caption-size`, `--font-weight-medium`; nothing new.

## Gaps and escalations

- Contact names in the row title and search by contact fields arrive with FEAT-049 (technical-design D1).
- A match older than the thread's loaded 100 messages opens at the bottom (technical-design §8).
