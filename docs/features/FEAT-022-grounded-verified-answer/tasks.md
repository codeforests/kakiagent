# Tasks: FEAT-022 — Grounded, verified answer from a hand-entered fact

> Executes: [technical-design.md](technical-design.md) and [ui-design.md](ui-design.md)
> Status: pending | in-progress | done per task · Last updated: 2026-10-19

- [x] T1 — Migration: `tenants.ai_paused`, `business_profiles`, `facts`, `fact_versions`, `kb_chunks`, `messages.fact_ids`, `messages.disclosure` (0002, drizzle-kit), and RLS, roles, grants, `visitor_facts`, `visitor_chunks`, `visitor_tenant_state()` (0003, hand-written); `TENANT_SCOPED_TABLES`; seed the GST flags (design §4)
      Done when: `pnpm db:setup` applies cleanly on a fresh database and the existing RLS suite passes with the new tables listed.
- [x] T2 — RLS and grant tests for the new tables and views (design §4; AC-6; AGT-16, GOV-03)
      Done when: `rls.int.test.ts` covers cross-tenant reads/writes on each new table, permission denied for the visitor role on the base tables, and every excluded status in `visitor_facts`/`visitor_chunks`; it passes.
- [x] T3 — `llm-gateway`: `stream`, `embed`, the `embed` logical model, scripted streaming and the deterministic embedder in the fake provider, streaming in `anthropic-dev` (design §3.5)
      Done when: unit tests for stream chunking, scripted multi-attempt outputs, embedding determinism and similarity ordering pass.
- [x] T4 — `agent` domain: slots, renderer (S$, GST), segmenter, verifier (design §5; AGT-02, KB-15, NFR-10)
      Done when: unit tests for AC-1 (render), AC-3 (verifier), AC-10 (GST and formatting) and the segmenter's slot and decimal rules pass.
- [x] T5 — `agent` domain: prompt and `composeReply` with regeneration, escalation, gate re-check and fallback (design §5; D2; AC-2, AC-5, AC-13, AC-14 mid-stream)
      Done when: unit tests with scripted fake outputs for pass, regenerate-then-pass, fail twice, provider error and gate closing between segments pass, and no failing segment reaches `publish`.
- [x] T6 — `kb` module: fact repository (create, update, list, get) with versions, chunks, audit and optimistic concurrency; visitor search; scope-typed contexts; capability `kb.manage` (design §3.2, §5; KB-07)
      Done when: integration tests for create/update/version conflict/invalid state/status transitions and visitor search exclusions pass.
- [x] T7 — `agent.runVisitorTurn`: replace the echo with gate → lookup → compose → store (fact IDs, disclosure, audit) (design §5; AC-4, AC-7, AC-8, AC-9, AC-13, AC-14)
      Done when: `turn.int.test.ts` covers a grounded answer with stored fact IDs and the `tool.lookup_kb` audit, the exclusion of a `needs_review` and another tenant's fact, the disclosure on the first message only, an edit used by the next turn, provider failure fallback, kill switch and human status; the FEAT-001 failure test is updated per D6; all pass.
- [x] T8 — Contracts and API: fact shapes, `Message.inReplyTo`/`disclosure`, `SegmentEvent`; the four `/api/v1/kb/facts` routes with 400/403/404/409/503 (design §3)
      Done when: API tests (Fastify inject against the test database) for success and every designed error in AC-11 pass.
- [x] T9 — Wire workers: agent-worker publishes `segment` events and logs timings; realtime forwards `event: segment` without an ID; api gets an embedder from config (design §3.4, §5; AC-12)
      Done when: a realtime unit/integration check shows `segment` frames without `id:` and `message` frames with it, and the roles start with `pnpm dev`.
- [x] T10 — Dev data: `kb` seed script for the demonstration facts, run by `pnpm db:setup` (design §5)
      Done when: `pnpm db:setup` twice in a row is idempotent and leaves one `needs_review` bakery fact and one approved second-tenant fact.
- [x] T11 — Widget integration: segments per turn, typing indicator, disclosure row, replace on stored message, error notice (ui-design SCR-WGT-002)
      Done when: widget unit tests for segment merging pass, the panel renders the states in ui-design.md, and `pnpm size` stays within budget.
- [x] T12 — Dashboard integration: Knowledge → Facts list and the Fact create/edit page, consuming §3.2 (ui-design SCR-APP-027, SCR-APP-028)
      Done when: the pages render every state in ui-design.md against the running API, with typecheck and lint clean.
- [x] T13 — Evals: fixture tenants, recorded and adversarial cases (≥ 20 fast `prices`/`groundedness`), runner on `composeReply`, `prices-from-facts` and `cites` scorers (design §5; AC-1, AC-4, AC-15)
      Done when: `pnpm eval --fast` passes the thresholds, and a planted invented price in a case's expected output makes it fail.
- [ ] T14 — E2E: extend the suite for UC-20/UC-13 (J2): add the facts in the dashboard, ask in the widget, see the disclosure and S$55.00, never S$70/S$99 (AC-16)
      Done when: the new E2E spec and the skeleton spec pass against the local stack in Chromium.
- [ ] T15 — Verify: every AC in design §6 demonstrably passes; format, lint, boundaries, typecheck, unit, integration, coverage thresholds, build, size and eval are green; latency figures recorded for the PR (AC-12)
      Done when: all of the above run clean, with output captured for the acceptance report.
