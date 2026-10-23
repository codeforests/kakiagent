# UI Design: FEAT-017 — Chat-history import (WhatsApp, Telegram) to suggested FAQs, with redaction

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-026 (new), SCR-APP-007 (extended: chat exports), SCR-APP-023 (extended: chat rows), SCR-APP-028 (extended: a suggestion's provenance) · Mode: per-feature · Status: Verified · Date: 2026-10-23

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so every screen here is a code-native spec. Every value comes from design.md and `tokens.json`. No new component or token is introduced: suggestions reuse FEAT-013's review card and dialogs; states use `alert`, `progress`, `status-badge`, `empty-state` and `error-state`.

## Cross-screen

- **Source icon:** chat exports get a speech-bubble icon (the 20 px line style, `currentColor`).
- **File type labels:** txt "WhatsApp export (.txt)", zip "WhatsApp export (.zip)", json "Telegram export (.json)". After the parse the format comes from `chat.format`: "WhatsApp chat" or "Telegram chat".
- **Source name:** always `source.name` ("Chat export", then "WhatsApp chat, 3 Jan – 12 Oct 2026"); the file name is never shown after the upload, because it usually names the customer.
- **Stage names:** scan "Checking the file", parse "Reading and removing personal data", extract "Finding questions and answers", promote "Saving suggestions".
- **Failure reasons** add:
  - `chat_format`: "This doesn't look like a chat export we can read. Export the chat from WhatsApp (More › Export chat › Without media) or Telegram Desktop (Export chat history › JSON), then upload that file."
  - `business_not_found`: "We couldn't find any messages from the name you gave. Check how your business's name appears in the chat, then upload the export again. The file has been deleted."
  - `unsupported_type` on a chat: "Upload the .txt or .zip file WhatsApp exports, or the result.json file Telegram exports."
  - `encrypted` on a chat: "This zip file is password-protected. Export the chat again and upload the file without a password."
  - Others keep FEAT-012/015's text.
- **Redaction notice** (one text, used on SCR-APP-007 and SCR-APP-026): "Before anything is saved, we remove customers' names, phone numbers, e-mail addresses, NRIC and card numbers, and addresses. The export file is deleted as soon as it has been read. Nothing is used in answers until you approve it."
- **Retry or upload again:** `chat_format`, `business_not_found` and the safety failures show "Upload again" (to SCR-APP-007); others show Retry.

## SCR-APP-026 — Chat-history import

- **Strategy and source:** code-native (this section).
- **Route:** `/knowledge/sources/:id` for a source of kind `chat` (SCR-APP-024 renders this screen instead of the page list). Back link "Sources". Roles: Owner, Admin (`kb.manage`); others get the permission state.
- **Contract bindings:** `GET /api/v1/kb/sources/:id`, `GET /api/v1/kb/review/facts?sourceId=:id&type=faq`, `POST /api/v1/kb/facts/:id/approve`, `POST /api/v1/kb/facts/:id/reject`, `GET /api/v1/kb/review/preview?sourceId=:id`, `POST /api/v1/kb/review/approve-all`, `POST /api/v1/kb/sources/:id/retry`, `DELETE /api/v1/kb/sources/:id`.
- **Page head:** title = `source.name`; caption "{WhatsApp chat | Telegram chat | file type label} · {size} · Uploaded {date}"; with `file.scannedAt`, "Checked for malware: none found" with a check icon; `status-badge` on the right (Queued, Processing, Ready, Failed).
- **Privacy card** (`card`, always shown once the parse is done): heading "Personal data removed"; a definition list with the non-zero counts of `chat.redacted`: "Names: 34", "Phone numbers: 12", "E-mail addresses: 3", "NRIC and card numbers: 1", "Addresses: 5" (all zero: "We didn't find any personal data to remove."); then, with `chat.exportDeletedAt`, a success caption with a check icon "The export file was deleted on {date, time}". Below: "{messages} messages from {from} to {to} · {exchanges} questions answered by you" and, when `messagesSkipped > 0`, caption text-secondary "Only the latest {n} messages were read."

### reading (status queued or processing)

- The redaction notice as an `alert` info, then a `progress` (indeterminate) with the stage name, polite live region announcing stage changes. The privacy card appears as soon as `chat` is set.

### suggestions (ready, with suggested FAQs)

- Heading "Suggested FAQs ({n})" and the line "These come from your replies in the chat. Approve the ones customers should get, edit any wording, and discard the rest."
- The list is FEAT-013's review card for `type faq`, scoped to this source: question, answer, the passage (the business's reply, highlighted in its exchange: `Customer: …` and `Business: …` lines as text), and Approve, Edit, Discard, with FEAT-013's undo toast. Edited approval uses FEAT-013's edit dialog.
- "Approve all…" (secondary) opens FEAT-013's approve-all preview scoped to this source.
- When every suggestion is reviewed: `empty-state` "All suggestions reviewed" with "{approved} approved" and a `link` "See your FAQs" to SCR-APP-027 filtered to FAQs.

### empty (ready, no suggestions)

- `empty-state` "No questions found": "We read {messages} messages but didn't find questions with a general answer from you. Chats where customers ask about prices, opening hours or how things work give the best suggestions."

### failed

- `alert` error with the failure text, then Retry or "Upload again". The privacy card stays when the parse had finished.

### loading, error, not-found, permission, delete-confirm

- As SCR-APP-024 (FEAT-012). Delete: "Delete chat export…" (danger, secondary) → `confirm-dialog` "Delete this chat export? Its suggestions and any FAQs you approved from it are removed." confirm "Delete chat export".

## SCR-APP-007 — Add your sources (extended: chat exports)

- **Strategy and source:** code-native.
- **New section "Chat history"** below Files: help text "Upload a chat you exported from WhatsApp (.txt or .zip) or Telegram (result.json). We suggest FAQs from your replies." then the redaction notice as caption text-secondary; a `field` "Your name in the chat" (text input, required, prefilled with the business profile's name, hint "As it appears in the chat, e.g. Kaki Bakery. Separate several with commas."); a file input (`accept=".txt,.zip,.json"`, button "Upload chat export"). Names: split at commas, trimmed, 1–5, each ≤ 100; errors inline ("Enter your name as it appears in the chat").
- **Upload list:** the files part's list, with the chat icon and `source.name`; "View" goes to SCR-APP-026; once ready, "{n} suggested FAQs".
- **How to export** (`details` disclosure "How do I export a chat?"): WhatsApp: open the chat › More › Export chat › Without media. Telegram Desktop: open the chat › ⋮ › Export chat history › format JSON, untick media.
- **States:** default, uploading, added, refused, limit, error (as the files part).

## SCR-APP-023 — Sources (extended: chat rows)

- **Strategy and source:** code-native.
- **Rows:** chat icon; name = `source.name`; meta "Uploaded {date} · WhatsApp chat · 120 KB". Ready: "{facts} suggested FAQs" (or "No questions found"). Failed: the reason and Retry or "Upload again".

## SCR-APP-028 — Fact (extended: a suggestion's provenance)

- **Strategy and source:** code-native.
- **Provenance line:** for `location.unit = 'chat'`: "From your reply in {source name}" then the confidence and "Open source". The review card uses the same words.

## Manifest and gaps

- SCR-APP-026 gets its own entry: `feature: FEAT-017`, `strategy: code-native`, spec this file's SCR-APP-026 section, states covered reading, suggestions, all-reviewed, empty, failed, loading, error, not-found, permission, delete-confirm; no gaps.
- SCR-APP-007 gains this file in `extended_by`; its gap "chat exports (FEAT-017)" is closed. SCR-APP-023 and SCR-APP-028 gain this file in `extended_by`.
- No design-system escalation: `card`, `field`, `details`, `alert`, `progress`, `status-badge`, `empty-state`, `error-state`, `confirm-dialog` and FEAT-013's review card are all in design.md.
