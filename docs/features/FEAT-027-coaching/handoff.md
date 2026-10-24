# Handoff: FEAT-027 — Coaching mode
Branch: feat/FEAT-027-coaching · PR: none yet (the last build session opens the draft PR) · Updated: 2026-10-24 by build
Stage done: build (T1–T6 of 12)
Next: build — kickoff: "Build FEAT-027 on branch feat/FEAT-027-coaching. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Resume at T7 (API). The domain is done and tested: `@kaki/agent` exports `runCoachingTurn`, `reanswer`, `applyHoursWith`, `createSession`, `getSession`, `listSessions`, `sessionMessages`, `CoachingSessionNotFoundError`, `InvalidSessionCursorError`; `@kaki/kb` exports `confirmCorrection`, `dismissCorrection`, `getCorrection`, `correctionFactInput`, `CorrectionClosedError`, `CorrectionStaleError`, `CorrectionNotFoundError`, `InvalidCorrectionError`.
- Confirm route, in order: read the correction (404 via `CorrectionNotFoundError`), `prepareChunk(llm, tenantId, correctionFactInput(c))` outside the transaction when it isn't null, then `confirmCorrection(dashboardKb(...), id, { chunk, applyHours: applyHoursWith({ tenantId, userId }) })`, then `reanswer(deps, { tenantId, userId, correction })` for `before`/`after`.
- The agent returns DB rows; the API maps them to the §3 contracts. Stored fact values are internal (`priceCents`), and validity is ISO instants: map `FactValueView` with the facts route's helpers (`apps/api/src/facts.ts`: `fromCents`, `sgDateOf`). `explainer` is stored in contract shape already.
- `runCoachingTurn` masks the text (`piiMask`) itself; the API should still pass the trimmed body. Its deps: `{ zdb: dashboard zone, llm }`; `channelLive` defaults to live (no channel-live state until FEAT-034).
- Contracts are in `packages/contracts` under "Dashboard API: coaching"; capability `coach.use` (owner, admin).
- Fakes: `fakeAgentScript` routes `COACH_TRIAGE_SYSTEM` and `PROPOSE_SYSTEM`; "went up to $58", "open 9am to 5pm on weekends", "Q: … A: …" and "should be …" are understood. Use them for T7/T8/T11.
- Deviations recorded in tasks.md notes (T3, T5): hours validated by tenancy in the agent, `contentChanged` compares with sorted keys, 0027 grants the dashboard `visitor_tenant_state()` and `UPDATE (coaching_message_id)` on corrections, `out_of_scope` test updated for ADR-026.

## Left to CI or later
- T11's E2E spec and the screen renders run only in CI's E2E job (STATE.md).
- The coaching eval set on the real model (pending-actions.md, M1.5-style).

## Pending for Ken
- None.
