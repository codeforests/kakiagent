# Tasks: FEAT-042 — Real-time inbox, conversation view, context sidebar, lifecycle and auto-close

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-31

- [x] T1 — Schema: `0042_inbox_lifecycle.sql` (status enum widened + check; `version`, `closed_at`, `close_reason`, `auto_close_queued_at` with the backfill and `conversations_closed_ck`; the two indexes; `messages.task_kinds` + check; grants to `app_dashboard` and `app_agent_visitor`; role `kaki_inbox_timer`, its policies and `inbox_queue_auto_close()` granted to `app_outbox`) + Drizzle columns and `CLOSE_REASONS` (design §4; AC-5, AC-6, AC-9)
      Done when: `drizzle-kit generate` reports no drift after 0042; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with: a closed row without `close_reason` refused by the check; an unknown task kind refused; `app_dashboard` can update `status` but not `last_message_at`/`flag_reasons`; `app_dashboard` and `app_agent_visitor` can't execute `inbox_queue_auto_close()`.
- [x] T2 — Inbox domain: `lifecycle.ts` (`TRANSITIONS`, `transition`, `IllegalTransitionError`, `StateChangedError`, `AlreadyClosedError`, `closeByStaff`, `autoCloseIdle`, `IDLE_MS`, `queueAutoClose`), `endAiConversation`/`endVisitorConversation` on `transition`, reopen in `appendVisitorMessage`, `appendAgentReply` `taskKinds`, `toSummary` new fields; `views.ts` (`listConversations` with view/channel/keyset cursor, `inboxCounts`, `getThread`, `threadEvents`, `sidebarFacts`, `intentCounts`, `visitorHistory`); kb `factChips`; identity `memberNames` (design §5.1, §5.2; AC-2–AC-9)
      Done when: `pnpm --filter @kaki/inbox test` (unit: the edge table, cursor encode/decode, `IDLE_MS`) and `scripts/test-env.sh pnpm --filter @kaki/inbox test:integration` pass with the §5.1 cases (new `lifecycle.int.test.ts`; the existing suite green, the visitor-ended assertion gaining `from`/`to`); `scripts/test-env.sh pnpm --filter @kaki/kb test:integration -- facts` and `--filter @kaki/identity test:integration` cover `factChips` (labels, dropped missing ID, tenant B) and `memberNames`.
- [x] T3 — Agent and workers: `gate.ts` open set (+ unit cases), `store(` passes task kinds, agent-worker `TurnJob` union and the auto-close job with its publish, scheduler `auto-close.ts` + timer + `AUTO_CLOSE_INTERVAL_MS` in config and `.env.example` (design §5.3; AC-6, D2, D3)
      Done when: `pnpm --filter @kaki/agent test`, `scripts/test-env.sh pnpm --filter @kaki/agent test:integration` (safety suite green with `from`/`to` on `conversation.ai_ended`; a turn stores `task_kinds`; an escalated conversation is answered, a human one isn't), `pnpm --filter @kaki/scheduler-worker test` (`autoCloseOnce` logs and never throws) and `pnpm --filter @kaki/agent-worker typecheck` pass.
- [x] T4 — Contracts and API: changed `ConversationStatus`/`ConversationSummary`/`ConversationList`, the §3 inbox section (+ `inbox-contract.test.ts`), `apps/api/src/inbox.ts` `registerInboxRoutes` replacing the inline route, error mapping, publish on close (design §3, §5.4; AC-1–AC-5, AC-7–AC-9)
      Done when: `pnpm --filter @kaki/contracts test`, `pnpm --filter @kaki/api test` and `scripts/test-env.sh pnpm --filter @kaki/api test:integration` pass with the §5.4 cases (new `inbox.int.test.ts`; the widget-controls suite green); `pnpm --filter @kaki/api typecheck` clean.

## Build session 2 (UI)

- [ ] T5 — Dashboard data: `lib/api.ts` calls, `lib/inbox.ts` (view ↔ URL, `matchesView`, `applySummary`, `appendMessage`, labels), `lib/inbox.test.ts`, `lib/realtime.ts` (list patching per view, counts, thread append, refetch on `ready`) (design §5.5; AC-1, AC-2)
      Done when: `pnpm --filter @kaki/dashboard test` passes with `applySummary` (insert, move to top, drop on leaving the view, flagged view keeps a closed flagged row), `appendMessage` (dedupe, order), view ↔ URL (default view gives `/inbox`); dashboard typecheck clean.
- [ ] T6 — SCR-APP-014 Inbox: page header with live state, view tabs with counts, channel filter, rows (avatar with channel badge, state chip, Flagged chip, preview, time), Load more, empty / filtered-empty / loading / error / reconnecting, the pane layout per width and routes `/inbox`, `/inbox/:conversationId` (ui-design SCR-APP-014; AC-1–AC-3, AC-10)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run at 1440, 1100 and 375 (tall viewport) shows each list state, switching views updates the URL and list, a stubbed WebSocket `conversation` event moves a row to the top and drops it from a view it left, axe clean; the skeleton testids are kept.
- [ ] T7 — SCR-APP-015 Conversation: header (back below 1024, Website visitor, state chip, channel, Flagged chip, Close conversation, "i" sidebar button below 1280), the thread log (bubbles by author, fact chips on AI messages, state and flag dividers, Show earlier messages), the dock per state, close with toast and the 409 handling, the context sidebar (pane / drawer / bottom sheet) (ui-design SCR-APP-015; AC-3, AC-4, AC-7, AC-8, AC-10)
      Done when: dashboard typecheck and build pass; the stubbed Chromium run shows each thread state and dock, a stubbed `message` event appends to the open thread, Close sends `{ version }` and shows the toast, a stubbed 409 `state_changed` shows the inline alert and refreshes, the sidebar opens and returns focus at 1100 and 375, axe clean.
- [ ] T8 — E2E: `e2e/tests/inbox.e2e.ts` (design §5.6; AC-1–AC-4, AC-7, AC-8, AC-10)
      Done when: the spec typechecks (`pnpm --filter @kaki/e2e typecheck`); it runs in the verify stage's GitHub CI.
      Note: no Docker in cloud sessions, so the E2E run and the screen renders are checked in GitHub CI.
- [ ] T9 — Verify: full `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for inbox, agent, api, dashboard; update `code-map.md` (lifecycle and views, `apps/api/src/inbox.ts`, the auto-close job, `pages/conversation*.tsx`, `lib/inbox.ts`; migration 0042); evidence below
      Done when: all pass; evidence recorded.

## Verification evidence

- AC-1 —
- AC-2 —
- AC-3 —
- AC-4 —
- AC-5 —
- AC-6 —
- AC-7 —
- AC-8 —
- AC-9 —
- AC-10 —
