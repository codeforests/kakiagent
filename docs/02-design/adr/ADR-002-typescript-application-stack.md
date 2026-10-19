# ADR-002: TypeScript application stack

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** C1, NFR-12, NFR-01, NFR-02, NFR-09, NFR-14, NFR-19, INB-06, CHN-02

**Context**
C1 mandates TypeScript end to end. The system has three very different front-end surfaces: a third-party-embedded widget with a hard 30 KB gzipped budget (NFR-02, CHN-02), an authenticated dashboard and inbox that must work as a mobile PWA (INB-06) at p95 ≤ 1.5 s (NFR-01), and an operator console. The back end serves REST for the dashboard, inbound webhooks for channels, and long-lived streams for replies. Everything must be testable in CI (NFR-12).

**Decision**
- **Runtime:** Node.js LTS (the current Active LTS line at scaffolding time) on Linux containers.
- **API and workers:** Fastify with Zod schemas as the single source of request/response types, OpenAPI generated from them. Domain logic in framework-free modules (ADR-001).
- **Data access:** Drizzle ORM with SQL migrations checked into the repo; raw SQL is allowed for RLS policies, pgvector queries and search (ADR-004, ADR-005).
- **Dashboard and operator console:** React + Vite single-page app, installable PWA, served as static assets from CloudFront. Accessible component primitives (Radix-based) to reach WCAG 2.1 AA (NFR-09).
- **Widget:** Preact (no React runtime) compiled with esbuild to a loader plus lazy chunks (ADR-016).
- **Tests:** Vitest for unit and integration (with Testcontainers Postgres for RLS tests), Playwright for E2E and widget/host-page tests, axe-core for accessibility, a custom TypeScript AI-evaluation runner (ADR-022).
- **Repo tooling:** pnpm workspaces, Turborepo, ESLint + dependency-cruiser (module boundaries), Prettier, `tsc --noEmit` typecheck.

**Options considered**
- **Fastify + React SPA + Preact widget (chosen)** — light, fast cold paths, no server-rendering infrastructure; the dashboard is behind sign-in so SEO is irrelevant. Con: no built-in server rendering for the first dashboard paint, mitigated by CDN-cached static assets and route-level code splitting.
- **Next.js full stack** — one framework for UI and API. Lost: the API must also host webhooks and long-lived SSE/WebSocket streams on containers, which fits Fastify better; server components add complexity with no benefit behind a login.
- **NestJS** — strong structure. Lost: heavier abstraction than the module boundaries in ADR-001 need.

**Consequences**
Types flow from Zod schemas to the dashboard client, the widget protocol and the channel adapters. Tooling is mainstream and easy to hire for. The team owns its own UI routing and data fetching (TanStack Query). Revisit if a public marketing site with SEO needs is added to the same app.
