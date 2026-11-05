# Tasks: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-11-05 (design)

- [x] T1 — Schema: `0049_approvals.sql` and `schema.ts` (`approvals` with checks, `approvals_one_pending_uq`, grants per zone; `boundary_rules.approval_sla_minutes`; `approvals_queue_due()` owned by `kaki_approvals_timer`; `inbox_queue_auto_close()` skips `waiting_approval`; `NOTIFICATION_KINDS` + `approval_undeliverable`, `NOTICE_KINDS` + `approval_waiting`/`approval_rejected`/`approval_expired`, `ESCALATION_SOURCES` + `approval_sla`), name in `TENANT_SCOPED_TABLES`, cases in `rls.int.test.ts` (design §4; D6, D10; AC-12)
      Done when: `drizzle-kit generate` reports no drift after 0049; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with tenant-B-can't-see-A for `approvals`, a second pending approval for one conversation refused, `app_visitor` refused an update, `app_dashboard` refused an update of `draft`, `rejected` without a reason refused, `approvals_queue_due()` queuing urgent/sla/expire once each, and auto-close leaving a quiet `waiting_approval` conversation open.
      Note (build): the sweep marks `expired` itself (so `app_agent_visitor` never updates an approval, AC-12) and the worker sends the notice; `decided_by` has no FK into the identity zone (as `boundary_rules.created_by`) and is null on a D3 auto-sent row; `approval_candidates()` (owned by `kaki_escalation_route`) gives the visitor zone the approver IDs. `approval_undeliverable` is muted with `approval_pending` (platform `muteEvent`).
- [ ] T2 — Contracts: section "Approvals" (§3), `MessageCard` `quote`, notice kinds, `BoundaryRules.approvalSlaMinutes`, rules `approvers`, `ContextSidebar.approval`, `ThreadEvent` approval kinds; Zod-free `@kaki/contracts/quote` (`totalsOf`, `formatSgd`) (design §3, §5.1; AC-6)
      Done when: `pnpm --filter @kaki/contracts test` passes: round-trips, `ApprovalTerms` refusing extra keys and a 21st line, `ApprovalDecision` refusing a blank reason, `totalsOf` table (rounding half up at 15% of S$7.05, 0%, 100%, no lines); dependants typecheck (`pnpm --filter @kaki/approvals --filter @kaki/inbox --filter @kaki/api --filter @kaki/dashboard --filter @kaki/widget typecheck`).
- [ ] T3 — Approvals domain: `quote.ts` (`draftLines`, `kindOf`, `quoteText` en/zh), `drafts.ts` (`draftApproval`, `approvers`), `decide.ts` (`decide`, `deliver`, undeliverable), `timers.ts` (`runApprovalTimer`), queries; `rules.ts` SLA field and `commitmentDecision` per D1; inbox `appendSystemMessage`, `TRANSITIONS.human` + `waiting_approval`, `handBack` to `waiting_approval` with a pending approval (inbox takes a `hasPendingApproval` callback, never imports approvals) (design §5.1, §5.3; D1, D3–D7, D9; AC-1, AC-4–AC-11)
      Done when: `pnpm --filter @kaki/approvals test` (matching: English, CJK bigrams, no match; `kindOf`; `quoteText` both languages; `commitmentDecision` table updated) and `scripts/test-env.sh pnpm --filter @kaki/approvals --filter @kaki/inbox test:integration` pass: draft → row, `waiting_approval`, one audit and one alert per approver; after-hours SLA lands in the next opening; repeat → `already_pending`; approve / edit-approve / reject deliver one message each (closed conversation stays closed); two concurrent `decide` → one winner, one `AlreadyDecided`; closed + no contact channel → `undeliverable` + alert; urgent / sla / expire timers (sla escalates `approval_sla`; decided → no-op); hand-back with a pending approval → `waiting_approval`; no audit payload has amounts or text.
- [ ] T4 — Agent: `approval.ts` `requestCommitmentHandler` (tool `draft_approval`) in `visitorRegistry`; `ConversationPort.draftApproval` in `runVisitorTurn` (retrieved facts, rules, hours); commitment-only turn stores the notice with no reply model; answer + commitment stores the notice after the answer; `approvalNotice` texts; `agent.decision.approval`; `VisitorsWouldGet` for coaching; in-memory port for tests and evals (design §5.2; D2, D3; AC-1–AC-3, AC-11)
      Done when: `pnpm --filter @kaki/agent test` and `scripts/test-env.sh pnpm --filter @kaki/agent test:integration` pass: commitment-only turn → one draft, notice with the SGT time, no `reply.*` call; price question + quote → composed answer then the notice; after hours → next business day text; `allowed` → quote card at once and `approval.auto`; repeat → still-checking text; the FEAT-004/044/049 dispatch tests pass unchanged in what they assert.
- [ ] T5 — Workers and API: scheduler `approval-timers.ts` (`APPROVAL_SWEEP_MS` in `.env.example`); agent-worker `approval_timer` job; `apps/api/src/approvals.ts` (list, detail, decision; 403/409/422; realtime publish); rules route SLA + approvers; inbox sidebar `approval` (design §3, §5.4; AC-5–AC-9, AC-12)
      Done when: `pnpm --filter @kaki/scheduler-worker test` and `scripts/test-env.sh pnpm --filter @kaki/api test:integration` pass: list orders urgent/breached first; detail has excerpt and prices; approve as Owner 200, as Agent without rights 403, as Agent with rights 200; stale version and second decider 409 `already_decided`; expired 409; `edit_approve` with nothing 422; tenant B 404; rules PUT stores the SLA and audits `approval_sla`; sidebar shows the pending approval.
- [ ] T6 — Evals: `evals/cases/feat-055-approvals.json` (≥ 20 cases, design §5.7) and the runner's in-memory `draftApproval` (AC-2, AC-3)
      Done when: `pnpm eval --fast` passes the thresholds with the new cases; every case asserts no model-typed total or discount and the `request_commitment` dispatch.

## Build session 2 (UI)

- [ ] T7 — Widget: `QuoteCard` in `cards.tsx`, approval notices in `strings.ts` (en, zh-Hans) (ui-design SCR-WGT-002; AC-6, AC-13)
      Done when: `pnpm --filter @kaki/widget test` (quote card view helper, zh strings) passes and `pnpm build && pnpm size` stays within budget (the card is in the lazy panel).
      Note: a stubbed Playwright check of the card at 320 px (code-map Widget) before CI.
- [ ] T8 — Dashboard queue and detail: `lib/approvals.ts` (`slaChip`, `termsError`, `decisionText`, list/detail hooks, realtime invalidation), `pages/approvals.tsx`, `pages/approval.tsx`, `pages/approval-parts.tsx` (draft editor, reject dialog), router, nav badge (ui-design SCR-APP-017, SCR-APP-018; D8; AC-5, AC-7, AC-13)
      Done when: `pnpm --filter @kaki/dashboard test` passes (`slaChip` at 31/30/0/−5 minutes, `termsError` cases, `decisionText` per status) and `pnpm --filter @kaki/dashboard typecheck` is clean.
- [ ] T9 — Dashboard rules SLA and approvers block on SCR-APP-042; inbox sidebar Approval section (ui-design SCR-APP-042, SCR-APP-014; AC-4, AC-13)
      Done when: `pnpm --filter @kaki/dashboard test` (SLA field validation) passes; typecheck clean.
- [ ] T10 — E2E `e2e/tests/approvals.e2e.ts`: visitor asks for a quote in the widget → notice; Owner approves with an edit → quote card in the widget; reject path; axe on the queue and detail at desktop and phone width (tall viewport) (AC-1–AC-6, AC-13)
      Done when: the spec passes in GitHub CI (verify stage); locally typecheck only (no stack in cloud sessions).
- [ ] T11 — Verify: full `pnpm lint` and `pnpm typecheck`, this feature's tests, `node scripts/check-rtm.mjs FEAT-055`; status `developer-done`; draft PR
      Done when: all pass; Verification evidence below has one bullet per AC.

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
- AC-11 —
- AC-12 —
- AC-13 —
