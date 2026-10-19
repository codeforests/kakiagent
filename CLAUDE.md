# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

KakiAgent (a placeholder name, set in config per D4) is a multi-tenant SaaS for Singapore SMEs. It builds a knowledge base from an SME's website, files and chat exports, and runs an AI customer agent on a web widget, email, Telegram and Meta channels, with human takeover, approvals, PDPA tooling and IMDA-aligned governance.

**There is no application code yet.** The repo holds the signed-off SDLC documents only, so there are no build, lint or test commands. Add the real commands to this file when the project is scaffolded.

## How work is run: phase by phase, with sign-off gates

The product owner signs off each phase before the next one starts. Don't jump ahead, for example to writing code before the plan and per-feature designs exist. At each gate, ask the owner the open questions and get explicit sign-off. Deliver each phase as a branch and a PR for review.

| Phase | Location | State |
|---|---|---|
| Requirements | `docs/01-requirements/` (`SRS.md`, `use-cases.md`, `rtm.md`) | Signed off 2026-10-19 (SRS v0.4, decisions D1–D11) |
| Architecture | `docs/02-design/architecture.md`, `docs/02-design/adr/ADR-001..022` | Signed off and merged 2026-10-19 |
| Next | UX foundations, then implementation planning | Not started |

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
- **Channels** implement the `ChannelAdapter` contract; the core never branches on channel kind (ADR-011).
- **All side effects go through the transactional outbox → SQS.** Consumers are idempotent. Timers live in Postgres (ADR-012).
- **The AI send gate** (kill switch, channel live, no human owner) is checked before every turn and every AI send. Concurrency is enforced by the database (ADR-013).
- **The audit log is a per-tenant hash chain with no PII**; personal data goes to the deletable `audit_pii` store (ADR-014). NRIC, card and bank numbers are masked at the edge and never stored unmasked. PII lives only in contact-keyed tables (ADR-015).
- **Widget budget:** loader ≤ 14 KB gz (initial load ≤ 30 KB, NFR-02), closed Shadow DOM, runtime theme detection, lazy chat panel (ADR-016).

Inference cost and latency figures are estimates from 2026-10-19 (ADR-007, `architecture.md` §8.5 and §11). Check model availability and prices against live docs before relying on them.
