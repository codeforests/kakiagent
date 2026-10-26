# Tasks: FEAT-033 — Widget visitor controls and EN / 中文 chrome

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-26

- [x] T1 — Contracts: `Message.language`, `WidgetConfigResponse.privacyNoticeUrl` and `.controls`, the visitor-controls section with `EndConversationResponse` (design §3)
      Done when: workspace typecheck passes (fix every `Message` and config literal it breaks, including `apps/widget/src/preview.ts` and dashboard fixtures); contracts unit tests parse a config with a null and a set privacy URL, reject a non-URL, and parse a message with `language: 'zh'` and `null`.
- [x] T2 — Schema and inbox: `0032_message_language.sql` + Drizzle column and check; `appendAgentReply` `language`, `toMessage`; `endVisitorConversation`; `ConversationClosedError` in `appendVisitorMessage` after the idempotent-retry lookup (design §4, §5.1; D4, D5; AC-1–AC-3)
      Done when: `pnpm db:setup` applies 0032 on a database at 0031 and `drizzle-kit generate` reports no drift; inbox integration tests: end from `ai` and from `human` closes with one audit `conversation.visitor_ended` (no text in the payload), a second end returns `ended: false` with no new audit row, another visitor's and tenant B's conversation throw `NotFoundError`; a new message to a closed conversation throws `ConversationClosedError` and stores nothing, a retry of an already stored `clientMessageId` returns it; a reply stored with `language: 'zh'` reads back through `toMessage`; the check rejects `'fr'`.
- [x] T3 — Agent: `store()` passes the turn's `language` to `appendAgentReply` (design §5.2; AC-2, AC-7)
      Done when: agent integration tests: an English and a Chinese visitor turn store `language` `en` and `zh`; a turn whose conversation the visitor ended before the turn ran stores no reply (gate, existing closed path asserted for `visitor_ended`).
- [x] T4 — API: `POST /widget/v1/conversations/:id/end`, config fields, 409 mapping (design §3, §5.3; AC-1–AC-3, AC-5, AC-6)
      Done when: api integration tests (`testApp`): end returns 200 `{ status: 'closed' }` twice with one audit row and one inbox `conversation` notify; 404 for another visitor's token, tenant B's token and a malformed id; 401 for a wrong Origin; a message POST after end is 409 `chat_ended`; config returns `privacyNoticeUrl: null` and `controls.talkToPerson: false`; `pnpm --filter @kaki/api typecheck` passes.

## Build session 2 (UI)

- [x] T5 — Widget strings and pure helpers: the new keys in both locales, `chromeLocale`, `menuItems`, `api.endConversation`, `ChatEndedError` (design §5.4; AC-6, AC-7)
      Done when: widget unit tests: both locales have identical, non-empty key sets; `chromeLocale` picks the latest agent/system `language`, ignores visitor and staff messages and null, falls back to `navigator.language` then `en`; `menuItems` covers flag on/off, privacy URL set/null, no conversation, ended, preview; `send` maps 409 to `ChatEndedError`.
- [x] T6 — Panel header menu, privacy footer line, live chrome locale (ui-design SCR-WGT-002; AC-5, AC-7, AC-8, AC-9)
      Done when: the dev host page (`pnpm --filter @kaki/widget dev`, stubbed config) shows the menu with keyboard behaviour per ui-design, Escape in the menu leaves the panel open, the privacy item and footer render only with a URL; `lang` on the mount changes to `zh-Hans` when a `zh` reply arrives; `pnpm --filter @kaki/widget build && pnpm size` within budget. Checked in the session's Chromium via Playwright against the dev server (no stack); screenshots in the notes.
      Note: checked 2026-10-26 with a scratch Playwright script against `pnpm --filter @kaki/widget dev`, api and SSE stubbed with `page.route`: no menu button with no conversation and no URL; a `zh` reply sets the mount's `lang` to `zh-Hans` and shows 发送 / 聊天选项; ArrowDown/Enter open on the first item, ArrowUp on the last, arrows wrap, Home/End, Escape closes the menu (panel stays open, focus back on the button), Tab and an outside click close it; with a URL the menu item and footer link have `target=_blank`, `rel=noopener noreferrer` and the name "Privacy notice (opens in a new tab)"; Escape from the composer still closes the panel. Screenshots (session only): menu in zh, menu with privacy item and footer. `panel.js` 11.37 KB gz (limit 35), `loader.js` 4.39 KB gz unchanged.
- [x] T7 — End of chat, SCR-WGT-006 confirm and done, Start a new chat; preview updated (ui-design SCR-WGT-006; AC-1, AC-4, AC-8)
      Done when: on the dev host page with the end and messages routes stubbed: confirm → ending → done, focus moves as specified, cancel and Escape restore focus to the menu button, end failure shows the inline error and keeps the confirm card; Start a new chat clears to the greeting and the next send calls create-conversation; an AI-ended chat (`noticeKind: 'chat_ended'`) shows no Start a new chat; the dashboard preview still renders (no End chat).
      Note: checked 2026-10-26 with the same scratch Playwright set-up (api and SSE stubbed): the confirm card replaces the composer and its title takes focus; Keep chatting and Escape return to the composer with focus on the menu button and no end call (panel stays open); confirm shows "Ending…" with both buttons disabled, then the done card (title focused, transcript notice, one privacy link, footer hidden, menu without End chat); a failed end shows the alert and keeps the card, and a retry ends; Start a new chat shows the greeting, focuses the composer, and the next send creates a second conversation; a 409 on send shows the done card; an AI-ended chat keeps the FEAT-025 notice and closed composer with no Start a new chat and no menu; the preview page renders its sample messages with no menu. The typing indicator is hidden once the visitor ends. `panel.js` 11.92 KB gz.
- [x] T8 — E2E `e2e/tests/widget-controls.e2e.ts` (design §5.5; AC-1, AC-4, AC-5, AC-7, AC-8)
      Done when: the spec typechecks and its tricky steps (menu keyboard, stubbed config via `page.route` + `route.fetch()`) pass in the cloud session's Chromium against the widget dev server. Note: the full spec runs in Ken's local CI (no stack here); follow the code-map E2E pitfalls (`afterEach` restores nothing shared: this spec only creates conversations).
      Note: checked 2026-10-26 in the session's Chromium (`/opt/pw-browsers/chromium`) against the widget dev server, with a scratch stand-in for the api (:3000) and realtime (:3001): "privacy" (real `route.fetch()` config stub, wix dark host, axe with the menu open) and "中文" pass whole; "ends the chat by keyboard" passes with its dashboard block cut (sign-in needs Valkey and Mailpit). The inbox check, the real fake-model replies and WebKit/Firefox run in Ken's local CI.
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
