# UI design: FEAT-061 — Data-subject requests

> Screens: SCR-APP-048 (new), SCR-APP-049 (new), SCR-APP-047 (partial: "Data requests" row) · Contracts: [technical-design.md](technical-design.md) §3 · Strategy: code-native (design.md, tokens.json; no design tool connected) · Mockup: [mockup/dsr-mockup.html](mockup/dsr-mockup.html) (not reviewed by Ken, D14)
> Status: designed · 2026-11-20

**Shared words.** Types: "Access" · "Correction" · "Deletion". Status chips: open → `chip-neutral` "Open"; verified → info `chip` "Identity verified"; completed → `chip-success` "Completed"; unverified → `chip-danger` "Closed: not verified"; closed → `chip-neutral` "Closed". Due chips: ok → caption "Due 20 Dec" (text-secondary); due soon → warning `chip` "Due in 5 days"; overdue → `chip-danger` "Overdue by 2 days"; closed → none. Ref in mono ("DSR-1A2B3C4D"). Requester label is always the masked form in lists ("m•••@gmail.com"). Dates SGT, "20 Nov 2026". Source "From a chat" with a link to the conversation when `source = conversation`.

## SCR-APP-048 — Data requests

`/settings/privacy/requests`, Owner and Admin (Agent: standard no-permission state). Reached from Privacy and data (SCR-APP-047): a new `card` row "Data requests" — body "Requests from customers to see, correct or delete their personal data." + the counts "2 open · 1 due soon" + `link` "Manage requests".

- **Header:** `breadcrumb` Settings › Privacy and data › Data requests; `page-title` "Data requests"; lede "PDPA gives customers the right to see, correct or delete their data. Each request is due 30 days after you receive it." Right of the title (below on phones): `primary` "New request".
- **Tabs:** "Open (2)" · "Closed" (`tabs`, in the URL `?view=closed`).
- **List** (`table` ≥ 768, stacked `list` below): columns Request (ref mono + requester label) · Type · Received · Due (due chip) · Status (status chip). Whole row is one link to `/settings/privacy/requests/:id`, `aria-label` "{ref}, {type}, {status}, {due text}". Open sorted by due date; overdue and due-soon rows show their chip first. Phones: line 1 ref + due chip, line 2 type · status · received. "Load more" `secondary` on closed.
- **New request** (`form-dialog` "New data request"): Type `radio` group (Access "They want a copy of their data" · Correction "Something we hold is wrong" · Deletion "They want their data deleted"); Received on `field` date (default today, max today; error "The date can't be in the future"); Requester: Name (optional), Email, Phone (+65), Telegram user ID (numbers only; help "Ask them to send /start to your bot, or find it in the chat") — help "At least one, so we can search for their data"; Note (optional textarea, "Anything else they asked for"). Errors only on submit or after leaving a field (ErrorSummary pattern; guide `required-field-feedback`), with an `ErrorSummary` at the top. Buttons "Log request" (busy "Logging…") / "Cancel". Success: navigate to the new request, toast "Request logged. Due {dueOn}."
- **States:** loading (`skeleton` rows); empty open ("No open requests" + body "When a customer asks for their data, log it here. Requests from chats appear on their own." + "New request"); empty closed ("No closed requests yet"); error (`error-state` "Couldn't load data requests" + Try again); permission.

## SCR-APP-049 — Data request

`/settings/privacy/requests/:id`, Owner and Admin. Layout: one column of `card`s, max width as Settings pages; on ≥ 1024 a right column (320 px) holds "Request details" and "History".

- **Header:** breadcrumb … › Data requests › {ref}; `page-title` "{Type} request"; chips status + due; caption "Received {date} · {From a chat ↗ | Logged by {name}}".
- **Request details card:** definition list Requester (full values while not erased; after deletion the masked values + caption "Details masked after deletion") · Received · Due · Note. While Open: `secondary` "Edit" opens the New request form prefilled (title "Edit request").
- **Step 1 · Verify identity card** (Open only): body "Check the person asking is the customer before you act. Write down how you checked." Method `radio` group: "They wrote from the email or Telegram account we already have" · "They replied from the email address we hold" · "We called them on the number we hold" · "In person" · "Other". Note `textarea` (required, "What you checked. Don't type ID numbers; they'll be masked."). Buttons `primary` "Mark identity verified" and `danger-ghost` "Couldn't verify". "Couldn't verify" → `confirm-dialog` "Close as not verified?" with required Reason field; confirm "Close request". Once verified the card collapses to a summary: success icon "Identity verified by {name} on {date}: {method words}. {note}".
- **Step 2 · Data we hold card** (search): line "Searched for: {email} · {phone} · {telegram}" + `link` "Edit search" (Open only; opens Edit). States: searching (`skeleton` + `aria-live=polite` "Searching every store…"); nothing found (`empty-state` "We hold no data for these details" + body "You can complete the request and tell them so."); results:
  - **People** — one row per contact: name, identifiers, counts ("3 conversations · 1 lead · 2 consents · 1 merged record · personal data in 4 audit entries"), `checkbox` ticked by default, `link` "Open contact" (`/contacts/:id`).
  - **Conversations** — `table`: Channel · Started · Last message · Messages · Files; rows from People are ticked and read-only (they go with the person); "Mentions them" rows (`chip-neutral` "Mentions them") are unticked checkboxes; each row links to `/inbox/:id`.
  - **Files** — list name · size · type; `link` "Download" per clean file (existing attachment route) with caption "Send these with the export if they asked for a copy."
  - **Knowledge** — rows "Fact: {title}" / "Waiting for review: {title}" + masked excerpt, unticked checkboxes; caption "Only tick items that are about this person."
  - **Also removed with the person** — caption line "{n} approvals · {n} escalations · {n} suggested replies · {n} memory notes · {n} page-view records · {n} chat links".
  - Selection summary sticky to the card bottom: "Selected: 1 person, 4 conversations, 2 files, 1 knowledge item".
- **Step 3 · Act card** (Verified only; content by type):
  - Access: `primary` "Export data" → `confirm-dialog` "Export this person's data" body "A JSON file with {n} conversations and {m} messages. It holds personal data: send it only to the requester." → re-auth → download `data-request-{ref}-{date}.json`, toast "Export downloaded. This is recorded in the audit log." Then `secondary` "Mark completed" (dialog with optional note "What you sent them").
  - Correction: per person `secondary` "Correct details" → `form-dialog` "Correct details" with Name, Email, Phone and, when they have an open lead, Need / Budget / Preferred time; caption "Messages can't be edited; they're a record of what was said." Save → toast "Details corrected." Then "Mark completed".
  - Deletion: `danger` "Delete selected data" (disabled with nothing selected) → `confirm-dialog` (destructive) "Delete this person's data?" body lists the counts ("1 person, 4 conversations (120 messages), 2 files, 1 knowledge item") + "This can't be undone. It is removed now; backups clear within 35 days." + `field` "Type delete to confirm" — the Delete button stays disabled until the text equals "delete" (case-insensitive, trimmed). Initial focus on Cancel (ConfirmDialog default; guide `dialog`: safe action focused). Confirm busy "Deleting…" → re-auth if needed → done state. Errors: 409 → `alert` "This request changed. Reload to see the latest." + "Reload"; 422 → "The data found has changed. Search again before deleting." + "Search again".
  - Any open/verified request: `ghost` "Close without action" → `confirm-dialog` with required Reason ("Duplicate", "They withdrew the request", free text).
- **Done state** (completed deletion): success `alert` "Data deleted on {date}." + definition list Removed ("1 person, 4 conversations, 120 messages, 2 files, 1 knowledge item") · Files in storage ("Removing…" while `objects = pending`, "Removed" when done) · Backups ("Cleared by {backupsClearBy}") · Audit reference (`link` "Entry #{auditSeq}" → `/settings/audit?seq=`) · Audit chain (`chip-success` "Chain verified" | `chip-danger` "Problem found" + link to the Audit log | caption "Check it from the Audit log" when `not_checked`). Caption "Tell the requester the outcome."
- **History card:** this request's events (Logged, Identity verified, Exported, Details corrected, Data deleted, Files removed, Completed, Closed) with who and when.
- **States:** loading (card skeletons); not found ("This request doesn't exist." + back link); error (`error-state` + Try again); permission (Agent).
- **No live updates:** refetch on window focus; while `objects = pending`, refetch every 10 s up to 2 minutes.

## SCR-APP-047 — Privacy and data (partial)

Adds the "Data requests" card row described above, between the privacy notice and the documents cards. The counts come from `GET /api/v1/data-requests?view=open` (`counts`); a due-soon count shows a warning `count` badge.

## Tokens used

Only existing tokens and `@kaki/ui` components: `card`, `chip` (neutral, info, success, warning, danger), `table`/`list`, `tabs`, `form-dialog`, `confirm-dialog`, `reauth-dialog`, `field`, `radio`, `checkbox`, `textarea`, `alert`, `empty-state`, `error-state`, `skeleton`, `toast`, `breadcrumb`, `button` (primary, secondary, ghost, danger, danger-ghost). Spacing `--space-*`, radius `--radius-md` for cards. No new tokens.

## Gaps and escalations

- Type-to-confirm is a `field` inside `ConfirmDialog`'s body, not a new component (design.md §4.10 trigger → confirm → re-auth → ack → toast).
- Modern Web Guidance: guides `dialog` and `required-field-feedback` read; `@kaki/ui` `ConfirmDialog` (Radix) wins over native `<dialog>`; both agree on focusing the safe action and on errors only after interaction or submit.
