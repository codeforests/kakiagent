# AGENTS.md

Guidance for coding agents (and people) working in this repository. `CLAUDE.md` only points here, so this file is the single source of truth.

## What this repository is

KakiAgent (a placeholder name, set in config per D4) is a multi-tenant SaaS for Singapore SMEs. It builds a knowledge base from an SME's website, files and chat exports, and runs an AI customer agent on a web widget, email, Telegram and Meta channels, with human takeover, approvals, PDPA tooling and IMDA-aligned governance.

The repo holds the signed-off SDLC documents (`docs/`) and the **walking skeleton** (FEAT-001, plan §2): one message path from the widget through every runtime role to the dashboard inbox, with the foundations every feature builds on. What is real and what is stubbed is listed in `docs/scaffold-notes.md`.

## Repository layout

| Path | What it is |
|---|---|
| `apps/api`, `apps/realtime`, `apps/agent-worker`, `apps/ingest-worker`, `apps/scheduler-worker` | The five runtime roles of the modular monolith (ADR-001). Each is a thin `main.ts` that wires packages together; logic lives in packages. |
| `apps/dashboard`, `apps/operator` | React + Vite front ends (owner/staff dashboard PWA, operator console). |
| `apps/widget` | The embeddable widget: loader + lazy Preact panel in a closed Shadow DOM (ADR-016). |
| `packages/<module>` | Domain modules (architecture §5.2): `tenancy`, `identity`, `channels`, `inbox`, `agent`, `kb`, `leads`, `approvals`, `analytics`, `governance`. Placeholders name the feature that fills them. |
| `packages/db`, `platform`, `contracts`, `llm-gateway`, `design-tokens`, `ui` | Shared infrastructure: schema, migrations and RLS; config, logging, telemetry, queue, pub/sub and outbox; Zod API contracts; the only route to models; tokens built from `docs/02-design/tokens.json`; shared React components. |
| `e2e/` | Playwright tests against the running local stack. |
| `evals/` | The AI evaluation runner, cases and `thresholds.json` (AGT-14, ADR-022). |
| `infra/local/`, `docker-compose.yml` | Local stack: Postgres 16 + pgvector, Valkey, LocalStack (SQS, S3), Mailpit, ClamAV. |
| `infra/terraform/` | AWS modules and the `envs/prod` root, which runs the lean launch profile until the prod trigger and the ADR-003 design after it (`profile = "launch" | "full"`, ADR-023, ADR-024). Written, validated and tested with `terraform test`; **never applied** until milestone MD. |

## Commands

Node 22 (`.nvmrc`) and pnpm 10 (`packageManager`). Docker is needed for the local stack and the integration tests.

```sh
pnpm install

# Local stack, first time or after `pnpm stack:reset`
node scripts/gen-local-env.mjs   # writes .env files with random local secrets (never committed)
pnpm stack:up                    # docker compose up -d --wait
pnpm db:setup                    # roles, migrations, RLS, the two dev tenants
pnpm dev                         # every app in watch mode

# Checks (CI runs all of these, .github/workflows/ci.yml)
pnpm format:check
pnpm lint                        # ESLint, then dependency-cruiser module boundaries
pnpm typecheck
pnpm test                        # unit tests, including the design-token contrast check
pnpm test:integration            # Testcontainers: RLS cross-tenant suite, outbox, inbox, agent
pnpm test:coverage               # unit + integration with per-package thresholds
pnpm build && pnpm size          # widget budget (ADR-016, NFR-02)
pnpm test:e2e                    # needs the stack and db:setup; starts `pnpm dev` if not running
pnpm eval [--fast]               # the eval set on the fake provider

# One package: pnpm --filter @kaki/inbox test:integration
# One E2E browser: pnpm test:e2e --project=chromium
```

Local URLs: dashboard http://localhost:5173 (sign in at `/sign-in` as `owner@kaki-bakery.test` or `owner@second-tenant.test`; the link arrives in Mailpit), operator http://localhost:5174, widget host page http://localhost:5175, api :3000, realtime :3001, worker health ports 3002–3004, Mailpit http://localhost:8025.

Other: `pnpm db:generate` (Drizzle migration from `packages/db/src/schema.ts`), `pnpm tokens` (rebuild token CSS), `pnpm audit:verify --tenant <uuid>` (recompute a tenant's audit chain against its S3 anchors; exit 1 names the first broken entry), `pnpm fixtures:site` (the FEAT-012 fixture website on :5176; the local ingest-worker maps `kakibakery.test` to it through the dev-only `CRAWL_HOST_MAP`, and `pnpm test:e2e` starts it), `pnpm stack:down`, `pnpm stack:reset` (wipes local data). The ingest-worker crawls with Chromium through `playwright-core`; where its pinned browser isn't installed, set `CHROMIUM_EXECUTABLE_PATH` to a local Chromium (and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for the E2E browser) (CI installs it with `playwright-core install --only-shell chromium`). Without Docker, integration tests take `KAKI_TEST_DATABASE_URL` (Postgres 16 + pgvector superuser URL) and `KAKI_TEST_S3_ENDPOINT` (an S3 endpoint with Object Lock) instead of Testcontainers.

## Code conventions

- **Module boundaries are enforced** by `.dependency-cruiser.cjs` (run by `pnpm lint`). Import another module only through its package name (its `src/index.ts` or a declared `exports` entry); never its internals. Packages never import apps. Provider SDKs only in `llm-gateway`. `@kaki/db/testing` only in tests. No cycles.
- **Every tenant-scoped table** gets forced RLS and a policy in the same migration, its name in `TENANT_SCOPED_TABLES`, and a case in `packages/db/test/rls.int.test.ts`. The suite fails if a tenant-scoped table has no policy.
- **Database access** goes through `withTenant(zoneDb, tenantId, fn)` on the connection of the right trust zone (`createZoneDb('dashboard' | 'visitor' | 'outbox' | 'identity')`; `identity` is for sign-in and sessions only). The tenant ID comes from a verified token, session or widget key, never from a request body.
- **Side effects** are written with `enqueue(tx, …)` from `@kaki/platform/outbox` in the same transaction as the change.
- **Config** is parsed with Zod at start-up (`loadConfig`); every variable is listed in the unit's `.env.example`.
- **Dev-only code:** none remains; FEAT-005 replaced the dev sign-in with real sign-in (locally, sign-in links arrive in Mailpit). Any future dev-only code is guarded by `process.env.KAKI_BUILD !== 'production'` in Node roles and `import.meta.env.DEV` in the dashboard, so production builds drop it; CI checks the bundles for the old dev sign-in.
- Pinned exact dependency versions; Renovate proposes updates. Formatting is Prettier (Markdown excluded); ESLint flat config at the root, with the Vite apps keeping their generated configs.
- Tests live next to the code (`src/**/*.test.ts`, unit) or in `test/**/*.int.test.ts` (integration, real Postgres via Testcontainers).

## How work is run: phase by phase, with sign-off gates

The product owner signs off each phase before the next one starts. Don't jump ahead, for example to writing code before the plan and per-feature designs exist. At each gate, ask the owner the open questions and get explicit sign-off. Deliver each phase as a branch and a PR for review.

| Phase | Location | State |
|---|---|---|
| Requirements | `docs/01-requirements/` (`SRS.md`, `use-cases.md`, `rtm.md`) | Signed off 2026-10-19 (SRS v0.4, decisions D1–D11) |
| Architecture | `docs/02-design/architecture.md`, `docs/02-design/adr/ADR-001..022` | Signed off and merged 2026-10-19 |
| UX foundations | `docs/02-design/ux-foundations.md`, `design.md`, `tokens.json`, `anchor-screens.md` + `anchors/`, `docs/design-manifest.json` | Signed off 2026-10-19 (owner decisions UX-Q1, Q4, Q5, R4 recorded) |
| Implementation planning | `docs/03-planning/implementation-plan.md` (FEAT-001..074, milestones M0–M7, M1.5 real-model gate) | Signed off 2026-10-19 |
| Construction | `docs/features/FEAT-NNN-<slug>/`, one PR per feature, in plan §5 order | In progress: done features and the next one are in `docs/build/STATE.md`; skeleton notes in `docs/scaffold-notes.md` |

## Document rules

- **Signed-off documents are read-only.** Change the SRS or use cases only through a formal amendment: a new SRS version with a revision-history row, the previous version archived in `docs/01-requirements/archive/`, and an entry in `.requirements-progress.md`. Don't change a signed-off ADR's decision in place; write a new ADR that supersedes it.
- **IDs are permanent and never reused.** A removed requirement keeps its row, marked *Removed*. The next free IDs per area are listed in `docs/01-requirements/.requirements-progress.md`. Cite IDs (FR, NFR, UC, D, ADR) rather than restating requirements.
- **RTM column ownership** (see the table at the top of `rtm.md`): only requirements engineering adds rows or edits the requirement columns. Design ref is appended by architecture and detailed design, Plan ref by planning, and Test ref by acceptance verification. Append to cells, never overwrite.
- Downstream phases list any problems they find in upstream documents in their own "Open issues" section (for example, `architecture.md` §12) rather than editing the upstream document.
- The research `.docx` files are deliberately kept out of git (`.gitignore`). Never commit them; the SRS already summarises what they say.

## Architecture invariants (from the accepted ADRs)

These span many documents and are easy to break by accident. Read the cited ADR before changing anything nearby.

- **Stack:** TypeScript end to end (C1). pnpm + Turborepo monorepo; Fastify + Zod; Drizzle; React/Vite dashboard PWA; Preact widget; Vitest, Playwright and Testcontainers. One modular monolith deployed as five runtime roles: `api`, `realtime`, `agent-worker`, `ingest-worker`, `scheduler-worker` (ADR-001, ADR-002).
- **Residency:** all data at rest, including backups, lives only in AWS ap-southeast-1. The single exception is Claude inference, which goes through **Bedrock's `au.` profile** (Sydney/Melbourne), invoked from ap-southeast-2 with retention set to `none` and no automatic Global failover. Embeddings use Cohere Embed Multilingual v3 in-region (ADR-003, ADR-006, ADR-019).
- **Models go only through the `llm-gateway` component.** It holds `ModelRouter`, the `ModelProvider` interface and a model registry. Haiku 5.5 handles triage and simple turns; Sonnet 5.5 handles complex turns, with a per-tenant cost governor (target ≤ S$0.03 per conversation). No other module calls a provider SDK directly. A new provider must pass the AGT-14 evaluation gate and be declared as a sub-processor (ADR-007).
- **Tenant isolation:** every tenant-scoped table has `tenant_id` with *forced* RLS. Application roles never own tables. Tenant context is set with `SET LOCAL` per transaction, and only from a trusted source. Vector search also filters by tenant explicitly (ADR-005).
- **Facts reach visitors only through the `visitor_facts` view** (approved, enabled, not conflicted). Corrections are proposals in the `corrections` queue and never edit facts directly (ADR-010).
- **Visitor scope and coaching scope are fixed by the entry point** (a channel adapter or the authenticated dashboard), never by message content, and are enforced by types and database grants (ADR-009).
- **The model never writes protected values.** Prices, stock, dates and policies come from fact slots that the renderer fills. A deterministic verifier checks each sentence before it is released, so nothing unverified is ever streamed (ADR-008).
- **The model interprets, code acts.** Triage returns a typed `TurnPlan` of one or more tasks; one dispatcher in `@kaki/agent` checks scope, the send gate, boundary rules and consent, then routes each task or model tool call to its owning module. A model tool call is a proposal, never a side effect. New features register a handler with the dispatcher rather than wiring their own path (ADR-025).
- **Channels** implement the `ChannelAdapter` contract; the core never branches on channel kind (ADR-011).
- **All side effects go through the transactional outbox → SQS.** Consumers are idempotent. Timers live in Postgres (ADR-012).
- **The AI send gate** (kill switch, channel live, no human owner) is checked before every turn and every AI send. Concurrency is enforced by the database (ADR-013).
- **The audit log is a per-tenant hash chain with no PII**; personal data goes to the deletable `audit_pii` store (ADR-014). NRIC, card and bank numbers are masked at the edge and never stored unmasked. PII lives only in contact-keyed tables (ADR-015).
- **Launch profile:** until the prod trigger (10 paying tenants), infrastructure runs as one lean environment: 2 AZs, one task per role, RDS PostgreSQL single AZ, NAT instance, no Bot Control, 15-minute canary. The ADR-003/ADR-004 design is the target restored at the trigger, so don't use Aurora-only features (ADR-023, ADR-024).
- **Widget budget:** loader ≤ 14 KB gz (initial load ≤ 30 KB, NFR-02), closed Shadow DOM, runtime theme detection, lazy chat panel (ADR-016).

## How features are built (from the implementation plan §3)

- **Start here in a build session:** `docs/build/STATE.md` (order, rules, kickoff prompts), then the `feature-stage` skill (`.claude/skills/feature-stage/SKILL.md`). Design, build and verify each run in their own fresh session and hand off through files; `docs/build/code-map.md` says where code lives.

- Build **one feature at a time in the plan's build order** (§5). Feature IDs (`FEAT-NNN`) are permanent; the next free ID is in plan §4.
- Each feature runs the same loop, with its documents in `docs/features/FEAT-NNN-<slug>/`: detailed design (`technical-design.md`, `tasks.md`) → UI design (`ui-design.md`, manifest) → implementation (one commit per task, tests per task) → **independent acceptance verification in a fresh session** (`acceptance-report.md`) → its own PR on branch `feat/FEAT-NNN-<slug>`.
- Never weaken, skip or delete a test to get green. A failing acceptance check goes back to implementation, or to the design if the design is wrong.
- Each milestone ends with `pipeline-verify` and a live demo signed off by the owner.

## UI and design rules

- **Before building any UI, read `docs/02-design/design.md`.** It and `tokens.json` are the only source of design values. Never hard-code colours, spacing or radii. The CSS block in design.md §2.5 and `anchors/tokens.css` are generated from tokens.json: edit tokens.json, then run `python3 docs/02-design/tools/gen_tokens_css.py`, which rewrites both and fails if any colour pair drops below WCAG AA. The app CSS comes from the same file through `@kaki/design-tokens` (`pnpm tokens`, also run by every build), which applies the same contrast check; its test fails if its output drifts from `anchors/tokens.css`. Front ends use only `var(--…)` token variables.
- **Screen IDs** (`SCR-APP-`, `SCR-WGT-`, `SCR-OPS-`) are permanent, like requirement IDs. The inventory is in `ux-foundations.md`; next free IDs are listed in its §1.
- `docs/design-manifest.json` is the screen registry, written only by the ui-design step.
- The widget uses only `--kaki-*` variables inside its closed Shadow DOM (ADR-016, design.md §4.9).

Inference cost and latency figures are estimates from 2026-10-19 (ADR-007, `architecture.md` §8.5 and §11). Check model availability and prices against live docs before relying on them.
