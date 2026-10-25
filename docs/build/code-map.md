# Code map

Where a feature's changes usually go, so a session can find them without surveying the repo. Find the function with `grep -n`, then read only that range with `sed -n 'A,Bp'`. Don't read big files whole (`contracts/src/index.ts` ~1,160 lines, `db/src/schema.ts` ~980, dashboard pages up to ~860).

## Layers, in the order tasks usually touch them

| Layer | Where | Notes |
|---|---|---|
| Schema | `packages/db/src/schema.ts` (Drizzle tables), `packages/db/drizzle/NNNN_*.sql` (last: `0030`; FEAT-032 adds `0031`) | `pnpm db:generate`, then add RLS, grants and checks by hand in the same or the next migration. New tenant table: forced RLS + policy, name in `TENANT_SCOPED_TABLES` (end of schema.ts), a case in `packages/db/test/rls.int.test.ts`. Views such as `visitor_facts` are in the SQL migrations. |
| Contracts | `packages/contracts/src/index.ts` | Zod shapes in sections headed `// ---- Dashboard API: <area> (<FR>; FEAT-NNN §3)`. Add a new section at the end. |
| Gateway | `packages/llm-gateway/src/{types,registry,router,policy}.ts`, `providers/fake.ts` | A new logical model goes in `LogicalModel` and both registries, and the fake provider must route it. |
| Domain | `packages/<module>/src/*.ts`, exported from `src/index.ts` | agent: see "Agent pipeline" below. kb: `corrections.ts` (the ADR-010 proposal queue; FEAT-018 adds list, accept with edit, re-confirm) and `stale.ts` (the daily scan) too; FEAT-019 adds `coverage.ts` (the coverage report, `runGapCluster`). kb: `facts.ts`, `writes.ts`, `review.ts`, `conflicts.ts`, `visitor.ts` (`searchVisitorFacts`), `sources.ts`, `ingest/*` (job, extract, promote). tenancy: profile, hours, assistant. channels (FEAT-032): `widget-settings.ts` (widget look, logo, allowed origins on `tenants`, install check, theme-detect job) and the DOM-only `@kaki/channels/theme` export (detect, clamp, resolve) bundled by the widget. governance: `audit.ts`. platform: `outbox.ts` (`enqueue`), config, logger. |
| Workers | `apps/<role>/src/main.ts` | Thin wiring and config; every variable in the role's `.env.example`. Cross-tenant scheduler jobs call a SECURITY DEFINER function owned by a NOLOGIN role (`cost_governor_evaluate` 0009, `kb_stale_scan` 0029, `kb_gap_cluster` 0030 from FEAT-019). |
| API | `apps/api/src/<area>.ts` with `register<Area>Routes(app, deps, sessionFrom)`, wired at the end of `app.ts` | Session and role come from `sessionFrom`; tenant ID never from the body. |
| Dashboard | `apps/dashboard/src/router.tsx`, `pages/*.tsx`, `shell/` (nav, app shell), `lib/*.ts` | No `components/` folder: page parts are files in `pages/` (`coach-chat.tsx`, `review-card.tsx`, `answer-compare.tsx` shared by Replay and Correction), shared ones in `packages/ui/src` (button, form-dialog, confirm-dialog, slide-over, states, skip-link). `lib/api.ts` is one `api` object of typed calls (`getJson`/`request(method, path, ZodShape, body)`, `ApiError`); per-area helpers in `lib/<area>.ts`. Unit tests are `lib/*.test.ts` (Vitest, `--project unit`, since FEAT-027); pages are tested by E2E. Placeholders in `placeholder.tsx` name their feature. Only `var(--…)` tokens; index `docs/02-design/design.md` with `grep -n '^#\|^\*\*`'` and read only the components used. |
| Widget | `apps/widget/src/loader.ts`, `panel.tsx`, `build.mjs` | Outputs in `dist/w/v1`: `loader.js` (iife), `panel.js` (esm, lazy), and from FEAT-032 `preview.js`/`preview.html` (the dashboard's preview iframe) and `detect.js` (injected by the ingest-worker's Chromium). Budgets in `.size-limit.json`; fixture host sites in `dev/sites/`. |
| Evals | `evals/cases/feat-NNN-<topic>.json`, `evals/thresholds.json` | Agent-touching features add their own cases (plan §3). |

## Agent pipeline (read this instead of `turn.ts`, `dispatch.ts`, `coach.ts`)

All in `packages/agent/src`; read a function by range only when a task changes it.

- **Visitor turn**, `runVisitorTurn` (`turn.ts`, run by agent-worker per visitor message): (1) one transaction loads the message, skips if not a visitor's or already answered, checks `aiAllowed` (`gate.ts`: kill switch, channel live, no human owner), the history, disclosure state and opening hours (after-hours notice due?). (2) Gate closed: `paused` stores the fallback text; a human owner or closed chat stores nothing. (3) `triage` (`plan.ts`, model `triage`) runs in parallel with retrieval (`llm.embed` → kb `searchVisitorFacts` over `visitor_facts`, audited `tool.lookup_kb`). Triage never rejects (`FALLBACK_PLAN`); no facts or no plan → `unavailable` with the fallback. (4) Language from the plan, system slots (hours). (5) `dispatchPlan(visitorRegistry, plan, ctx)` runs the non-answer tasks; a safety `endTurn` stores the safety text and ends. (6) `routeReply` picks `reply.simple`/`reply.complex` (ADR-007), then `answerTurn` (`answer.ts`: fixed AGT-04 texts or `composeReply`). (7) `store()` appends the reply, disclosure and notice, and audits guardrail hits plus one `agent.decision` (codes and IDs only, ADR-014); from FEAT-019 it also marks the visitor message as a coverage gap (`markQuestionGap`, inbox) when an `answer` turn ends `unavailable`, `unsure` or `escalated`.
- **Compose**, `composeReply` (`compose.ts`): the model writes text with slot markers (`prompt.ts`); each segment goes `renderSegment` (`render.ts`, fills prices, dates, policies from facts, ADR-008) → `verifySegment` (`verify.ts`) → leak guard (`guard.ts`) → released (streamed via `publishSegment`) only if all pass and the gate is still open. A failure regenerates once on `reply.complex` with the released prefix, then escalates. Provider failure keeps what was released and closes with the fallback.
- **Dispatcher** (`dispatch.ts`, ADR-025): `TaskKind`s are in `plan.ts`. A `TaskHandler` declares `kind`, `scopes` (`visitor`/`coaching`), a Zod `args`, optional `needsConsent`/`checkBoundary`, and `run(ctx, args, idempotencyKey)`. `check()` in order: scope → gate open → args parse → consent → boundary, else `refused` with that reason. `dispatchPlan` runs safety tasks (`crisis`, `abuse`) before state tasks, each in plan order; every task is audited `agent.dispatch`; a thrown handler is `failed` without dropping the rest; no handler is `unhandled`. State tasks may return a `reply` key (`out_of_scope`, `advice`, …) for the composer. `dispatchToolCall` treats a model tool call as a proposal: refused unless its kind is in the plan and scope. Registries: `visitorRegistry` (`dispatch.ts`), `coachingRegistry` (`coach-dispatch.ts`, `proposeCorrectionHandler`). New features add a handler to a registry, never a new path.
- **Coaching turn**, `runCoachingTurn` (`coach.ts`, called by the API, FEAT-027): masks PII, loads the session (`coach-store.ts`), plans; a `correct` task goes to `proposeChange` (`propose.ts`) → a kb correction proposal, never a fact edit (ADR-010); otherwise it answers as a visitor would plus `explain()` (which facts, why, `VisitorsWouldGet`). `reanswer` re-asks the original question once a correction is applied, giving before and after.
- **Fakes** for tests and evals: `fake-triage.ts`, `fake-responder.ts`, `fake-coach.ts`; the gateway's `providers/fake.ts` routes every logical model.

## Tests

- Unit: `src/**/*.test.ts` next to the code. `pnpm --filter <pkg> test`.
- Integration: `<pkg>/test/*.int.test.ts`, real Postgres via `startTestDatabase()` and `TENANT_A`/`TENANT_B` from `@kaki/db/testing`. API helpers in `apps/api/test/support.ts` (`testApp(tdb, …)`, `sessionCookie(tdb, email)`, `fakeMailer`, `testConfig`). Write a new suite from these names; read a neighbour's setup and one case only. Without Docker: `scripts/test-env.sh pnpm --filter <pkg> test:integration`.
- Cross-tenant: every new route or table gets a tenant-B-can't-see-tenant-A case.
- E2E: `e2e/tests/<area>.e2e.ts`, helpers in `e2e/tests/support.ts` (`signIn`, `expectNoSeriousA11yViolations`, `openShadowRoots`). Runs in CI.

## Design docs, read by section

- Plan row: `grep -n 'FEAT-NNN' docs/03-planning/implementation-plan.md`.
- FR / UC / NFR: `grep -n '<ID>' docs/01-requirements/SRS.md` (and `use-cases.md`), then `sed -n` the block.
- Screens: `grep -n 'SCR-APP-NNN' docs/02-design/ux-foundations.md docs/design-manifest.json`.
- ADRs: `docs/02-design/adr/ADR-NNN-*.md`; the invariants in `AGENTS.md` usually suffice.
- Format to copy: the newest feature folder (`ls docs/features`). Read its headings (`grep -n '^## '`), not the whole file. The pattern is below.

## Feature document pattern

- `technical-design.md`: 1 Intent · 2 Codebase context · 3 API contracts · 4 Schema changes · 5 Component design · 6 Acceptance criteria (AC-n, each traced to an FR criterion or UC step) · 7 Decisions (D-n) · 8 Escalations and open items · 9 Self-check. About 200–250 lines.
- `tasks.md`: header `> Executes: …` and `> Status: designed | developer-done | accepted · Last updated`. Tasks `- [ ] Tn — <what> (design §, AC-n)` with an indented `Done when:` line, and `Note:` lines for anything left to CI. The last task is Verify and ends with a "Verification evidence" section, one bullet per AC.
- `ui-design.md`: one section per SCR ID with states (empty, loading, error with a next action), copy, and token use; plus entries in `docs/design-manifest.json`.
- `acceptance-report.md`: verdict line, standard, repo state audited, verdict summary, then per-AC evidence, the test-diff review and the invariant review.

## Big files by anchor

Jump with `grep -n '<anchor>' <file>`, then `sed -n` ~40–80 lines from there. List a file's functions with `grep -n '^export \|^async function\|^function' <file>`. Anchors, not line numbers, so they survive edits.

- `packages/agent/src/turn.ts` (~370 lines, one big `runVisitorTurn`): `async function store(` (stores the reply, audits the decision; turn outcomes are recorded here), `searchVisitorFacts(` (the retrieval step), `aiAllowed(` (the gate check), `dispatchPlan(`, `answerTurn(`.
- `apps/api/src/corrections.ts` (~340): helpers `toItem`, `itemOf`, `contextOf`, `kbEditOf`, `toReplay` above `registerCorrectionRoutes`; inside it, find a route by its path (`grep -n "app\.\(get\|post\)" <file>`). Other `apps/api/src/<area>.ts` files follow the same shape.
- `apps/dashboard/src/pages/correction.tsx` (~780): `CorrectionPage` (main body, most of the file), `Origin`, `FixDiff`, `PastAnswers`, `EditFixDialog`, `EditFixForm`. Other big pages split into named function components the same way.
