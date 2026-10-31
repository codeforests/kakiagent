# Tasks: FEAT-043 — Take over and hand back, single owner

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-31 (design)

- [x] T1 — Schema: `0043_takeover.sql` (`conversation_owners` with PK, FK, `(tenant_id, user_id)` index, forced RLS and the tenant policy; `messages.author_user_id`, `author_name`, `messages_staff_author_ck`; notice kinds `staff_joined`, `staff_left` in `NOTICE_KINDS` and the rewritten notice check; grants: `app_dashboard` SELECT/INSERT/DELETE/UPDATE `(user_id, visitor_name, since)` on owners, INSERT on `messages`, UPDATE `(last_message_at)` on `conversations`; `app_agent_visitor` SELECT/DELETE on owners; the restrictive `messages_dashboard_authors` policy) + Drizzle table, columns, `TENANT_SCOPED_TABLES`; seed member `agent@kaki-bakery.test` ("Mei Ling", role agent) in `setup.ts` (design §4, §5.7; AC-9)
      Done when: `drizzle-kit generate` reports no drift after 0043; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with the RLS case for `conversation_owners` (tenant B sees and deletes nothing of A's), `app_dashboard` inserting a staff row but refused a visitor or agent row, a notice kind outside the four refused, a staff author ID on a visitor row refused, and FEAT-042's grant assertion changed to "`app_dashboard` can update `last_message_at`, not `flag_reasons`" (D5).
- [x] T2 — Contracts and identity: `Message.authorName`, widened `noticeKind`, `ConversationSummary.owner`, `ConversationListQuery.assignee`, `ThreadMessage.authorUserId`, `ThreadEvent` reasons, nullable `to` and `subject`; the takeover section (`TakeOverBody`, `HandBackBody`, `StaffMessageBody`, `TakeoverResult`, `OwnedError`, `InboxMember(s)`, `MemberEvent`); `Me.canReassign`; identity `displayNameOf`, `inboxMembers`, capability `inbox.reassign` for owner and admin (design §3, §5.4; AC-6, AC-7)
      Done when: `pnpm --filter @kaki/contracts test` (round-trips for the new shapes; a `TakeOverBody` with extra keys refused), `pnpm --filter @kaki/identity test` (capability table) and `scripts/test-env.sh pnpm --filter @kaki/identity test:integration` (`displayNameOf` returns null without a display name and never the email; `inboxMembers` lists only this tenant's active members) pass; contracts and identity typecheck clean.
- [x] T3 — Inbox ownership: `ownership.ts` (`takeOver` with `from`, `handBack`, `requestHandover`, `sendStaffMessage` with `piiMask` and `clientMessageId`, `staffNotice` texts en/zh, `ownerOf`, `ownersOf`, the error classes), `transition` deleting the owner row on `→ closed` and `human → ai`, `LIFECYCLE_ACTIONS` + `threadEvents` mapping, `listConversations` assignee filter and owner join, `toMessage`/`getThread` author fields (design §5.1, §5.3; AC-1, AC-3–AC-9)
      Done when: `pnpm --filter @kaki/inbox test` (notice texts per language, event mapping) and `scripts/test-env.sh pnpm --filter @kaki/inbox test:integration` pass with the §5.1 cases in a new `ownership.int.test.ts` (including two concurrent take-overs on two clients → one owner, the other `OwnedError` naming the winner) and the FEAT-042 lifecycle suite green.
- [x] T4 — Gate: `aiAllowed` closed when an owner row exists (design §5.2; AC-2)
      Done when: `pnpm --filter @kaki/agent test` (an owner row with status `ai` closes the gate) and `scripts/test-env.sh pnpm --filter @kaki/agent test:integration` pass with: a visitor message to a taken-over conversation stores no reply and makes no model call; after hand-back the next one is answered; a turn whose gate closes between segments releases nothing further.
- [ ] T5 — API and realtime: the four POST routes and `GET /api/v1/inbox/members` in `apps/api/src/inbox.ts`, error mapping, close → 409 `owned` for non-owners, `assignee` on the list route, owner names via `memberNames`, publishes (inbox, conversation, member channels); `/ws` forwards `MemberEvent`s from `channels.member` (design §3, §5.4; AC-1–AC-9)
      Done when: `pnpm --filter @kaki/api test`, `scripts/test-env.sh pnpm --filter @kaki/api test:integration` (new `takeover.int.test.ts` with the §5.4 cases, including the parallel take-over pair and cross-tenant 404s; `inbox.int.test.ts` green) and `pnpm --filter @kaki/realtime test` (a member event reaches only that member's socket; `session_ended` still closes it) pass; api and realtime typecheck clean.

## Build session 2 (UI)

- [ ] T6 — Widget: `rowsOf` notice-only rows and staff name, `staffHandling`, `awaitingTurn` silent while staff handle, `strings.ts` `teamMember`, the staff name line in `panel.tsx` (design §5.6; ui-design SCR-WGT-002; AC-1, AC-3, AC-4)
      Done when: `pnpm --filter @kaki/widget test` passes with `rowsOf` (empty body → notice only; staff label from `authorName`, else "A team member"/"团队成员"), `staffHandling` (joined → true, then left → false), no typing turn while staff handle; `pnpm --filter @kaki/widget build && pnpm size` within budget.
- [ ] T7 — Dashboard data: `lib/api.ts` calls, `lib/inbox.ts` (`dockMode`, assignee ↔ URL, `matchesView` with assignee, `takeoverErrorText`, `ownerText`), `lib/realtime.ts` member-event toasts and thread refetch (design §5.5; AC-5–AC-7)
      Done when: `pnpm --filter @kaki/dashboard test` passes with `dockMode` for each state and owner, assignee ↔ URL (default leaves no param), `matchesView` dropping a row whose owner left the filter, each error code's text; dashboard typecheck clean.
- [ ] T8 — SCR-APP-015 takeover UI: `TakeoverBar`, `Composer` (send, sending, failed with retry, Ctrl/Cmd+Enter), `OwnedBar` (request, request sent, take-from with `ConfirmDialog` for `canReassign`), "Visitor sees" rows, staff bubbles with names and "You", new dividers, conflict alerts, focus moves (ui-design SCR-APP-015; AC-1, AC-3–AC-6, AC-10)
      Done when: dashboard typecheck and build pass; a stubbed-API Chromium run at 1440 and 375 (tall viewport) shows ai → take over → composer → send → hand back, the 409 `owned` alert and owned bar, request sent, the take-from dialog's focus return, no horizontal scroll, axe clean.
- [ ] T9 — SCR-APP-014 assignee filter and owner captions (ui-design SCR-APP-014; AC-7, AC-10)
      Done when: the stubbed run switches Anyone → Mine → Unassigned → a teammate, the URL follows and a stubbed `conversation` event with a new owner moves the row in or out of the filtered list; axe clean.
- [ ] T10 — E2E `e2e/tests/takeover.e2e.ts` (design §5.7; AC-1–AC-7, AC-10)
      Done when: the spec typechecks and its steps pass in the cloud session's Chromium where they can run without the stack (stubbed); the full spec runs in the verify stage's GitHub CI.
      Note: no Docker here, so the live-stack run is left to CI (STATE.md, Environment).
- [ ] T11 — Verify: full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for inbox, agent, api, identity, widget, dashboard through `scripts/test-env.sh`; tick tasks; status `developer-done`.
      Done when: all pass; the evidence below is filled in.

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
