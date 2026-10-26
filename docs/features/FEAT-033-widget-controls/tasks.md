# Tasks: FEAT-033 — Widget visitor controls and EN / 中文 chrome

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-26

- [x] T1 — Contracts: `Message.language`, `WidgetConfigResponse.privacyNoticeUrl` and `.controls`, the visitor-controls section with `EndConversationResponse` (design §3)
      Done when: workspace typecheck passes (fix every `Message` and config literal it breaks, including `apps/widget/src/preview.ts` and dashboard fixtures); contracts unit tests parse a config with a null and a set privacy URL, reject a non-URL, and parse a message with `language: 'zh'` and `null`.
- [x] T2 — Schema and inbox: `0032_message_language.sql` + Drizzle column and check; `appendAgentReply` `language`, `toMessage`; `endVisitorConversation`; `ConversationClosedError` in `appendVisitorMessage` after the idempotent-retry lookup (design §4, §5.1; D4, D5; AC-1–AC-3)
      Done when: `pnpm db:setup` applies 0032 on a database at 0031 and `drizzle-kit generate` reports no drift; inbox integration tests: end from `ai` and from `human` closes with one audit `conversation.visitor_ended` (no text in the payload), a second end returns `ended: false` with no new audit row, another visitor's and tenant B's conversation throw `NotFoundError`; a new message to a closed conversation throws `ConversationClosedError` and stores nothing, a retry of an already stored `clientMessageId` returns it; a reply stored with `language: 'zh'` reads back through `toMessage`; the check rejects `'fr'`.
- [ ] T3 — Agent: `store()` passes the turn's `language` to `appendAgentReply` (design §5.2; AC-2, AC-7)
      Done when: agent integration tests: an English and a Chinese visitor turn store `language` `en` and `zh`; a turn whose conversation the visitor ended before the turn ran stores no reply (gate, existing closed path asserted for `visitor_ended`).
- [ ] T4 — API: `POST /widget/v1/conversations/:id/end`, config fields, 409 mapping (design §3, §5.3; AC-1–AC-3, AC-5, AC-6)
      Done when: api integration tests (`testApp`): end returns 200 `{ status: 'closed' }` twice with one audit row and one inbox `conversation` notify; 404 for another visitor's token, tenant B's token and a malformed id; 401 for a wrong Origin; a message POST after end is 409 `chat_ended`; config returns `privacyNoticeUrl: null` and `controls.talkToPerson: false`; `pnpm --filter @kaki/api typecheck` passes.

## Build session 2 (UI)

- [ ] T5 — Widget strings and pure helpers: the new keys in both locales, `chromeLocale`, `menuItems`, `api.endConversation`, `ChatEndedError` (design §5.4; AC-6, AC-7)
      Done when: widget unit tests: both locales have identical, non-empty key sets; `chromeLocale` picks the latest agent/system `language`, ignores visitor and staff messages and null, falls back to `navigator.language` then `en`; `menuItems` covers flag on/off, privacy URL set/null, no conversation, ended, preview; `send` maps 409 to `ChatEndedError`.
- [ ] T6 — Panel header menu, privacy footer line, live chrome locale (ui-design SCR-WGT-002; AC-5, AC-7, AC-8, AC-9)
      Done when: the dev host page (`pnpm --filter @kaki/widget dev`, stubbed config) shows the menu with keyboard behaviour per ui-design, Escape in the menu leaves the panel open, the privacy item and footer render only with a URL; `lang` on the mount changes to `zh-Hans` when a `zh` reply arrives; `pnpm --filter @kaki/widget build && pnpm size` within budget. Checked in the session's Chromium via Playwright against the dev server (no stack); screenshots in the notes.
- [ ] T7 — End of chat, SCR-WGT-006 confirm and done, Start a new chat; preview updated (ui-design SCR-WGT-006; AC-1, AC-4, AC-8)
      Done when: on the dev host page with the end and messages routes stubbed: confirm → ending → done, focus moves as specified, cancel and Escape restore focus to the menu button, end failure shows the inline error and keeps the confirm card; Start a new chat clears to the greeting and the next send calls create-conversation; an AI-ended chat (`noticeKind: 'chat_ended'`) shows no Start a new chat; the dashboard preview still renders (no End chat).
- [ ] T8 — E2E `e2e/tests/widget-controls.e2e.ts` (design §5.5; AC-1, AC-4, AC-5, AC-7, AC-8)
      Done when: the spec typechecks and its tricky steps (menu keyboard, stubbed config via `page.route` + `route.fetch()`) pass in the cloud session's Chromium against the widget dev server. Note: the full spec runs in Ken's local CI (no stack here); follow the code-map E2E pitfalls (`afterEach` restores nothing shared: this spec only creates conversations).
- [ ] T9 — Verify: full local checks (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for contracts, inbox, agent, api, widget), `pnpm build && pnpm size`; tick tasks; status `developer-done`
      Done when: all green; the evidence below filled in; draft PR open. Note: touches the widget, so Ken's local CI (E2E, size) is due before merge.

## Verification evidence

- AC-1: _pending_
- AC-2: _pending_
- AC-3: _pending_
- AC-4: _pending_
- AC-5: _pending_
- AC-6: _pending_
- AC-7: _pending_
- AC-8: _pending_
- AC-9: _pending_
