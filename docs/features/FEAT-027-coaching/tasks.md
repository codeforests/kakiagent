# Tasks: FEAT-027 — Coaching mode

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-24

- [x] T1 — Schema: `coaching_sessions`, `coaching_messages`, `corrections`, `usage_events.coaching_session_id` (drizzle schema + `0027`, grants, forced RLS, checks); names in `TENANT_SCOPED_TABLES`; RLS suite cases for the three tables and "no visitor-role grant" (design §4; AC-8 schema half)
      Done when: `pnpm db:setup` applies 0027 on a database at 0026; `drizzle-kit generate` reports no drift; the RLS suite passes with the new cases.
- [x] T2 — Contracts, identity and gateway: the §3 shapes in a new contracts section; capability `coach.use` (owner, admin); `meta.coachingSessionId` through `onUsage` to `usage.record`; `TaskKind` `correct` with `PHASE.correct = 'state'` (design §3, §5.2, §5.3; ADR-026)
      Done when: typecheck passes across the workspace; identity and gateway unit tests pass (capability matrix, usage carries `coachingSessionId` with `conversationId` null).
- [x] T3 — KB: `CoachingKbContext`, `searchCoachingFacts`, `corrections.ts` (propose, confirm, dismiss, errors, views) (design §5.1; AC-3, AC-5, AC-6, AC-7 kb half)
      Done when: kb integration tests pass: unreviewed excluded/included by the flag, rejected/conflicted/disabled never returned; each proposal kind validated (bad patch, unknown fact, no-op change rejected); confirm makes a new approved version and chunk visible through `searchVisitorFacts` in the same commit; stale version → `CorrectionStaleError` with nothing changed; decided twice → `CorrectionClosedError`; audit entries carry codes and IDs only.
      Note: `edit_hours` proposals are validated by tenancy's `WeeklyHours` in the agent's handler (kb doesn't depend on tenancy); kb checks only that a day changes. `contentChanged` now compares values with sorted keys: jsonb reorders keys, so a no-op edit read as a change.
- [x] T4 — Agent, propose path: `COACH_TRIAGE_SYSTEM` and `triage({ system })`, `propose.ts` (`PROPOSE_SYSTEM`, schema, `parseProposal`), `proposeCorrectionHandler`, `coachingRegistry` (with `outOfScopeHandler` in both scopes), the `coaching.propose` port on `DispatchContext`, fakes for both prompts (design §5.2; D2, D4; AC-10)
      Done when: agent unit tests pass: proposals parsed for each kind, unknown refs → `none`; `dispatchToolCall` refuses `propose_correction` without a `correct` task (`not_in_plan`) and in visitor scope (`scope`); a visitor plan with `correct` reports `unhandled`; the fakes return the designed plans and proposals.
- [x] T5 — Agent, the turn: `coach-store.ts`, `explain()`, `runCoachingTurn`, `reanswer` (design §5.2, §5.3; D3, D5, D7, D9; AC-2, AC-4, AC-8, AC-9, AC-11)
      Done when: agent integration tests on the fake provider pass: a grounded answer with explainer facts, used IDs and reasons; out-of-scope gives the AGT-04 text; a correction message stores a proposal and makes no reply-model call; paused and not-live tenants still get answers with `visitorsWouldGet` set; no `conversations`/`messages`/`outbox` rows written; masked text stored.
      Note: `channelLive` is a dep defaulting to live, since no channel-live state exists until FEAT-034; `not_live` is tested through it. 0027 also grants the dashboard `visitor_tenant_state()` and `UPDATE (coaching_message_id)` on corrections (the proposal is stored before its chat message). The usage column-list test gained `coaching_session_id`.
- [ ] T6 — Hours corrections: `edit_hours` proposal and the `applyHours` port over `saveBusinessProfile` (design §5.4; D10; AC-12).
      Done when: integration test: an hours proposal for sat/sun, confirmed, saves the profile and the visitor hours slot renders the new times; a profile saved in between → `CorrectionStaleError`.
- [ ] T7 — API: `apps/api/src/coach.ts` with every §3 route, rate limit, error mapping; wired in `app.ts` (design §3, §5.5; AC-1, AC-6, AC-7, AC-8, AC-9, AC-15)
      Done when: api integration tests pass for every designed success and error, including tenant B's 404s, staff 403, the 429 after 20 turns, confirm → visitor search sees the new value, and the turn's elapsed time under 8 s on the fake provider.
- [ ] T8 — Evals: `evals/coaching/cases.json`, `evals/src/coaching.ts`, `coaching.test.ts` (design §5.6; AC-14)
      Done when: `pnpm --filter @kaki/evals test` passes with every coaching case scored on the fake provider.
      Note: the real-model run is pending (pending-actions.md), like FEAT-012's extraction set.
- [ ] T9 — Dashboard, Coach: `lib/coach.ts`, `coach-chat.tsx` (thread, composer, unreviewed toggle, `answer-explainer`, proposal card, confirm/dismiss, before/after), `/coach` page with sessions (ui-design SCR-APP-030)
      Done when: dashboard typecheck and unit tests pass; the page renders every state in ui-design against the local API.
      Note: no local stack in cloud sessions; renders are checked by T11's E2E in CI.
- [ ] T10 — Dashboard, setup step and quick panel: `/setup/test` (SCR-APP-010) with suggestions, the review step's Continue → `/setup/test`; `quick-coach-panel.tsx` from Review fact cards and the Fact page, full page below 768 px (ui-design)
      Done when: dashboard typecheck and unit tests pass; the panel's prefill and the mobile redirect are unit-tested.
- [ ] T11 — E2E: `e2e/tests/coach.e2e.ts` for J11 [UC-04]: ask → explainer → teach a price → confirm → the widget quotes the new price; the setup test step; axe on SCR-APP-030 and SCR-APP-010 (design §6; AC-6, AC-13)
      Done when: the spec passes in CI's E2E job.
      Note: E2E runs only in CI (STATE.md); pending CI until the next CI run.
- [ ] T12 — Verify: every AC in design §6 demonstrated; `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, this feature's package tests and integration tests green
      Done when: the evidence below is filled in, one bullet per AC.

## Verification evidence

- AC-1 … AC-15: _to be filled by the build's last task._
