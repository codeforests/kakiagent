# Technical Design: FEAT-033 — Widget visitor controls and EN / 中文 chrome

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E4) · Milestone: M2
> Implements: CHN-13 (p: privacy-notice link and end chat; "talk to a person" built and hidden until FEAT-044), CHN-02 (p: widget chrome in the visitor's language, design.md §4.9, UX-Q4) · Realizes: UC-20 steps 2 and 8 · Screens: SCR-WGT-002 (extended: header menu, footer link, chrome locale), SCR-WGT-006 (new: confirm, done; rating is FEAT-031) (see [ui-design.md](ui-design.md))
> Status: Designed · Date: 2026-10-26

## 1. Intent

A visitor can always see how to leave the chat and where the business's privacy notice is. The panel header gets a menu (Talk to a person · Privacy notice · End chat, CHN-13); ending asks once, closes the conversation on the server so the AI stops, and offers a new chat. The privacy-notice link appears in the menu and as a footer line once the tenant has one (GOV-14, written by FEAT-058, next in the build order). "Talk to a person" is built behind a config flag that stays off until FEAT-044 adds escalation routing. Every chrome string comes from the `en` / `zh-Hans` string table, and the panel's language follows the conversation's detected reply language, then `navigator.language`, then `en` (design.md §4.9).

## 2. Codebase context

- Widget: `apps/widget/src/panel.tsx` (one `Panel` component, ~270 lines), `strings.ts` (the table; already `en`/`zh-Hans`, picked from `navigator.language` once at mount), `chat.ts` (pure log helpers, unit-tested in `chat.test.ts`), `api.ts` (`createApi`), `panel.css.ts`, `preview.ts` (the dashboard preview builds a `WidgetConfigResponse` by hand, FEAT-032 §5.3). Escape on the panel mount closes the panel.
- API: visitor routes in `apps/api/src/app.ts` (`visitorFrom` checks the token and Origin; `GET /widget/v1/config`, `POST /widget/v1/conversations`, `POST …/:id/messages`), error mapping to 409 in the same file.
- Inbox: `appendVisitorMessage` (uses the private `visitorConversation` lookup by tenant, id and visitor), `appendAgentReply`, `endAiConversation` (FEAT-025: `ai` → `closed`, audit `conversation.ai_ended`). The visitor zone already has `UPDATE (status, last_message_at)` on `conversations` (0001), so no grant changes for ending.
- Agent: `runVisitorTurn` keeps `language: ReplyLanguage` (`'en' | 'zh'`, `language.ts`) and stores every reply through one `appendAgentReply` call in `store()`. The send gate (`gate.ts`) already keeps the AI silent on a `closed` conversation, including between released segments (code-map, Compose).
- No privacy-notice data exists yet: GOV-14's storage is FEAT-058 (`privacy_settings`). No escalation exists yet: FEAT-044.

## 3. API contracts (`packages/contracts/src/index.ts`)

Additive changes:

```ts
// Message (shared shapes)
/** The reply's language as the agent decided it (FEAT-033): sets the widget's chrome locale. Null on visitor and staff messages. */
language: z.enum(['en', 'zh']).nullable(),

// WidgetConfigResponse
/** The tenant's privacy notice (GOV-14). Null until FEAT-058 stores one: the widget then shows no link. */
privacyNoticeUrl: z.url().nullable(),
/** Visitor controls the tenant can offer (CHN-13). `talkToPerson` stays false until FEAT-044. */
controls: z.object({ talkToPerson: z.boolean() }),

// New section: // ---- Widget API: visitor controls (CHN-13; FEAT-033 §3)
export const EndConversationResponse = z.object({ status: z.literal('closed') });
```

**`POST /widget/v1/conversations/:id/end`** (visitor zone, `visitorFrom` auth; no body)
- 200 `EndConversationResponse`: the visitor's conversation is now `closed`. Idempotent: an already-closed conversation (by the visitor, the AI's abuse rule or later staff) answers 200 again with no second audit entry.
- 404 `not_found`: unknown id, another visitor's conversation, or another tenant's (RLS + the visitor lookup); malformed id is 404 like the messages route.
- 401: missing or bad token, Origin mismatch (existing `visitorFrom`).
- Side effects in one transaction: status `closed` from `ai` or `human`; audit `conversation.visitor_ended` (actor `visitor`, visitor ID, no payload text). After commit, `notify(inbox)` with the `conversation` summary so the inbox list shows it closed.

**`POST /widget/v1/conversations/:id/messages`** (changed): a closed conversation now answers **409 `chat_ended`** ("This chat has ended.") and stores nothing, instead of storing a message no one will answer. A retried POST with an existing `clientMessageId` still returns the stored message (200) first.

**`GET /widget/v1/config`** (changed): returns `privacyNoticeUrl: null` and `controls: { talkToPerson: false }`. FEAT-058 and FEAT-044 fill them; no tenant setting is added here.

## 4. Schema changes (migration `0032_message_language.sql`)

- `messages.language text` nullable, `check (language in ('en','zh'))` (`messages_language_ck`). Set by `appendAgentReply` for agent and system replies; visitor and staff rows leave it null. No backfill: old replies are null and the widget falls back as below. No new table, policy or grant (the visitor zone's `INSERT` on `messages` covers the column; the dashboard reads it through the existing `SELECT`).

## 5. Component design

### 5.1 Inbox (`packages/inbox/src/index.ts`)
- `endVisitorConversation(tx, { tenantId, conversationId, visitorId }): Promise<{ conversation: ConversationRow; ended: boolean }>`: `visitorConversation` lookup (404 via `NotFoundError`), then `update … set status = 'closed' where status <> 'closed' returning`; `ended` is whether this call closed it; audit only when it did.
- `appendVisitorMessage` throws a new `ConversationClosedError` when the conversation is `closed` and no row with that `clientMessageId` exists (check the existing row first, so a retry stays idempotent). `app.ts` maps it to 409 `chat_ended`.
- `appendAgentReply` takes `language?: 'en' | 'zh' | null`; `toMessage` maps the column.

### 5.2 Agent (`packages/agent/src/turn.ts`)
- `store()` passes `language` (the turn's final `ReplyLanguage`) to `appendAgentReply`. Nothing else in the pipeline changes.

### 5.3 API (`apps/api/src/app.ts`)
- The end route beside the messages route, same id check and `visitorFrom`. Config adds the two fields. `ConversationClosedError` → 409 in the error handler.

### 5.4 Widget
- `strings.ts`: new keys in both locales (ui-design.md lists the copy): `menu`, `talkToPerson`, `privacyNotice`, `endChat`, `endConfirmTitle`, `endConfirmBody`, `keepChatting`, `endChatConfirm`, `ending`, `endFailed`, `endedTitle`, `transcriptNotice`, `newChat`, `opensInNewTab`. A unit test asserts both locales have the same keys and no empty string.
- `chat.ts` (pure, unit-tested): `chromeLocale(chat, navLang): Locale`, the language of the latest agent or system message with `language` set (`zh` → `zh-Hans`), else `pickLocale(navLang)`; `menuItems(config, { conversationId, ended, preview })` → the ordered items to render: `talkToPerson` only when `controls.talkToPerson` and not ended; `privacy` only when `privacyNoticeUrl`; `end` only with a conversation, not ended, not preview.
- `api.ts`: `endConversation(id)`; `send` throws a typed `ChatEndedError` on 409 so the panel shows the ended state.
- `panel.tsx`: the locale moves into state derived by `chromeLocale` on every chat change; `mountPanel` sets `lang` on the mount from it (an effect in `Panel` updates the attribute). Header: menu button (`⋯`, `aria-haspopup="menu"`, `aria-expanded`) left of Close; a `role="menu"` list with `menuitem`s (keyboard per ui-design). End flow state: `'open' | 'confirm' | 'ending' | 'ended'`; `ended` (visitor) and FEAT-025's `chatEnded` both close the composer, but only the visitor's end shows the SCR-WGT-006 done card with "Start a new chat" (an abuse-ended chat keeps FEAT-025's notice only). New chat: clear `chat`, `conversationId` (closes the SSE), end state, then focus the composer; the next send creates a conversation. Footer line with the privacy link under the composer when the URL is set. Escape inside the menu or the confirm card closes that layer and stops propagation, so the panel stays open.
- `talkToPerson` click: in this feature only `onTalkToPerson` from props, unset, so the item never renders (flag false). FEAT-044 wires it to its escalation endpoint; it does not go through a typed visitor message, because a button press is a deterministic intent (ADR-025, "the model interprets, code acts").
- `preview.ts`: the hand-built config gains `privacyNoticeUrl: null`, `controls: { talkToPerson: false }`; sample messages gain `language`. The preview renders the menu button with the privacy item only when set; End chat never appears in preview.
- Budget: the additions are strings and one small component; `panel.js` stays ≤ 35 KB gz and `loader.js` is untouched (`.size-limit.json`).

### 5.5 E2E (`e2e/tests/widget-controls.e2e.ts`)
- Against the dev widget host page: open, send a message, open the menu by keyboard, End chat → confirm → done card; the dashboard's conversation list shows it closed; "Start a new chat" gives an empty log with the greeting; a 中文 reply switches the chrome (`lang="zh-Hans"`, 发送) — via a fixture tenant fact answered in Chinese or by stubbing the stream with `page.route`; axe on the menu open and the confirm card. Privacy link: config stubbed with a URL through `page.route` + `route.fetch()` (code-map E2E pitfalls), link has `target="_blank"` and `rel="noopener noreferrer"`.

## 6. Acceptance criteria

- **AC-1** (CHN-13 "a way to end the chat", UC-20 8) A visitor with a conversation opens the header menu and chooses End chat; a confirm card asks once; confirming calls the end route, the conversation is `closed`, audit has one `conversation.visitor_ended` with no message text, and the inbox list receives the closed summary. Cancelling (Keep chatting or Escape) changes nothing.
- **AC-2** (CHN-13, ADR-013) After a visitor ends the chat the AI sends nothing more: a turn for an earlier message that runs after the end stores no reply (gate), and a new POST to that conversation returns 409 `chat_ended` and stores nothing; a retried POST with an existing `clientMessageId` still returns 200 with the stored message.
- **AC-3** (CHN-13) The end route is idempotent (second call 200, still one audit entry); another visitor's, another tenant's or an unknown conversation is 404; a token from another origin is 401.
- **AC-4** (SCR-WGT-006 done) After ending, the composer is replaced by the done card (ended title, transcript notice, privacy link when set, Start a new chat); Start a new chat clears the log to the greeting and the next message opens a new conversation. A chat ended by the AI (FEAT-025) keeps its notice and closed composer, with no Start a new chat.
- **AC-5** (CHN-13, GOV-14) The config carries `privacyNoticeUrl`; when set, the menu's Privacy notice item and the footer line link to it in a new tab (`rel="noopener noreferrer"`, accessible name says it opens a new tab); when null (every tenant until FEAT-058) neither renders and nothing else moves.
- **AC-6** (CHN-13 "talk to a person", plan row) `menuItems` returns Talk to a person only when `controls.talkToPerson` is true and the chat isn't ended; the config always returns false in this feature, so no visitor sees it.
- **AC-7** (CHN-02, design.md §4.9, UX-Q4) Every chrome string, aria-label and placeholder in the panel comes from the string table; both locales have the same non-empty keys. The panel's `lang` and chrome follow the latest agent or system reply's `language` (`zh` → `zh-Hans`), else `navigator.language`, else `en`; tenant-edited texts (greeting, disclosure, notices) show as stored. Agent replies store their language (`messages.language`), exposed as `Message.language`.
- **AC-8** (CHN-02 WCAG 2.1 AA) The menu follows the menu-button pattern (Enter, Space and ArrowDown open it on the first item; arrows and Home/End move; Escape closes it and returns focus to the button without closing the panel; Tab leaves it); the confirm card takes focus on its title and returns it to the menu button on cancel; targets ≥ 44 px; axe has no serious or critical issues with the menu open and the confirm card shown, in light and dark host themes.
- **AC-9** (NFR-02, ADR-016) `panel.js` stays within its size budget and `loader.js` is unchanged; the widget still uses only `--kaki-*` variables.

## 7. Decisions

- **D1 — Privacy link waits for FEAT-058's data.** The plan gives GOV-14's storage to FEAT-058, which is next in M2. This feature adds the nullable config field and both renderings; FEAT-058 only sets the value. No interim tenant column, which FEAT-058 would have to migrate away. Until then no live tenant shows the link, which is acceptable because ONB-09 blocks go-live without one.
- **D2 — Talk to a person is a flag, not a typed message.** The control and its strings ship now behind `controls.talkToPerson` (always false); FEAT-044 adds the endpoint and turns the flag on. Sending "I'd like to talk to a person" as visitor text would make a button depend on triage (ADR-025).
- **D3 — The reply language is stored, not guessed in the widget.** `messages.language` records the agent's `ReplyLanguage`, so the chrome follows the same decision as the reply. Guessing from Han characters in a bubble would flip the chrome on an English reply that names a Chinese product.
- **D4 — Visitor end closes from `ai` or `human`.** A visitor may end a chat a staff member owns; FEAT-042's INB-08 state machine later replaces the direct status write, as it does for `endAiConversation`. No system message is added to the log; staff see the closed status (open item for FEAT-042: a "Visitor ended the chat" row).
- **D5 — Closed conversations refuse new messages (409).** Before this, a message to an abuse-ended chat was stored and never answered. The widget already closes the composer, so only crafted calls see the 409.
- **D6 — No transcript is sent.** No requirement asks for an emailed copy; the done card says the business keeps a record, with the privacy link. Rating (AGT-15) joins the done card in FEAT-031.

## 8. Escalations and open items

- FEAT-058 fills `privacyNoticeUrl`; FEAT-044 sets `controls.talkToPerson` and wires `onTalkToPerson`; FEAT-031 adds the rating card to SCR-WGT-006; FEAT-042 may add a visitor-ended row in the inbox conversation. Recorded in handoff.md.
- The feature touches the widget, so Ken's local CI (size budget, E2E) is due before merge (STATE.md cadence).

## 9. Self-check

CHN-13 → AC-1–AC-6, AC-8; CHN-02 (p) → AC-7–AC-9; UC-20 2 → AC-5, AC-6, 8 → AC-1, AC-4. ADR-013 → AC-2; ADR-016 → AC-9; ADR-025 → D2; ADR-014 → AC-1 (no PII in audit). Contract changes are additive except the 409 on closed conversations (D5). Tasks run contracts → schema/inbox → agent → api → widget helpers → panel → end flow → E2E → verify. IDs checked: CHN-02, CHN-13, GOV-14, ONB-09, AGT-15, INB-08, NFR-02, UC-20, SCR-WGT-002, SCR-WGT-006, ADR-013, ADR-014, ADR-016, ADR-025, FEAT-025, FEAT-031, FEAT-042, FEAT-044, FEAT-058 resolve.
