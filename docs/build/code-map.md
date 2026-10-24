# Code map

Where a feature's changes usually go, so a session can find them without surveying the repo. Find the function with `grep -n`, then read only that range with `sed -n 'A,Bp'`. Don't read big files whole (`contracts/src/index.ts` ~1,160 lines, `db/src/schema.ts` ~980, dashboard pages up to ~860).

## Layers, in the order tasks usually touch them

| Layer | Where | Notes |
|---|---|---|
| Schema | `packages/db/src/schema.ts` (Drizzle tables), `packages/db/drizzle/NNNN_*.sql` (last: `0026`) | `pnpm db:generate`, then add RLS, grants and checks by hand in the same or the next migration. New tenant table: forced RLS + policy, name in `TENANT_SCOPED_TABLES` (end of schema.ts), a case in `packages/db/test/rls.int.test.ts`. Views such as `visitor_facts` are in the SQL migrations. |
| Contracts | `packages/contracts/src/index.ts` | Zod shapes in sections headed `// ---- Dashboard API: <area> (<FR>; FEAT-NNN §3)`. Add a new section at the end. |
| Gateway | `packages/llm-gateway/src/{types,registry,router,policy}.ts`, `providers/fake.ts` | A new logical model goes in `LogicalModel` and both registries, and the fake provider must route it. |
| Domain | `packages/<module>/src/*.ts`, exported from `src/index.ts` | agent: `turn.ts` (`runVisitorTurn`), `dispatch.ts` (`createRegistry`, `dispatchPlan`, `dispatchToolCall`; register handlers here, ADR-025), `plan.ts`, `compose.ts`, `verify.ts`, `render.ts`, `slots.ts`, `gate.ts` (`aiAllowed`), `prompt.ts`, `fake-triage.ts`. kb: `facts.ts`, `writes.ts`, `review.ts`, `conflicts.ts`, `visitor.ts` (`searchVisitorFacts`), `sources.ts`, `ingest/*` (job, extract, promote). tenancy: profile, hours, assistant. governance: `audit.ts`. platform: `outbox.ts` (`enqueue`), config, logger. |
| Workers | `apps/<role>/src/main.ts` | Thin wiring and config; every variable in the role's `.env.example`. |
| API | `apps/api/src/<area>.ts` with `register<Area>Routes(app, deps, sessionFrom)`, wired at the end of `app.ts` | Session and role come from `sessionFrom`; tenant ID never from the body. |
| Dashboard | `apps/dashboard/src/router.tsx`, `pages/*.tsx`, `lib/*.ts` (`api.ts` client, one `lib/<area>.ts` per area) | Placeholders name their feature (`coach` → FEAT-027, `review/corrections`). Shared components in `packages/ui/src` (button, form-dialog, confirm-dialog, states). Only `var(--…)` tokens; read `docs/02-design/design.md` by section. |
| Evals | `evals/cases/feat-NNN-<topic>.json`, `evals/thresholds.json` | Agent-touching features add their own cases (plan §3). |

## Tests

- Unit: `src/**/*.test.ts` next to the code. `pnpm --filter <pkg> test`.
- Integration: `<pkg>/test/*.int.test.ts`, real Postgres via `startTestDatabase()` and `TENANT_A`/`TENANT_B` from `@kaki/db/testing`. API helpers in `apps/api/test/support.ts` (`testApp`, `sessionCookie`, `fakeMailer`). Without Docker: `scripts/test-env.sh pnpm --filter <pkg> test:integration`.
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
