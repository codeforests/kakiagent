# UI design: FEAT-045 — AI-suggested replies for staff (verified)

> Screens: SCR-APP-015 Conversation (p: Suggest a reply in the takeover bar and the composer, the suggestion states), SCR-APP-021 Review · Corrections (p: the Staff edit row), SCR-APP-022 Correction (p: the Staff edit item) · Contracts: technical-design §3 · Strategy: code-native, extending FEAT-042's, FEAT-043's, FEAT-018's and FEAT-019's ui-design.md and the SCR-APP-015 anchor (`docs/02-design/anchors/scr-app-015-conversation.html`, "Taken over + suggestion") · design.md §4.6 `composer` (takeover bar, AI suggestion, anchor amendment A2), `correction-item`, `answer-compare` layout; §4.2 `button`; §4.3 `alert`, `toast`; §4.4 `chip`, fact chips
> Status: designed · 2026-11-02

## SCR-APP-015 — Conversation (partial)

- **Takeover bar** (mode `ai`, FEAT-043/044): after `Take over` (primary) a `secondary` button with the spark icon "Suggest a reply". Pressing it shows "Taking over…" on it (both buttons disabled), takes over, then the dock becomes the composer in its writing state. A take-over conflict shows FEAT-043's alerts and no suggestion is requested. While the AI is paused (FEAT-057), the button is disabled with `aria-describedby` helper "The assistant is paused, so it can't suggest replies." (caption, text-secondary, under the buttons).
- **Composer, empty** (mode `mine`): a `ghost` button "Suggest a reply" (spark icon) in the composer's caption row, before Hand back. Disabled with the same helper while paused or while sending.
- **Writing** (request in flight): the textarea is read-only with placeholder "Writing a suggestion…", the suggest button shows a spinner and "Writing…", `aria-busy`; a polite live region (the composer's existing caption region) says "Writing a suggestion". Typing is blocked only while writing; Send stays enabled for text already typed (if the box wasn't empty, see "Replacing").
- **Holding a suggestion**: the textarea is filled with the draft and grows to 5 lines (up to 50% of the viewport height below 640 px; A2); above it the label "AI suggestion · checked against your facts · edit before sending" (`caption`, weight 500, `--color-accent-default`, spark icon 14 px; `id` referenced by the textarea's `aria-describedby`); under it the fact chips the draft used (FEAT-042's fact chip, linking to the fact) and the caption "The suggestion only uses approved facts. Anything you add yourself isn't checked." (text-secondary). Focus moves to the textarea with the caret at the end; the live region says "Suggestion ready. Edit it, then send." The suggest button reads "Suggest again". Once the staff member edits, the label stays (it's still based on a suggestion); the caption stays.
- **Replacing**: pressing Suggest a reply / Suggest again with non-empty text that isn't the unedited draft asks first (`confirm-dialog`): "Replace your reply with a new suggestion?" [Replace] [Keep my reply]. An unedited draft is replaced without asking.
- **Stale**: when a newer visitor message arrives (`forSeq` below the latest visitor message's seq), an `alert` info above the textarea: "The customer wrote again after this suggestion." with action link "Suggest again". The draft stays.
- **No checked suggestion** (`none`): an `alert` info in the dock: `no_checked_answer` "The assistant couldn't write a reply that passes its checks. Write your own." · `unavailable` "The assistant doesn't have the facts to answer this. Write your own." The textarea keeps whatever was there and gets focus. Dismissed on typing or the next suggest.
- **Errors**: 429 → `alert` warning "That's a lot of suggestions for one chat. Try again in {n} min." with the button disabled until `Retry-After`; 409 `ai_paused` → the paused helper and button disabled; 409 `nothing_to_answer` → `alert` info "There's no customer message to answer yet."; 409 `not_owner` → FEAT-043's not-owner handling (dock switches to the owned bar); network/500 → `alert` danger "Couldn't get a suggestion." [Try again] (FEAT-043's dock alert with retry).
- **Send**: unchanged button and Ctrl/⌘+Enter. The request carries `suggestionId` while the text came from a draft; cleared on send success, on emptying the box, and on Hand back. A failed send keeps the draft and its label (FEAT-043's retry keeps the client ID).
- **Sent message**: the staff bubble is unchanged (no "AI" marker: the staff member sent it). An unedited draft's facts show in the context sidebar's "Facts used" like an AI message's.
- **Phone (< 640 px)**: the label wraps to two lines; the suggest button sits left of Send in the composer row as an icon button with `aria-label="Suggest a reply"` (44 px target); fact chips wrap; nothing scrolls sideways at 375 px.
- States added: takeover-and-suggest pending, writing, holding suggestion, holding edited, replace confirm, stale suggestion, no checked suggestion, unavailable, rate limited, paused (suggest disabled), suggestion error.

## SCR-APP-021 — Review · Corrections (partial)

- **Staff edit row**: origin chip "Staff edit" (exists), summary while open: "Staff improved a suggested reply: “{question}”" (question truncated to one line, masked); facts the draft used as chips; relative age. Source filter gains "Staff edit" when present.
- **Closed**: the decision chip "FAQ added" when accepted with an FAQ (as gaps), else "Closed".

## SCR-APP-022 — Correction (partial): Staff edit item

- **Head**: title "Staff improved a suggested reply", origin chip "Staff edit", "Suggested {relative time}".
- **Where it came from** (h2): the conversation excerpt as today, plus a link "Open conversation" (`/inbox/{conversationId}`).
- **What changed** (h2): the customer's question bubble with its time; two columns (stacked below 768 px, the suggestion first), reusing the `answer-compare` layout and classes: "The assistant suggested" (accent-soft bubble) and "The team sent" (info-soft bubble; no staff names in the queue), each with its time. Under the suggestion: its fact chips, caption "If a fact here is wrong, fix it from the fact, then close this item."
- **Proposed fix** (h2): "Add an FAQ from the team's reply" with the question and the sent reply as the FAQ preview (success-soft), caption "Edit it before adding: keep the answer general, without names or order details."
- **Actions**: `primary` "Add as FAQ" opens FEAT-019's FAQ form prefilled (question = the customer's question, answer = the sent reply); `ghost` "Close with no change" (FEAT-018's confirm). No plain "Accept" (an FAQ needs the owner's wording, D6).
- **After acceptance**: banner "FAQ added. Your assistant now uses it."; no replay caption "No past answers used this yet, so there's nothing to compare."
- **Chat deleted** (`replyEdit` null): the section shows "The chat this came from was deleted." and only Close with no change.
- Keyboard and a11y: columns are a list of two `article`s with headings; reading order is suggestion then sent; axe clean.

## Tokens used

`--color-accent-default`, `--color-accent-soft`, `--color-info-soft`, `--color-success-soft`, `--color-text-secondary`, `--color-border`, `--space-2`, `--space-3`, `--radius-md`, `--type-caption-size`, `--font-weight-medium`; nothing new.

## Gaps and escalations

- Saved replies and the attach button in the composer are FEAT-047 (anchor shows the `+` button; not built here).
- Highlighting a typed literal price that doesn't match the KB (ADR-008 point 7) is not part of INB-03; left for a later inbox feature (technical-design §8).
