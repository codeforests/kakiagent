# UI Design: FEAT-028 — Replay a past conversation

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E3) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-031 (new); SCR-APP-030 (extended: entry link) · Mode: per-feature · Status: Draft · Date: 2026-10-24

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screen is a code-native spec. Every value comes from design.md and `tokens.json`; front ends use `var(--…)` only. It reuses design.md §4.6's `answer-compare` (the KB-18 side-by-side panel, built here first) and `answer-explainer`, plus `message-bubble`, `progress`, `chip`, `alert`, `empty-state`, `error-state` and FEAT-027's `quick-coach-panel`. No new component or token.

## SCR-APP-031 — Replay a conversation

- **Strategy and source:** code-native (this section).
- **Routes:** `/coach/replay` (picking) and `/coach/replay/:id` (replaying, comparison). Roles: Owner, Admin (`coach.use`); others get the permission state "Only the Owner and Admins can replay conversations."
- **Entry point:** SCR-APP-030's page head gains a `secondary` "Replay a conversation" link (desktop) or an item in the page-head overflow (below 768 px). The Conversation screen's entry point is FEAT-042's.
- **Contract bindings:** `GET /api/v1/coach/replay-candidates`, `POST /api/v1/coach/replays`, `GET /api/v1/coach/replays/:id`, `POST /api/v1/coach/replays/:id/next`; the quick panel's coaching routes (FEAT-027).
- **Page head:** back link "Coach", title "Replay a conversation", lede "See how your assistant would answer a real conversation today, next to what the customer got."

### picking (`/coach/replay`)

- A list (`data-list` rows) of past conversations: "Website visitor" and channel icon, the first question (one line, truncated), "{n} questions", relative time of the last message, a `chip` "Flagged" (warning) when flagged, and "Replayed {time}" caption with a "View" link when `lastReplayId` is set. "Load more" `secondary` at the end when `nextCursor`.
- Selecting a row opens a `dialog` "Replay this conversation?": body "Your assistant re-answers each customer question with your current facts. Nothing is sent to the customer and nothing in the conversation changes." The include-unreviewed `toggle` (FEAT-027's label and caption, off). Actions `primary` "Replay" and `ghost` "Cancel". Over 20 questions: caption "Only the first 20 of {n} questions are replayed."
- Replay → `POST /replays`, navigate to `/coach/replay/:id`. 422 `nothing_to_replay` shows the dialog alert "This conversation has no customer questions to replay."
- **empty:** `empty-state` "No conversations to replay yet", body "When customers chat with your assistant, their conversations appear here." with a link to Coach "Practise in Coach instead".
- **loading:** five skeleton rows. **error:** `error-state` "Couldn't load conversations." [Try again].

### replaying and comparison (`/coach/replay/:id`)

- **Header strip:** "Replaying with your current facts" (or "… including unreviewed facts", warning `chip`), the conversation's date, and caption "Opening-hours answers use today's hours." (D4). Over 20: "The first 20 of {n} questions."
- **Progress:** while turns are pending and the page drives `…/next`: `progress` bar "Replaying {done} of {total}…" with an `aria-live="polite"` text, and `ghost` "Pause". Paused or reopened with pending turns: `primary` "Continue replay". All done: success caption "Replay complete. {k} answers use different facts." Focus stays where the user is; new results don't steal it.
- **Turns** (one `answer-compare` row per question, in order):
  - The customer's question as a visitor-style `message-bubble` (label "Customer", time).
  - Two columns below it, stacked below 768 px (Original first): **"What the customer got"**: each original reply as a bubble labelled "{bot name} · AI", "Staff" or "System"; none: caption "No one answered this." **"What your assistant says now"**: the replayed answer in the coaching bubble style (FEAT-027: surface with border, "{bot name} · replay"), then the `answer-explainer` (FEAT-027's sentences; plus `crisis` "It would share crisis contacts and flag the chat for your team.", `abuse_warning` "It would warn the customer about their language.", `abuse_ended` "It would end its part in the chat and flag it for your team.").
  - Effects line (caption with an info icon) for each `done` effect that changes the conversation live, e.g. "Live, this would also flag the conversation. Nothing was flagged in this replay."
  - A `chip` "Uses different facts" (accent-soft) when `factsChanged`; nothing when the same, so changes stand out. Colour is never the only signal: the chip has text.
  - Action `ghost` "Teach a fix" opens the quick coach panel (FEAT-027) with the customer's question prefilled and not sent (below 768 px, `/coach?ask=…`).
  - Pending turn: the question bubble, the original column, and a skeleton bubble in the "now" column ("Waiting to replay"); the turn being answered shows the typing indicator.
- **Errors:** a failed `…/next` stops the loop and shows an inline `alert` danger on that turn "Couldn't replay this question." [Retry]; 429: "Replaying quickly. Wait a minute, then continue." with Continue disabled for 60 s; 404 `conversation_gone`: page-level `empty-state` "This conversation was deleted, so its replay is gone." [Back to replays]. `unavailable` outcome renders as an answer with FEAT-027's unavailable explainer line.
- **not-found:** unknown or other-tenant ID: `empty-state` "This replay isn't available." [Back to replays]. **loading:** header skeleton and three skeleton turns.
- **Keyboard and a11y:** turns are an ordered list (`ol`, each item labelled "Question {i} of {n}"); the columns have headings (h3) so screen-reader users can jump between "got" and "now"; Pause/Continue is one `button` with a changing label; axe clean.

## SCR-APP-030 — Coach (extended)

- Page-head link to `/coach/replay` (above). The chat list excludes replay sessions (the API filters them). No other change.

## Gaps and escalations

- Gaps: the Conversation-screen entry point (FEAT-042); `answer-compare` after an accepted correction (FEAT-018 reuses this rendering).
- Escalations: none. No design-system change.
