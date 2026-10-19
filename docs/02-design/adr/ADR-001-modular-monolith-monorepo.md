# ADR-001: Modular monolith in a TypeScript monorepo

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** NFR-12, NFR-03, NFR-04, CHN-01, constraint C1

**Context**
The MVP has eleven capability areas (ONB, AUTH, KB, AGT, CHN, INB, LED, APR, GOV, DSH plus the operator console) and a small team. C1 fixes TypeScript across the stack and NFR-12 requires a monorepo with CI. NFR-03 asks for horizontally scaling workers at modest MVP volumes (1,000 concurrent conversations, 1 million chunks). The load profiles differ: the conversation path is latency-bound (NFR-01), ingestion is bursty and CPU/browser-heavy (NFR-16), and the dashboard is ordinary CRUD. The tension is between independent scaling of these profiles and the operating cost of many services.

**Decision**
We will build one TypeScript codebase in a pnpm + Turborepo monorepo, organised as domain modules (`kb`, `agent`, `channels`, `inbox`, `leads`, `approvals`, `governance`, `identity`, `billing-stub`, `operator`) with enforced boundaries (each module exposes a public `index.ts`; cross-module imports of internals fail lint via dependency-cruiser). The same code is deployed as a small number of **runtime roles** built from the one codebase: `api` (HTTP + webhooks), `realtime` (SSE/WebSocket fan-out), `agent-worker` (conversation turns), `ingest-worker` (crawl, parse, extract, embed) and `scheduler-worker` (timers, purges). The widget and the dashboard are separate front-end apps in the same repo.

**Options considered**
- **Modular monolith, several runtime roles (chosen)** — one codebase, one database, one deploy pipeline; each role scales on its own queue or CPU metric. Con: a bad release can affect all roles at once, and module discipline must be enforced by tooling.
- **Microservices per domain** — independent deploys and stores. Lost: distributed transactions across KB/agent/audit (every agent turn writes conversation, audit and usage records together), more infrastructure to secure for Cyber Essentials (NFR-06), and no scaling need at MVP volumes that the role split does not already meet.
- **Single process for everything** — cheapest. Lost: a crawl spike (headless browser) would starve the latency-critical agent path (NFR-01).

**Consequences**
Shared types (the `ChannelAdapter` contract, domain events, DTOs) live in `packages/` and are type-checked end to end. A role can be extracted into its own service later because modules already talk through public interfaces and queues. We accept that all roles share one Postgres cluster and one release train; revisit if one domain's change rate or load diverges sharply, or the team grows past ~10 engineers.
