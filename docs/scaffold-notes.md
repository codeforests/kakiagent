# Scaffold notes: FEAT-001 walking skeleton

> Status: scaffolded 2026-10-19 on branch `claude/project-thread-2e5bj5`. The local half of the done-when (plan §2) is demonstrated; the deployed half is pending milestone MD.
> Inputs: [implementation-plan.md](03-planning/implementation-plan.md) §2 and §7 · [architecture.md](02-design/architecture.md) and ADR-001..022 · [ux-foundations.md](02-design/ux-foundations.md), [design.md](02-design/design.md), [tokens.json](02-design/tokens.json)

This is the project's record of how the skeleton was built: generators and versions, deviations, what is stubbed, and what is still pending. Commands and conventions for day-to-day work are in [AGENTS.md](../AGENTS.md).

## 1. Done-when (plan §2)

| # | Condition | State | Evidence |
|---|---|---|---|
| 1 | `pnpm dev` starts every role; `skeleton.e2e.ts` sends a widget message and sees the reply in the widget (SSE) and in the dashboard (WebSocket) | **Passed locally** (Chromium) | `e2e/tests/skeleton.e2e.ts`: the reply `Echo: …` appears in the widget, and the inbox row updates on the already-open dashboard page with no reload. The message crosses api → outbox → scheduler-worker → SQS (LocalStack) → agent-worker → Valkey → realtime. Firefox and WebKit run in CI only, because only Chromium is installed in the scaffolding environment. |
| 2 | Cross-tenant RLS test passes, including hand-written queries | **Passed** | `packages/db/test/rls.int.test.ts`, 11 tests on Testcontainers Postgres 16 + pgvector |
| 3 | CI green on the PR; widget loader within budget | Budget **passed**; CI **pending the first push** | `pnpm size`: loader 1.75 KB gz (limit 14), panel 8.43 KB gz (35), initial load 1.75 KB gz (30) |
| 4 | The same E2E passes against the deployed dev environment | **Pending MD** | Terraform for dev is written and validated, never applied |

Also verified by running: typecheck, lint and boundaries clean; 17 unit tests, 24 integration tests, 5 design-token tests and 3 E2E tests pass; coverage thresholds met; the API image builds and runs as `node` with the dev sign-in returning 404; `terraform validate`, `tflint` (with the AWS ruleset) and `actionlint` are clean; `pnpm audit --prod` reports no known vulnerabilities.

Each enforcement was shown to catch a planted violation, which was then removed:
- **Boundaries:** dependency-cruiser rejected all six of these: a deep import blocked by `exports`, a relative import of another module's internals, a provider SDK outside `llm-gateway`, a package importing an app, and two undeclared or unresolvable packages.
- **Tokens:** deleting the token CSS import made the shell lose its accent colour, and the token E2E failed.
- **tflint:** it flagged an untyped variable and an invalid node type.
- **actionlint:** it flagged an undefined expression property.

## 2. Units and where they come from

| Unit | Container (architecture §5.1) | Stack (ADR) | How it was created |
|---|---|---|---|
| `apps/api` | api | Fastify 5.12.7 + Zod 4.6.7 (ADR-002) | Manual: Fastify has no official project generator; followed Fastify's documented plugin and `buildApp` factory layout |
| `apps/realtime` | realtime | Fastify + `@fastify/websocket`, SSE (ADR-017) | Manual, same reason |
| `apps/agent-worker`, `ingest-worker`, `scheduler-worker` | workers | Node 22, SQS consumer / outbox dispatcher (ADR-012) | Manual: plain Node entry points, no framework |
| `apps/dashboard` | dashboard SPA | React 19.3.1 + Vite 8.3.4 (ADR-002) | `npx -y create-vite@9.3.0 dashboard --template react-ts --eslint --no-immediate --no-interactive` (run in `apps/`), then customised |
| `apps/operator` | operator console | React + Vite (ADR-002) | Same generator and flags, `operator` |
| `apps/widget` | widget | Preact 11.0.1 + esbuild 0.28.2 (ADR-002, ADR-016) | Manual: ADR-016 fixes esbuild with a loader and a lazy chunk, which no Vite template produces; `build.mjs` follows esbuild's documented API |
| `packages/*` | domain modules (§5.2) and shared infrastructure | TypeScript 6.0.3, Drizzle 0.45.4 / drizzle-kit 0.31.11 | Manual workspace packages. Initial migration from `drizzle-kit generate`; RLS, roles and grants in a hand-written migration (`0001_rls_roles_grants.sql`) |
| `e2e`, `evals` | — | Playwright 1.64.1 + @axe-core/playwright 4.14.0; custom runner (ADR-022) | Manual |
| `infra/terraform` | deployment view (§7) | Terraform 1.16.6, AWS provider 6.69.1 (ADR-003) | Manual modules |

Monorepo tooling: pnpm 10.28.0 (`packageManager`), Turborepo 2.11.9, Node 22. Versions were the current npm releases on 2026-10-19 and are pinned exactly; Renovate (`renovate.json`) proposes updates.

**Removed generator boilerplate** (dashboard and operator): the Vite and React logos, `App.tsx`/`App.css` counter demo, `index.css`, the `assets/` folder and the default favicon. They conflicted with design.md (hard-coded colours and fonts) and with the shell. The generated `eslint.config.js`, `tsconfig.*.json` and `vite.config.ts` were kept and extended.

## 3. Deviations and decisions

| Decision | Why |
|---|---|
| **TypeScript 6.0.3**, not 7 | create-vite and npm `latest` give TypeScript 7, but typescript-eslint 8.71.2 supports `<6.1`. Renovate is limited to `<6.1` until typescript-eslint catches up. |
| **react-router 7** for dashboard routing | ADR-002 leaves routing to the team ("owns its own UI routing and data fetching (TanStack Query)"). React Router is the most widely used option, and its data-router `lazy` routes let the dev sign-in be left out of production builds. |
| **Zod schemas parsed by hand** in route handlers, with no Fastify type provider; **OpenAPI generation deferred** | ADR-002 asks for OpenAPI generated from Zod. With five endpoints a generator adds a dependency and no reader yet. Contracts already live in `packages/contracts` as the single source, so FEAT-005 (or the first feature with an external API consumer) can add `fastify-type-provider-zod` and OpenAPI from the same schemas. |
| **Widget build target** `es2022, safari16, chrome109, firefox115, edge109` | NFR-14 (the latest two desktop versions, Safari on iOS 16+, Chrome on Android 10+). esbuild 0.28 cannot lower destructuring to Safari 13, and nothing requires Safari 13. |
| **Outbox IDs generated in the app** (`randomUUID`), not `RETURNING` | Writer roles have INSERT but no SELECT on `outbox`. RETURNING needs SELECT, and granting it would let every writer zone read all pending side effects of its tenant. |
| **Correlated subqueries written with explicit table names** in `listConversations` | Drizzle renders an interpolated column inside `sql\`\`` without its table, which silently correlated the subquery with itself. The integration test caught it. Watch for this in every raw `sql` subquery. |
| **Dev sign-in compiled out in both halves** | The API guards it with `process.env.KAKI_BUILD` (defined as `"production"` by `scripts/bundle-node.mjs`), and the dashboard uses `import.meta.env.DEV`. CI greps both production bundles. The signed session reader (`identity/dev-session.ts`) does stay in the API bundle, because `/api/v1/me` uses it until FEAT-005. |
| **E2E forces shadow roots open** in an init script | Playwright cannot reach into a closed shadow root. Production stays closed (ADR-016); only the test page is patched. |
| **Node images use a hoisted `pnpm deploy`** | The bundle keeps npm packages external, so OpenTelemetry instrumentation can patch them. A hoisted production install lets `dist/main.js` resolve the dependencies of the bundled `@kaki/*` packages. The image is about 450 MB; slimming it (a distroless base, pruning the AWS SDK) is left for MD. |
| **CI pins every action by commit SHA**, Renovate keeps them current | This is supply-chain hygiene (NFR-15), especially for scanning actions. |
| **Eval job runs on every PR** | Plan §3 requires the fast subset only when `agent`, `kb`, prompts or model config change. On the fake provider it takes seconds, so path filtering is deferred until the set runs on a real model (M1.5). |
| **Queue named `conversation-turns.fifo`** (plan §2 says `turns.fifo`) | The name matches the outbox topic enum, so each queue maps one-to-one to a topic. |
| **Health endpoints are `/healthz` and `/readyz`** (plan §2 says `/health`) | Liveness and readiness are separate: ECS uses `/healthz` and the ALB target groups use `/readyz`. |
| Dev Terraform trims cost: 1 NAT, 1 Aurora instance (0.5–4 ACU), no Valkey replica, 1–2 tasks per role | Staging and prod use the same modules with the module defaults, which are the architecture §7 minimums. |

## 4. What is stubbed, and which feature replaces it

| Stub | Where | Replaced by |
|---|---|---|
| Fake LLM provider that echoes `Echo: <text>`; the `anthropic-dev` provider sits behind `LLM_PROVIDER` | `packages/llm-gateway` | FEAT-022 (the real turn), FEAT-004 (routing, cost governor), MD (Bedrock `au.`) |
| `runVisitorTurn` echoes, with no retrieval, slots or verifier | `packages/agent` | FEAT-022 |
| Dev-only sign-in as a seeded owner | `apps/api/src/dev-auth.ts`, `apps/dashboard/src/pages/dev-sign-in.tsx` | FEAT-005 |
| `audit.append` writes plain IDs-only rows, with no hash chain | `packages/governance` | FEAT-002 |
| `piiMask` is a pass-through | `packages/platform/src/pii-mask.ts` | FEAT-003 |
| `can(role, capability)` with a minimal capability table | `packages/identity` | FEAT-005, FEAT-007 |
| Widget uses the default `--kaki-*` tokens (no theme detection) | `apps/widget` | FEAT-032 |
| `kb`, `leads`, `approvals`, `analytics` are empty modules | `packages/*` | FEAT-011, -049, -055, -004/-066 |
| `ingest-worker` is idle (health only) | `apps/ingest-worker` | FEAT-011 onwards |
| Eval case set is empty | `evals/cases` | FEAT-022, -023, -025, -051 |
| Dashboard sections other than Inbox are placeholders naming their feature; inbox is a bare live list | `apps/dashboard` | per plan §4 |
| Operator console is a static shell | `apps/operator` | FEAT-070 |

## 5. Pending first deployment (milestone MD)

- Account bootstrap: AWS Organizations, the SCP region lock, and the state bucket for `backend "s3"` (`envs/dev/dev.s3.tfbackend.example`).
- `terraform apply` of `infra/terraform/envs/dev`; setting the five Secrets Manager values (database URLs per trust zone, token secrets); running `pnpm db:setup`-equivalent migrations against Aurora with the owner secret.
- A CD workflow: OIDC role `kaki-dev-github-deploy` (module `ci-oidc`), image push by digest, an ECS rolling deploy, a static upload to the `static` bucket, and a CloudFront invalidation.
- `terraform providers lock -platform=linux_arm64 -platform=darwin_arm64` if other platforms run Terraform. The committed lock file was produced on linux_amd64.
- Then done-when 4: run `skeleton.e2e.ts` against the CloudFront URL.

## 6. Open issues for upstream documents

Recorded here rather than edited into signed-off documents (AGENTS.md, Document rules).

1. **architecture.md §7 / ADR-003, the WAF and certificate region.** A CloudFront-scoped WAF web ACL, and an ACM certificate for custom domains on CloudFront, can only be created in **us-east-1**. They hold rules and certificates, not tenant data, so NFR-07 holds. But the SCP region lock at account bootstrap must allow `wafv2` and `acm` in us-east-1, or the dev apply fails. The deployment diagram shows WAF inside the ap-southeast-1 box. *Suggested:* an ADR-003 note, or a superseding ADR, that names this exception next to the ADR-006 inference exception.
2. **ADR-002, OpenAPI from Zod.** This is deferred (§3). There is no conflict with the decision, but the first external API consumer should trigger it.
3. **Plan §2 naming:** `turns.fifo` and `/health` versus what was built (§3). These are cosmetic; the plan can adopt the built names at its next revision.

## 7. Notes for the environment that built this

The scaffolding ran in a sandbox with an HTTPS-intercepting proxy. To verify the Dockerfile there, a scratch copy added the proxy CA; the committed `Dockerfile` has no proxy-specific lines. Terraform providers came from releases.hashicorp.com through a local filesystem mirror, because registry.terraform.io was unreachable. CI uses the public registry normally.
