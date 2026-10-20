# Tasks: FEAT-004 — Model routing, cost governor and usage ledger

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md), none)
> Status: done (all tasks) · Last updated: 2026-10-20

- [x] T1 — Gateway: price tables in the registry, `costOf`, `costUsd` on results, embed usage, the `onUsage` sink, `tools` / `tail` / `outputSchema` / `toolCalls` in the request and result types, and their mapping in the `fake` and `anthropic-dev` providers (design §3.1, §5.1; D2, D5, D6, D11; AC-3 second half, AC-5)
      Done when: llm-gateway unit tests pass for `costOf` against hand calculations (with cache tokens and a multiplier), one usage event per `generate`, `stream` and `embed` with the derived purpose, and the `anthropic-dev` request built from a provider-neutral request (cache_control on system and the last history message, tail before visitor text, `output_config.format`, tools) using a stubbed client; the GOV-04 backstop tests still pass with `tail` unmasked.
      Evidence: `packages/llm-gateway/src/usage.test.ts`, `anthropic-dev.test.ts`, `mask.test.ts` (35 llm-gateway unit tests pass).
- [x] T2 — Router: `routeReply`, `effectiveThreshold`, `DEFAULT_ROUTE_POLICY`, replacing `route()` (design §3.1; D8; AC-2)
      Done when: unit tests cover each rule, a tenant's own thresholds, governor steps 0–3 and the 0.95 cap.
      Evidence: `packages/llm-gateway/src/policy.test.ts`; `route()` removed from `router.ts`.
- [x] T3 — Schema: `usage_events` (drizzle schema + `0008`), `0009` with RLS, grants, the routing columns on `tenants`, `visitor_tenant_state()` recreated, the `kaki_cost_governor` role and `cost_governor_evaluate` (design §4)
      Done when: `pnpm db:setup` applies 0008–0009 on a fresh stack, the RLS suite (with `usage_events` in `TENANT_SCOPED_TABLES` and a cross-tenant case) passes, and `@kaki/tenancy`'s `visitorTenantState` returns the route policy.
      Evidence: `0008_usage_ledger.sql`, `0009_usage_ledger_rls.sql`; `pnpm db:setup` on a fresh stack; `packages/db/test/rls.int.test.ts` "usage ledger" and the `visitor_tenant_state` route fields pass.
- [x] T4 — Analytics: `usage.record`, `usageSink`, `runCostGovernor` (design §5.4; D7, D9; AC-4 ledger half, AC-6)
      Done when: analytics integration tests pass: a recorded event round-trips under RLS; a failing sink logs and resolves; the governor raise, the 24-hour hold, the step-3 cap, the 7-day relax, the minimum-conversation and in-band cases, and a second tenant left unchanged.
      Evidence: `packages/analytics/test/usage.int.test.ts` (7 tests pass).
- [x] T5 — Agent: `TurnPlan`, `parsePlan`, `FALLBACK_PLAN`, `triage` (prompt and JSON schema), `routeSignals`, `fakeTriage`, `fakeAgentScript` (design §3.2, §5.5; D1, D3; AC-1)
      Done when: unit tests pass for a multi-task plan, each fallback cause (invalid JSON, schema failure, empty tasks, refusal, provider error), the triage request shape (model, schema, last 4 messages, tenant-free system) and the fake triager's keyword cases.
      Evidence: `packages/agent/src/plan.test.ts` (20 tests pass).
- [x] T6 — Agent: the dispatcher (`createRegistry`, `dispatchPlan`, `dispatchToolCall`, the empty `visitorRegistry`) (design §3.3; D6; AC-7)
      Done when: unit tests with test handlers show phase order, each refusal reason, `failed` without dropping the next task, `endTurn`, the idempotency key, tool-call refusals (unknown, not in plan), duplicate registration throwing, and an audit call per dispatched task with codes only.
      Evidence: `packages/agent/src/dispatch.test.ts` (13 tests pass).
- [x] T7 — Agent: the cache layout in `buildVisitorPrompt` (system / history / tail), `fakeVisitorResponder` reading `tail`, `composeReply` taking the routed model and using `reply.complex` for the regeneration (design §5.2; D2; AC-3 first half)
      Done when: a unit test shows two turns of one tenant with different facts, messages and times produce byte-identical `system` and append-only messages with facts and time only in `tail`; the existing compose and render-verify tests pass.
      Evidence: `packages/agent/src/prompt.test.ts`; `compose.test.ts` and `render-verify.test.ts` pass (168 agent unit tests).
- [x] T8 — Agent: wire the turn: tenant policy from the gate, triage in parallel with retrieval, `dispatchPlan` with audited outcomes, routing, `meta.turnId`, the `agent.decision` fields, `route` / `plan` / `triageMs` on the result (design §5.3; D4; AC-8, AC-9, AC-4 turn half)
      Done when: agent integration tests pass for a multi-task plan with the empty registry (answer stored, `unhandled` audits, decision fields), a triage failure (fallback plan, still answered, routed complex), routing by tenant threshold, the concurrency timing, and ledger rows per call for a turn when the test wires `usageSink`; the FEAT-022 turn tests pass.
      Evidence: `packages/agent/test/turn.int.test.ts` "runVisitorTurn with triage, dispatch and routing (FEAT-004)" (9 tests) and the FEAT-022 turn tests: 20 pass.
- [x] T9 — Roles: agent-worker's usage sink, `fakeAgentScript` and log fields; scheduler-worker's hourly governor with its config; `.env.example` entries (design §5.6)
      Done when: both roles typecheck and start with `pnpm dev`; a widget message on the local stack writes `usage_events` rows for triage, embed and reply and the `turn complete` line shows route, tasks and cost; the scheduler logs a governor run.
      Evidence: local stack, `pnpm dev`: `turn complete` lines carry `route`, `tasks`, `planFallback`, `triageMs`, `costUsd`, `cacheReadTokens`; `usage_events` holds triage, embed (turns and the api's fact embeddings) and reply rows; scheduler-worker logs `cost governor run`, and with 21 seeded costly conversations logs `cost_governor.step_changed` (step 0 → 1, S$0.035 per conversation) at `warn`.
- [x] T10 — Evals: `plan`, `expectTasks`, `expectRoute`, the `multi-task` subset and threshold, triage and routing in the runner, the dispatch check, the cost report, and `feat-004-multi-task.json` (design §5.7; AC-10)
      Done when: `pnpm eval` and `pnpm eval --fast` pass every subset on the fake provider and print the cost per conversation; a case with a wrong `expectRoute` fails the run (checked, then reverted).
      Evidence: `pnpm eval` 67 cases, `pnpm eval --fast` 58 cases, all subsets ok, cost line printed; a wrong `expectRoute` and a wrong `expectTasks` made `multi-task` 4/6 BELOW and exit 1, then reverted.
- [x] T11 — E2E: the UC-20 specs (skeleton, facts, masking) run with triage and routing on the path (design §5.3; AC-8)
      Done when: `pnpm test:e2e --project=chromium` passes against the local stack with `pnpm dev` restarted after the change. Nothing visible changes, so no spec is added: the path is now real end to end and the existing assertions cover it.
      Evidence: `pnpm test:e2e --project=chromium`: 15 passed against `pnpm dev` with the FEAT-004 roles.
- [x] T12 — Docs: scaffold-notes §4 (fake provider row: routing and cost governor done) and §5 (MD: governor alarm, cache-hit alarm, Bedrock price multiplier), RTM Design ref for NFR-11 and NFR-13 (design §8)
      Done when: the rows name what FEAT-004 built and what MD still owes.
      Evidence: `docs/scaffold-notes.md` §4 (llm-gateway and analytics rows) and §5 (cost and usage bullet); RTM Design ref for NFR-11 and NFR-13.
- [x] T13 — Verify: every acceptance criterion (design §6) demonstrably passes; format, lint (with boundaries), typecheck, unit, integration, coverage, build and size green; eval and E2E pass
      Done when: the commands in AGENTS.md "Checks" pass and each AC is mapped to the test or run that shows it.
      Evidence: format:check, lint (no dependency violations), typecheck, test, test:coverage --concurrency=2 (unit + integration), build and size pass; AC map: AC-1 plan.test.ts + turn fallback tests; AC-2 policy.test.ts + turn routing test; AC-3 prompt.test.ts + anthropic-dev.test.ts; AC-4 turn ledger tests + analytics + RLS suite; AC-5 usage.test.ts; AC-6 analytics governor tests + the local scheduler run; AC-7 dispatch.test.ts + turn endTurn test; AC-8 turn multi-task test + FEAT-022 tests, evals and E2E; AC-9 turn concurrency test; AC-10 the eval runs above.
