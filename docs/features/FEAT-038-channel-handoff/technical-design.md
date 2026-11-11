# Technical design: FEAT-038 — Continue on another channel with the history

> Implements: CHN-07, AGT-06 (p: `handoff_channel`) · Realizes: UC-26 (main flow, 1a, 3a, 4a) · Screens: SCR-WGT-004 (new), SCR-WGT-002 (p: header menu item, moved state), SCR-APP-015 (p: "Moved to Telegram" divider) (see [ui-design.md](ui-design.md)) · Module: `channels` (handoff, contact identity, Telegram and email adapters), `inbox`, `agent`; ADR-005, ADR-009, ADR-011, ADR-012, ADR-014, ADR-015, ADR-025
> Status: designed · 2026-11-11

## 1. Intent

A widget visitor who would rather carry on in Telegram or by email can do so without repeating themselves. From the widget's menu, or by asking the agent, they pick a channel the business has live. Telegram: the widget shows a deep link to the business's bot carrying a one-time signed token; when the visitor starts the bot, the token proves the Telegram account belongs to this chat. Email: the visitor types an address, gets a confirmation email from the business, and confirms on a hosted page. Either way the **same conversation** moves to the new channel (CHN-07 "linked to the same Contact and conversation"): its history stays one thread for staff and the agent, the proven identifier joins the conversation's contact as **verified** through FEAT-039's `attachVerified` (merging a contact that already held it), and the visitor gets a short recap on the new channel. The widget then shows "This chat continues on Telegram".

## 2. Codebase context

- **Conversations** have a fixed `channel` (`widget`, `email`, `telegram`); `visitor_channel()` reads the channel's live state and `ai_reply_cap` for the gate (FEAT-034, FEAT-036). Every non-visitor message in a non-widget conversation gets a `message_deliveries` row and a `channel-send` job from the `messages_channel_delivery` trigger, so moving a conversation's `channel` is enough for later replies (AI or staff) to go out on the new channel; earlier messages are never re-delivered (the trigger is insert-only).
- **Telegram** (FEAT-037): `telegram/receive.ts` handles `/start <payload>` for member alert links (`LINK_CODE = /^link-…/`), the group notice and leave (CHN-05, UC-26 3a), and finds a chat's conversation through `telegram_chats.conversation_id`. Service replies are `channel-send` jobs of `type: 'service'`.
- **Email** (FEAT-036): `email/send.ts` replies to `contacts.email` (display column) on the conversation's `email_threads` row, From the business's verified domain address or its forwarding address; `email/receive.ts` threads a reply by `References`/`In-Reply-To` against `email_messages`.
- **Contacts** (FEAT-039): `attachVerified(tx, tenantId, contactId, identity)` adds a verified identifier and merges the contact that already holds it (older survives, audited `contact.merged` `automatic: true`, undoable); FEAT-039 §8 reserved source `link` for this feature. Leads' `contactForCapture` rule (conversation's contact → same `visitor_id`'s latest → new) is the rule this feature reuses for "the visitor's contact".
- **Agent** (ADR-025): `handoff_channel` is already a `TaskKind` (`plan.ts`, args `channel`) with category `state` and no handler (`unhandled`). Card-returning handlers that write nothing: `captureLeadHandler`, `withdrawConsentHandler`.
- **Widget**: header menu from `menuItems` (`chat.ts`); cards in `cards.tsx` per `Message.card` kind; local cards (FEAT-049 `ContactForm`) for menu-opened flows.
- **Hosted pages**: `apps/api/src/privacy.ts` serves the hosted privacy notice as server-rendered HTML with fixed headers (CSP); the email confirm page follows it.
- **Signed links**: FEAT-056's approval links are signed and single-use; identity's magic links carry a secret from config. This feature signs with its own `HANDOFF_LINK_SECRET`.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Channel handoff (CHN-07; FEAT-038 §3)`)

```ts
export const HandoffChannel = z.enum(['telegram', 'email']);
export const HandoffBody = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('telegram') }).strict(),
  z.object({ channel: z.literal('email'), email: z.string().trim().min(3).max(254) }).strict(),
]);
export const HandoffResponse = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('telegram'), url: z.url(), expiresAt: z.iso.datetime() }),   // https://t.me/<bot>?start=c-…
  z.object({ channel: z.literal('email'), sentTo: z.string(), expiresAt: z.iso.datetime() }), // masked: m***@gmail.com
]);
export const HandoffErrorCode = z.enum([
  'channel_unavailable', // 409: channel not connected or not live
  'conversation_closed', // 409
  'moved',               // 409: already continued elsewhere (body has `channel`)
  'invalid_email',       // 422 (checkLead's email rule, @kaki/contracts/lead-check)
  'rate_limited',        // 429 (§5.2)
]);
// MessageCard gains: z.object({ kind: z.literal('handoff'), telegram: z.boolean(), email: z.boolean() })
// WidgetConfigResponse gains: handoff: z.object({ telegram: z.boolean(), email: z.boolean() })
// Widget conversation payloads gain: movedTo: HandoffChannel.nullable()  (the messages read and the SSE `conversation` event)
// NOTICE_KINDS gains 'handoff_recap' (the first message on the new channel) and 'handoff_moved' (widget-only, never sent: UNSENT_NOTICE_KINDS)
export const HandoffEmailJob = z.object({ tenantId: z.uuid(), linkId: z.uuid() });   // outbox topic `handoff-email`
```

| Route | Zone, auth | Result |
|---|---|---|
| `POST /widget/v1/conversations/:id/handoff` | visitor; widget token, visitor owns the conversation (as `/escalate`) | 200 `HandoffResponse`; 409/422/429 `HandoffErrorCode` |
| `POST /widget/v1/conversations/:id/messages` (changed) | visitor | 409 `moved` `{ channel }` once the conversation left the widget |
| `GET /widget/v1/config` (changed) | widget key | `handoff` flags: Telegram connected, live and with a bot username; email connected and live |
| `GET /continue/:code` | none (the code is the credential) | HTML confirm page (`Continue by email at m***@…?` + button); expired page; never consumes |
| `POST /continue/:code` | none; form post, same-origin check | HTML done page or expired page; consumes the link (§5.4) |

## 4. Schema changes (migration `0056_channel_handoff.sql`)

- **`handoff_links`** (tenant-scoped, forced RLS, policy `tenant_id = current_setting('app.tenant_id')`, in `TENANT_SCOPED_TABLES`): `tenant_id`, `id uuid`, `conversation_id`, `contact_id` (FK cascade: FEAT-061 deletes it with the contact, ADR-015), `channel` check in (`telegram`, `email`), `email text` (check: not null exactly when `channel = 'email'`; lower-cased), `created_at`, `expires_at`, `used_at`, `used_chat_id bigint`. Index `(tenant_id, conversation_id, created_at)` for the rate limit. Grants to `app_agent_visitor`: select, insert, update (`used_at`, `used_chat_id`).
- **`conversations`**: `GRANT UPDATE (channel) ON conversations TO app_agent_visitor`; the channel check already allows `telegram` (0054).
- **`contact_identities`**: source check adds `link`; the Telegram check becomes `source in ('telegram', 'link')` with `verified_at` still required; `link` identities are always verified (check `source <> 'link' or verified_at is not null`).
- **Purge** (ADR-015, PII outside contacts kept short): SECURITY DEFINER `handoff_links_purge()` owned by NOLOGIN `kaki_handoff_purge` deletes rows whose `expires_at` is more than 7 days ago, across tenants; returns the count. Scheduler calls it daily.
- `NOTICE_KINDS` check gains `handoff_recap`, `handoff_moved`.

## 5. Component design

### 5.1 Tokens (`packages/channels/src/handoff/token.ts`, pure)

`code = prefix + base64url(linkId[16 bytes] ‖ HMAC-SHA256(secret, tenantId ‖ linkId)[0..16])`: 43 characters after the prefix. Telegram prefix `c-` (45 characters, inside Telegram's 64-character `start` limit and its `[A-Za-z0-9_-]` alphabet, never matching `LINK_CODE`); email prefix `e-`. `signHandoff(secret, tenantId, linkId, channel)`, `openHandoff(secret, tenantId, code): { linkId, channel } | null` (timing-safe compare; wrong prefix, length or MAC → null). Signed rather than stored: the email worker regenerates the code from `linkId`, so no plaintext code sits in an outbox row (D4). Single use and expiry come from the row.

### 5.2 Request (`handoff/request.ts`, `requestHandoff(tx, { tenantId, conversationId, visitorId, body, now })`)

1. The conversation must be the visitor's, `channel = 'widget'` (else `moved`), not closed (else `conversation_closed`).
2. The channel must be live: `visitorChannel(tx, kind).live`; Telegram also needs `telegram_settings.bot_username` (else `channel_unavailable`).
3. Rate limits (D6), counted on `handoff_links`: per conversation 5 links per hour (any channel); email links 3 per conversation per 24 h and 20 per tenant per hour, so the widget can't be used to mail strangers from the business's address.
4. Email: `checkLead`'s email rule (else `invalid_email`), lower-cased.
5. The visitor's contact: the conversation's contact, else the same `visitor_id`'s latest contact, else a new empty contact; set `conversations.contact_id` when empty (the leads rule, FEAT-039 D1; the typed email is **not** an identity until it is proven).
6. Insert the link: Telegram expires in 30 minutes, email in 24 hours (D5). Email: `enqueue(tx, 'handoff-email', { tenantId, linkId })`. Audit `handoff.requested` `{ conversationId, channel }` (no address, ADR-014).
7. Return the deep link `https://t.me/<bot_username>?start=<code>` or the masked address (`maskEmail`: first character, `***`, the domain).

### 5.3 Telegram redemption (`telegram/receive.ts`, a branch beside the alert-link one)

On `/start c-…` in a **private** chat (a group `/start` keeps today's "private messages only" reply and leave, and the token is not consumed: UC-26 3a):
1. `openHandoff` → the row `for update`; invalid MAC, missing, used, expired, wrong channel, or its conversation closed or already moved → reply "This link has expired. Ask your question here and we'll help.", then the usual greeting; nothing else changes, so the visitor's next message starts a new Telegram conversation (UC-26 4a; staff can merge the contacts, FEAT-039).
2. Valid: `used_at = now`, `used_chat_id`. `attachVerified(tx, tenantId, link.contact_id, { kind: 'telegram', value: userId, source: 'link', verified: true })` → the surviving contact (a merge repoints the conversation, FEAT-039 §5.3). Telegram username onto the contact as `contactFor` does today.
3. Upsert `telegram_chats` (`chat_id`, `bot_id`, `contact_id` = survivor, `conversation_id` = the link's conversation). A chat that pointed at an older Telegram conversation now points here; the older one is left as it is.
4. `moveConversation` (§5.5) to `telegram`, then the recap (§5.6) as a `handoff_recap` notice: the trigger delivers it to the chat.
5. Audit `handoff.completed` `{ conversationId, channel: 'telegram', mergedFrom }`. Publish the `conversation` event (with `movedTo`) on `channels.conversation(t, id)` and `channels.inbox(t)`.

### 5.4 Email confirmation (`handoff/email.ts`, worker `handoff-email` consumer, api `apps/api/src/handoff.ts`)

- **Send** (agent-worker, idempotent on `linkId`: skipped when used or expired): From the business's reply address (the `replyFrom` rule in `email/send.ts`, factored into `replyAddressOf(settings, domain)`), To the link's email, subject "Continue your chat with {business}", plain text and HTML: one sentence why, the link `{PUBLIC_API_URL}/continue/<code>`, "It works for 24 hours. If you didn't ask for this, ignore this email." `Auto-Submitted: auto-generated`. Not a conversation message and not an `email_messages` row. A permanent failure is logged and dropped; the widget's "Didn't get it? Send again" covers it.
- **Confirm page** (`GET /continue/:code`): looks the link up (visitor zone, tenant from the signed code's row via a definer lookup `handoff_link_tenant(link_id)`, as `channel_hook_route()` does for hooks), shows the business name, the masked address and one button. GET never consumes, so mail scanners that prefetch links do nothing (D3).
- **Confirm** (`POST /continue/:code`, `Origin`/`Referer` must be the API's own origin): in one visitor-zone transaction: the row `for update`, checks as §5.3 step 1 (expired page on failure) → `used_at` → `attachVerified(…, { kind: 'email', value, source: 'link', verified: true })` → the survivor's display `contacts.email` set to this address (D7: the email adapter sends to the display column) → `moveConversation` to `email` → an `email_threads` row (subject "Your chat with {business}", no references) → the `handoff_recap` notice with the transcript (§5.6), delivered by the trigger as the thread's first email → audit `handoff.completed`, publish as §5.3. The visitor's reply threads back through `email_messages` (FEAT-036); a DMARC-`PASS` reply also resolves to this contact through the now verified identity.
- Pages use `privacy.ts`'s headers (CSP `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`), the tenant's widget accent only through a token-mapped inline style, `lang` from the link's conversation language.

### 5.5 Moving the conversation (`packages/inbox/src/lifecycle.ts`, `moveConversation(tx, tenantId, id, to, now)`)

Compare-and-set on `version` with `channel = 'widget'`: sets `channel = to`, bumps `version`, writes audit `conversation.moved` `{ from: 'widget', to }` (read back by `threadEvents` for the SCR-APP-015 divider), and stores a `handoff_moved` notice in the conversation for the widget ("This chat continues on Telegram.") which `UNSENT_NOTICE_KINDS` keeps off the new channel. Status and owner are unchanged: a conversation a staff member owns stays theirs, and their next reply goes out on the new channel. `ChannelAdapter` code never branches on the old channel (ADR-011); the only check is "was widget".

### 5.6 Recap (`handoff/recap.ts`, pure)

Copies already-sent messages only, never model text (ADR-008): visitor, AI and staff messages, oldest first, notices and internal notes excluded. Telegram: "Hi, this is {business}. Here's where we left off:" then the last 6 messages, each `You:`/`{assistant}:`/`{staff first name}:` and up to 300 characters, then "Carry on here whenever you're ready." Email: the whole transcript up to 50 messages / 20 000 characters (older ones replaced by "… earlier messages not shown"), times in SGT. In the conversation's language (`en`/`zh-Hans` labels). Stored as one `handoff_recap` notice (author `system`), so staff see exactly what was sent.

### 5.7 Agent (`packages/agent/src/dispatch.ts`, `handoffChannelHandler`)

`kind: 'handoff_channel'`, scopes `['visitor']` (refused in coaching), args `{ channel?: 'telegram' | 'email' | other }`, no consent (D1), no boundary. `run` calls `ConversationPort.handoffOptions()` (implemented in `runVisitorTurn` with the §5.2 step 2 checks) and returns a `handoff` card listing only live channels, with reply key `handoff_offer` ("Sure. Where would you like to continue?"); none live → reply key `handoff_none` ("For now we can only chat here."). Writes nothing: the widget's route does. A handoff-only plan stores the card message with that text and no reply model, as withdrawal does; beside an answer, the card follows the answer. Fake triage maps "telegram", "email me", "continue on" phrases to the task; eval cases `evals/cases/feat-038-handoff.json` (single, multi-task with a question, coaching refusal, none live).

### 5.8 Widget (SCR-WGT-004, SCR-WGT-002)

Menu item `continueElsewhere` ("Continue on Telegram or email") when `config.handoff` has a channel and the conversation exists, isn't ended, isn't preview and isn't moved; it opens a local `HandoffCard` at the end of the log (the same component the stored `handoff` card renders). `api.handoff` returns the result or the error code as a value. On `movedTo` (the response to a redeem arrives as the `conversation` event, or a 409 `moved`, or on resume), the panel shows the moved state: the composer is replaced by the stored `handoff_moved` notice and an "Open Telegram" link (Telegram) or the masked address (email), and "Start a new chat here" (starts a new widget conversation as after End chat). Details in ui-design.md.

### 5.9 Scheduler

`handoff-purge.ts`: once a day calls `handoff_links_purge()` (identity of the cross-tenant pattern: `inbox_queue_auto_close`). Env `HANDOFF_PURGE_MS` (default 86 400 000).

## 6. Acceptance criteria

- **AC-1** (CHN-07; UC-26 precondition): `GET /widget/v1/config` reports `handoff.telegram`/`handoff.email` true only for a channel that is connected and live (Telegram also with a bot username); `POST …/handoff` for any other channel → 409 `channel_unavailable`; the menu item and the card offer only those channels.
- **AC-2** (UC-26 steps 1–2): choosing Telegram returns `https://t.me/<bot>?start=c-…` with a token valid for 30 minutes; the token is signed, single use, and names no data; the request is audited without PII.
- **AC-3** (CHN-07 "linked to the same Contact and conversation"; UC-26 step 4): `/start` with a valid token in a private chat attaches the Telegram ID **verified** to the conversation's contact via `attachVerified` (merging a contact that already held it, older survives), links the chat, moves the **same** conversation to `telegram` (same ID, history intact, audit `conversation.moved`), and delivers the recap to that chat; the visitor's next Telegram message is appended to that conversation and the agent's turn sees the widget messages in its history (AGT-12's carried-over history).
- **AC-4** (UC-26 4a): an expired, used, forged or other-tenant token, or one whose conversation closed or moved since, gets the expired reply and the greeting, changes no contact or conversation, and the next message starts a new Telegram conversation.
- **AC-5** (UC-26 3a; CHN-05): `/start c-…` from a group gets the private-only reply, the bot leaves, and the token still works afterwards in a private chat.
- **AC-6** (UC-26 1a): choosing email with a valid address sends one confirmation email from the business's reply address, returns the masked address, and rate-limits (5 links per conversation per hour, 3 email links per conversation per day, 20 per tenant per hour → 429); an invalid address → 422 `invalid_email`.
- **AC-7** (UC-26 1a "verifies it, and the agent continues by email"): `GET /continue/:code` never consumes; `POST` attaches the email as a verified `link` identity, sets the contact's display email, moves the conversation to `email`, and the transcript arrives as the thread's first email; a reply to it is appended to the same conversation; a second POST, or one after 24 h, shows the expired page and changes nothing.
- **AC-8** (SCR-WGT-002/-004): once moved, the open widget shows the moved state without a reload; `POST …/messages` → 409 `moved`; reopening the widget shows the history and the moved state; "Start a new chat here" starts a new widget conversation.
- **AC-9** (AGT-06 p; ADR-025): a `handoff_channel` task in visitor scope returns a `handoff` card with only live channels (or the `handoff_none` text) and writes nothing; in coaching scope it is refused `scope`; the AGT-14 multi-task and dispatch eval subset passes with the new cases.
- **AC-10** (ADR-005, ADR-015): tenant B can't read A's `handoff_links`; a token signed for A fails on B's bot or B's confirm page; `handoff_links_purge()` removes only rows 7 days past expiry and refuses to run as an app role; deleting a contact deletes its links.
- **AC-11** (SCR-APP-015): the thread shows a "Moved to Telegram" / "Moved to email" divider at the move and the recap notice; the conversation's channel icon in the inbox is the new channel; the contact page shows the identifier as verified.
- **AC-12** (SCR-WGT-004; design.md §4.9): the handoff card, email form and moved state have no serious axe violations at desktop and phone width, are keyboard operable, and announce results through the log's live region; copy exists in `en` and `zh-Hans`.

## 7. Decisions

- **D1 — No consent card before email handoff (Ken chose it, 2026-11-11).** The email form states its only purpose ("We'll use this email only to continue this chat") with the privacy link; giving it is deemed consent for that purpose (PDPA s.15). The address never becomes a lead, a marketing contact or a consent row. Telegram collects nothing until the visitor starts the bot.
- **D2 — The same conversation moves channel** (rather than a new linked conversation): CHN-07's criterion says "the same … conversation", staff keep one thread, the agent's history needs no new loading path, and the delivery trigger already routes by the conversation's channel.
- **D3 — Email is proven by a link with a confirm button, not a typed code**: the visitor is on their way to email anyway; GET-safe so link scanners can't consume it.
- **D4 — Signed codes (HMAC with `HANDOFF_LINK_SECRET`), single use by row**: the outbox carries only `linkId`; nothing in the database redeems a link.
- **D5 — Expiry: Telegram 30 minutes, email 24 hours.** Long enough to install Telegram or find the email; short enough that a shared screen's link goes stale.
- **D6 — Rate limits** as AC-6: the email path sends from the business's address to an address a stranger typed.
- **D7 — The proven email becomes the contact's display email**, because the email adapter sends to `contacts.email`; a typed lead-form email it replaces stays as an unverified identity.
- **D8 — Recap copies sent messages, deterministically** (no model, ADR-008): Telegram the last 6, email the transcript up to 50.
- **D9 — After a move the widget is read-only for that conversation**; the visitor can start a new widget chat. Moving back to the widget is out of scope.

## 8. Escalations and open items

- D1 decided by Ken 2026-11-11: no consent card; the form states the purpose.
- A WhatsApp or Messenger handoff waits for FEAT-040; the card's options come from `config.handoff`, so it adds a flag.
- Telegram inline buttons on the recap are out of scope (FEAT-037's follow-up).
- New env vars: `HANDOFF_LINK_SECRET` (api, agent-worker; `gen-local-env.mjs`), `PUBLIC_API_URL` added to agent-worker (api has it), `HANDOFF_PURGE_MS` (scheduler).

## 9. Self-check

- Every AC traces to CHN-07, UC-26 steps or ADR-025; every decision has a reason. Tenant ID only from the widget token, the bot's hook route or the link's definer lookup, never a body. RLS forced on `handoff_links`, with its RLS case. Side effects through the outbox (`handoff-email`, the trigger's `channel-send`). No model writes visitor-facing text beyond the existing reply path; the recap copies sent messages. Module boundaries: channels reaches inbox only through the injected `InboxPort` (gains `moveConversation`), agent → channels via `ConversationPort` (implemented in `runVisitorTurn`). Verified identity only from a proven link (CHN-08).
