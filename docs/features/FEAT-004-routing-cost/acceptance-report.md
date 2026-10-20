# Acceptance Report: FEAT-004 — Model routing, cost governor and usage ledger

> Verdict: **Accepted** (first verification; real-model cost and cache measurements pending environment, M1.5) · Date: 2026-10-20
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-10) @ `f1af986` · Sources: SRS v0.4 (NFR-01, NFR-04, NFR-11, NFR-13, D6), use-cases v0.4 (UC-20 steps 5 and 7), ADR-007, ADR-021, ADR-025
> Repo state audited: `561fce6` (implementation head), plus this verification's test corrections in `f459cba`

## Verdict summary

FEAT-004 is accepted. Every criterion AC-1..AC-10 has a test that asserts what the criterion says. Three tests asserted less than their criterion, so this verification corrected them (AC-4, AC-5, AC-6); all three pass against the code, and two were mutation-checked. Every suite was run fresh in this session with turbo's cache bypassed: format, lint and module boundaries, typecheck, 670 unit and integration tests with coverage, build and widget size, 15 E2E specs, and both eval modes. All were green. On the running stack, a live widget turn showed the triage → dispatch → routed-reply path, its `agent.dispatch` and `agent.decision` audit entries, one ledger row per call with hand-checked costs, and the governor's `warn` line. No rework or design-defect findings. What remains is measuring the real model: cost per conversation, cache hit rate, triage accuracy, and the Messages API accepting the request layout. That is pending environment (M1.5), as design §8 records.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | ADR-025 d1; UC-20 step 5; NFR-04 | `plan.test.ts` (parsePlan wire/object, 6 fallback cases incl. invalid JSON, schema violation, empty tasks; triage request shape; provider error and refusal → fallback); `turn.int.test.ts` "falls back … still answers and routes complex" ×3, "answers a multi-task message" | faithful: request is `model: 'triage'` + `TRIAGE_OUTPUT_SCHEMA` + last 4 messages; price + quote → `answer` + `request_commitment`; fallback is `[answer]`, confidence 0, `fallback: true`, and the turn answers (S$55.00 in body) | green |
| AC-2 | ADR-007 d1, d3 (D8); NFR-13 | `policy.test.ts` (6 complex triggers, tenant thresholds, step +0.1 capped 0.95, D8 rules at step 3); `turn.int.test.ts` "routes by the tenant threshold and the governor step" | faithful, boundary *at* threshold (0.6) tested | green |
| AC-3 | ADR-007 d2 | `prompt.test.ts` (system byte-identical across turns with different facts, messages and times; history append-only; facts and SGT time only in tail); `anthropic-dev.test.ts` (cache_control on system and last history message; tail before visitor text; `output_config.format` for structured output); `plan.test.ts` (triage system is the tenant-free constant) | faithful. The "triage system identical across tenants" check rests on `TRIAGE_SYSTEM` being a constant with no inputs, asserted as the request's `system` (minor, see Findings) | green |
| AC-4 | ADR-021; NFR-11, NFR-13; NFR-04 | `usage.test.ts` (one priced event per generate/stream/embed; none for a failed stream); `usage.int.test.ts` (row fields, sink logs instead of throwing); `rls.int.test.ts` "usage ledger" (cross-tenant insert refused, no read, no update/delete); `turn.int.test.ts` ledger tests incl. ledger outage → still answers, 3 warnings | **was weak → corrected**: the turn-level test checked purpose, model, input tokens and cost only. The corrected test adds turn ID, provider model, all four token counts, a regeneration row and no text columns | green |
| AC-5 | NFR-13 | `usage.test.ts` costOf + gateway costUsd; `usage.int.test.ts` cost stored exactly (`0.0061234567`) | **was weak → corrected**: Opus checked only at zero usage, embed only against `costOf` itself; hand calculations added for Opus, embed and a multiplied Sonnet table | green |
| AC-6 | ADR-007 d3; D6, D9 | `usage.int.test.ts` "cost governor" (raise above S$0.025, band unchanged, once per 24 h, cap 3, lower below S$0.020 after 7 days, <20 conversations and >7-day rows ignored, per-conversation average) | **was weak → corrected**: "the next turn of a raised tenant routes with the raised threshold" had no test linking the governor to a turn; added to `turn.int.test.ts`. The `cost_governor.step_changed` warning has no automated test; verified directly (below) | green |
| AC-7 | ADR-025 d2, d3, d6; AGT-06 | `dispatch.test.ts` (phase then plan order with `turn:index` keys; refusals scope / gate_closed / invalid_args / consent / boundary ×2 without running the handler; throw → failed, next runs; safety endTurn stops and skips audit; unknown tool → scope, not in plan → not_in_plan; audits without argument values; duplicate kind/tool throws) | faithful | green |
| AC-8 | ADR-025 consequences; UC-20 steps 5, 7 | `turn.int.test.ts` multi-task turn (answered, two `agent.dispatch` unhandled entries, codes only, `route` and `tasks` in `agent.decision`); FEAT-022 tests, eval cases and E2E specs | faithful. FEAT-022 test edits are only `req.system` → `req.tail` for facts (declared in design §9) and a stricter call count (≥3); no E2E spec or FEAT-022 eval case changed | green |
| AC-9 | NFR-01 | `turn.int.test.ts` "runs triage alongside retrieval" (200 ms delays on triage and embed; reply request at ≥200 ms and <350 ms; `triageMs` ≥195) | faithful: sequential calls would take ≥400 ms | green |
| AC-10 | ADR-025 d8; NFR-13 | `pnpm eval`, `pnpm eval --fast`; `evals/cases/feat-004-multi-task.json` (15 cases, 6 fast) | faithful. Mutation check: one wrong `expectRoute` and one wrong `expectTasks` each printed `FAIL …`, multi-task dropped to 13/15 (BELOW), exit 1; file restored | green |

## Corrected tests

Commit `f459cba` (`FEAT-004 acceptance: correct tests for AC-4, AC-5 and AC-6`). Test files only; no production code changed.

- **AC-4**, `packages/agent/test/turn.int.test.ts`, new case "records each call with its turn, provider model, four token counts and cost, a regeneration included, and no text". It runs a turn whose first reply is blocked, so it regenerates. It asserts four rows (triage, embed, `reply.simple`/fake-haiku, `reply.complex`/fake-sonnet), each with tenant, conversation, `turn_id` = the visitor message ID, provider, the four counts and a positive cost. It also asserts the row has exactly the ledger columns and contains none of the visitor's or the model's text. Mutation check: making the regeneration reuse the routed model turns it red.
- **AC-5**, `packages/llm-gateway/src/usage.test.ts`, new case: Opus 1000/2000/3000/400 tokens = US$0.0226, embed = US$0.0001 (input only), Sonnet ×1.1 = US$0.01276.
- **AC-6**, `packages/agent/test/turn.int.test.ts`, new case "routes the next turn with the threshold the cost governor raised". A complexity-0.65 plan routes complex at step 0. The test then seeds 25 conversations at S$0.04, runs `runCostGovernor` on the outbox zone (step → 1), and the next turn routes simple (0.65 < 0.7). Seeded rows are removed afterwards. Mutation check: a governor step that does not move the threshold turns it red.

## Independent execution

The local stack was restarted with `pnpm stack:up` after the Docker daemon was found stopped, then `pnpm db:setup` (migrations 0000–0009 applied, seed OK). `pnpm stack:reset` (volume wipe) was not permitted in this session. Testcontainers gives the integration suites a fresh database with every migration applied, and that serves as the fresh-store migration check. Drizzle migrations are forward-only (design §4).

| Check | Command | Result |
|---|---|---|
| Format | `pnpm format:check` | pass |
| Lint + boundaries | `pnpm lint` | pass; dependency-cruiser: no violations (244 modules) |
| Types | `pnpm typecheck` | pass (26 tasks) |
| Unit | `pnpm test` | pass |
| Unit + integration + coverage | `pnpm test:coverage --concurrency=2 --force` | pass, 0 cached; 670 tests: agent 188, analytics 7, api 28, channels 2, db 58 (RLS), governance 93, identity 30, inbox 5, kb 9, llm-gateway 35, platform 265. Per-package thresholds met |
| After corrections | `pnpm --filter @kaki/agent --filter @kaki/llm-gateway test:coverage` | pass: agent 190, llm-gateway 36 |
| Build + size | `pnpm build --force && pnpm size` | pass; loader 1.75 kB gz (≤14), panel 9.34 kB (≤35), initial 1.75 kB (≤30) |
| E2E | `pnpm dev` (started cold, this session), `PLAYWRIGHT_CHROMIUM_EXECUTABLE=… pnpm test:e2e --project=chromium` | 15 passed, no retries or flakes |
| Evals | `pnpm eval` / `pnpm eval --fast` | pass: 67 cases (groundedness 8/8, prices 44/44, multi-task 15/15), S$0.00123 per conversation. Fast: 58 cases, multi-task 6/6 |

Anti-fake-green review of `origin/main...HEAD`: no new `skip`, `only` or `todo`. One deleted test (`router.test.ts`, "routes every skeleton reply to reply.simple") tested `route()`, which the design replaces with `routeReply` (§9 "Breaking changes"). That deletion is declared and sound. `compose.test.ts` changes `system` → `tail` where facts moved (declared). The NRIC masking test's call count rose from ≥2 to ≥3 (stricter). The coverage configuration is unchanged. `@kaki/analytics` dropped `--passWithNoTests` from `test:integration` (stricter).

## Direct verification

All observations below are on the local stack with the fake provider.

- **Live multi-task turn** (widget API, tenant Kaki Bakery): "how much for 50 kueh, can deliver Saturday? my number is 9123 4567".
  - Audit chain for the visitor message: `message.received` → `agent.dispatch {task: request_commitment, outcome: unhandled}` → `agent.dispatch {task: capture_lead, outcome: unhandled}` → `message.ai_sent` → `agent.decision {route: reply.complex, tasks: [answer, request_commitment, capture_lead], models: [reply.complex], planFallback: false, …}`. The phone number appears in no audit payload.
  - Ledger: three rows: triage (fake-haiku, 416 in / 58 out, US$0.0000706), embed (17 in, US$0.0000017), reply.complex (fake-sonnet, 316 in / 18 out, US$0.000812). Hand check: 316×2 + 18×10 = 812 per million ✓; 416×0.1 + 58×0.5 = 70.6 ✓.
  - `turn complete` log line: `route`, `tasks`, `planFallback`, `triageMs: 8`, `costUsd: 0.000884`, `cacheReadTokens: 0`. IDs and codes only (NFR-11).
- **E2E widget turns** each wrote three rows (triage, embed, reply.simple). A hand check of one reply: 439×0.1 + 36×0.5 = 61.9 per million = US$0.0000619 ✓.
- **Governor alert (AC-6, §5.6):** with 25 seeded conversations at S$0.04 for one tenant, a standalone `scheduler-worker` logged at level 40 (warn) `{"event":"cost_governor.step_changed","tenantId":…,"oldStep":0,"newStep":1,"avgSgd":0.04,"conversations":25}` and set the tenant's step to 1. Seed rows were deleted and the tenant reset afterwards.
- **Contracts vs §3:** `GenerateRequest` (`tools`, `tail`, `outputSchema`, `meta.turnId`), `GenerateResult` (`toolCalls`, `stopReason`, `costUsd`), `UsageEvent`, `RoutePolicy`/`routeReply`, `TurnPlan`/`FALLBACK_PLAN`, the dispatcher types and `cost_governor_evaluate` match the design. Schema 0008/0009 matches §4: forced RLS, INSERT-only grants, a NOLOGIN definer, EXECUTE for `app_outbox` only.
- **NFR-01 (indicative):** live fake-provider turns took 14–25 ms in total, with triage finishing in 8–13 ms alongside retrieval. The p95 bound is **pending environment** (MD measurement, k6 at M6).
- **Pending environment**, each with what would verify it:
  - Real-model triage accuracy on the multi-task subset, Sonnet share, cost per conversation against S$0.03, and cache hit rate: the M1.5 real-model gate (`LLM_PROVIDER=anthropic-dev pnpm eval`, then Bedrock at MD).
  - The Messages API accepting the request shape (`output_config.format`, `cache_control` placement): only checked against a stubbed client here. Verified by the first real call at M1.5.
  - The CloudWatch metric filter, alarm and SNS route for the governor line, and the cache-hit alarm: MD (ADR-021).
  - Registry prices were not re-checked against the live price list in this verification (design D5 records the 2026-10-20 list). Re-check at M1.5.
- **Screens:** none (ui-design.md).

## Findings

**Rework:** none.

**Design defect:** none.

**Minor** (recorded, non-blocking):
1. Three acceptance tests were weaker than their criteria (AC-4, AC-5, AC-6). Corrected in `f459cba`; see above.
2. The AC-6 `cost_governor.step_changed` warning has no automated test: `apps/scheduler-worker/src/main.ts` has no test harness. It was verified by running the role. Add a test when the scheduler gets one.
3. `dispatchToolCall` audits an unknown tool as `task: 'answer'` with `tool: 'unknown'` (`packages/agent/src/dispatch.ts`, the `!h` branch). The outcome and reason are right, but the task is a placeholder. FEAT-049, which wires tool calls, may want a clearer code.
4. AC-3's "triage system identical across tenants" is shown by the triage prompt being a constant (`TRIAGE_SYSTEM`) asserted as the request's system, not by two tenants' requests. That is sufficient as built.
5. `fakeTriage` also recognises `crisis`, `data_request` and `handoff_channel`, beyond the keywords §5.5 lists. This is development and test fixture behaviour and is used by the crisis-handler integration test.
6. Traceability: the plan's NFR table (§7) lists FEAT-004 against NFR-03 (scale), but the FEAT-004 entry (§4), the technical design and §6 do not trace NFR-03, and verification there is k6 at M6. No Test ref is appended for NFR-03. Suggested for the next plan revision: drop or explain the touchpoint.

## RTM

Test ref appended to `docs/01-requirements/rtm.md`, Test ref column only:
- NFR-13: `features/FEAT-004-routing-cost/acceptance-report.md` (FEAT-004 is the only feature in its Plan ref; the real-model target measurement is listed above as pending environment)
- NFR-11: `features/FEAT-004-routing-cost/acceptance-report.md (partial)` (per-tenant LLM cost and token tracking)
- NFR-01: `features/FEAT-004-routing-cost/acceptance-report.md (partial)` (triage concurrent with retrieval, AC-9)
- NFR-03: not appended (finding 6)
