# Tasks: FEAT-044 — Escalation routing, "talk to a person", reminders

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-11-01 (design)

- [x] T1 — Schema: `0045_escalations.sql` (`escalations` with the checks, the partial unique and the two partial indexes; `escalation_routing` with its checks; forced RLS and tenant policies on both; grants for `app_agent_visitor` and `app_dashboard`; role `kaki_escalation_route` and `escalation_candidates()`; `inbox_queue_escalation_reminders()` owned by `kaki_inbox_timer` with its column grants and policy, EXECUTE to `app_outbox`; `inbox_queue_auto_close()` replaced to skip `escalated`; `NOTICE_KINDS` + `escalated` and the notice check; `NOTIFICATION_KINDS` + `escalation_reminder` and its check) + Drizzle tables, `TENANT_SCOPED_TABLES` (design §4; AC-9, D5, D6)
      Done when: `drizzle-kit generate` reports no drift after 0045; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with RLS cases for both tables (tenant B sees and writes nothing of A's), a second open escalation for one conversation refused, `escalation_candidates()` under tenant A returning only A's active members (a deactivated member and tenant B's members absent) and not executable by `app_identity`/`app_outbox`, and `mode = 'person'` without a person refused.
- [x] T2 — Contracts, tenancy, platform: `noticeKind` + `escalated`, `ConversationSummary.escalation`, `ThreadEvent` reason `escalated` + `source`, the escalation section (`EscalationSource`, `EscalateResponse`, `EscalationRouting`, `EscalationRoutingBody` with its refine); tenancy `addBusinessMinutes`; platform `escalation_reminder` kind: sender mute maps it to `escalation`, its email template (D6) (design §3, §5.3; AC-4–AC-6)
      Done when: `pnpm --filter @kaki/contracts test` (round-trips; `EscalationRoutingBody` with `person` and no person refused; extra keys refused), `pnpm --filter @kaki/tenancy test` (the six §5.3 cases) and `pnpm --filter @kaki/platform test` (reminder subject and mute mapping; `scripts/test-env.sh pnpm --filter @kaki/platform test:integration`: a muted `escalation` event skips `escalation_reminder` rows) pass; the three packages typecheck.
- [x] T3 — Inbox escalations: `escalation.ts` (`requestEscalation` with the three statuses, the urgent upgrade, `noticeText` injection; `route` round-robin/person/fallback; `remindEscalation` with re-route, D7 recipients, next time; `escalationsOf`; `queueEscalationReminders`), `transition` resolving the open escalation and cancelling its alerts on every move out of `escalated`, `listConversations` assignee rule, `threadEvents` divider for `escalation.assigned` (design §5.1, §5.2; AC-1, AC-3–AC-7)
      Done when: `pnpm --filter @kaki/inbox test` and `scripts/test-env.sh pnpm --filter @kaki/inbox test:integration` pass with a new `escalation.int.test.ts`: round-robin A B C A; concurrent requests on two clients → different assignees and one open escalation per conversation; person mode; inactive person falls back; repeat → `already_escalated`, no second notice or alert, urgent upgrade once; after hours not urgent and reminder at opening (fixed clock); `with_person` when owned; closed refused; reminders 1–2 to the assignee, 3 to assignee + owners/admins; a reminder after take-over resolves and sends nothing; take-over, hand-back and each close path resolve it and cancel pending and held alerts; the queue function marks and queues once (a second call queues nothing); auto-close skips an escalated conversation; audit payloads carry IDs and codes only; FEAT-042 and FEAT-043 suites green.
- [x] T4 — Agent: `ConversationPort.escalate`, `escalateHandler` in `visitorRegistry`, the turn's escalate-only path and the `unverified` escalation after compose's `escalated` outcome, `escalationNotice` and the new `unsure` and disclosure texts, fakes' in-memory port, eval cases `evals/cases/feat-044-escalation.json` (design §5.4; AC-2, AC-8)
      Done when: `pnpm --filter @kaki/agent test` (handler refused in coaching scope; escalate-only plan stores no agent reply; notice texts en/zh with and without a next opening; disclosure and unsure texts) and `scripts/test-env.sh pnpm --filter @kaki/agent test:integration` (a visitor "can I talk to a person" → escalated with an assignee and an alert; "price and call me" → answered and escalated; two failed verifications → escalated `unverified`, not urgent, no notice) pass; `pnpm eval --fast` passes with the new cases and thresholds unchanged.
- [ ] T5 — Workers and API: scheduler `escalation-reminders.ts` + `ESCALATION_SWEEP_MS` (Zod, `.env.example`); agent-worker `TurnJob` kind `escalation_reminder`; worker port `escalate`; widget route `POST /widget/v1/conversations/:id/escalate`, `controls.talkToPerson: true`; `apps/api/src/escalation.ts` settings routes; summaries' `escalation` with assignee names (design §5.5, §5.6; AC-1, AC-3–AC-7, AC-9)
      Done when: `pnpm --filter @kaki/scheduler-worker test` (the once-runner logs counts and never throws) and `scripts/test-env.sh pnpm --filter @kaki/api test:integration` pass with the §5.6 cases in `escalation.int.test.ts` and the FEAT-033 widget-config test updated to `talkToPerson: true`; agent-worker and api typecheck.

## Build session 2 (UI)

- [ ] T6 — Widget: `escalationPending`, `menuItems` hiding the item while pending or staff handling, the escalate call (creating the conversation first), "Asking the team…" and the failed row, `strings.ts` `askingTeam`, `escalateFailed` (design §5.7; ui-design SCR-WGT-002; AC-1, AC-10)
      Done when: `pnpm --filter @kaki/widget test` (pending from notices; menu items per state; dedupe of the notice from response and SSE) passes and `pnpm build && pnpm size` stays within budget.
- [ ] T7 — Dashboard: `lib/api.ts` routing calls; `lib/inbox.ts` `escalationText`, `waitingFor`, assignee rule in `matchesView`; inbox rows (For {name}/For you, wait time, Urgent chip); the escalation strip in the takeover bar and the `escalated` divider; Team `EscalationCard` (edit, read-only, saving, saved toast, errors, person-inactive alert) (design §5.8; ui-design SCR-APP-014, -015, -045; AC-3, AC-5, AC-7, AC-10)
      Done when: `pnpm --filter @kaki/dashboard test` (unit tests for `escalationText`, `waitingFor`, `matchesView` with an escalation assignee, the card's form helpers) passes and the dashboard typechecks; a stubbed-API Playwright check of the Team card's save and the strip (log only the asserted fields).
- [ ] T8 — E2E `e2e/tests/escalation.e2e.ts` (design §5.9; AC-1, AC-3, AC-4, AC-7, AC-10)
      Done when: the spec is written and lints; it runs in the verify stage's GitHub CI.
      Note: no Docker in cloud sessions, so E2E and screen renders run in CI (STATE.md).
- [ ] T9 — Verify: full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for db, inbox, agent, tenancy, platform, api, widget, dashboard through `scripts/test-env.sh`; tick tasks; status `developer-done`.

## Verification evidence

- AC-1: —
- AC-2: —
- AC-3: —
- AC-4: —
- AC-5: —
- AC-6: —
- AC-7: —
- AC-8: —
- AC-9: —
- AC-10: —
