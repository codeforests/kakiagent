# ADR-027: Conversation replay runs in the api, one question per request

**Status:** Proposed (FEAT-028 design, 2026-10-24; accepted when Ken accepts FEAT-028 D1). Amends ADR-026 decision 2 (its replay clause) and lapses ADR-026's reservation of task kind `replay`. ADR-026's other decisions are unchanged.

**Requirements addressed:** AGT-17 (replay clause), UC-04 4b, KB-18 (replay after an accepted correction)

**Context**
ADR-026 decision 2 moved coaching turns into the `api` role and said the agent-worker keeps replay jobs. A replay re-answers up to 20 past visitor questions, each a full verified turn of a few seconds. The agent-worker only has the visitor trust zone and one SQS queue (`conversation-turns`); replay writes coaching tables, which only the dashboard zone may write (ADR-009). Running it there needs a dashboard-zone connection in the worker, a new queue and outbox topic, and Terraform and local-stack changes. The owner watches replay results on SCR-APP-031 as they arrive.

**Decision**
1. **Replay runs in the `api` role**, through `@kaki/agent`'s `replayQuestion`, one question per request (`POST /api/v1/coach/replays/:id/next`). The screen drives it while it is open; a replay resumes from its next pending question. Results are stored as `coaching_messages` of kind `replay` in a coaching session of origin `replay`.
2. **Replay dispatches with every visitor handler stubbed** (ADR-025 decision 7): the visitor registry's handlers run against ports that write nothing.
3. **No `replay` task kind** is added. Replay is started from the screen, not recognised in chat text.

**Consequences**
- No new queue, worker connection or infrastructure. Model spend is metered with `coaching_session_id`, outside per-conversation cost (NFR-13), as coaching is.
- A replay stops when its screen closes. FEAT-018's post-correction replay may run `replayQuestion` from a scheduler or worker job later; that would be a new ADR with the zone and queue it needs.
- Architecture §5.1's agent-worker row ("coaching; replay") is read with ADR-026 and this ADR.

**Alternatives considered**
- **Agent-worker job with polling** (ADR-026 as written): runs after the page closes, but adds a queue, a dashboard-zone connection in the visitor worker and infrastructure changes for one screen.
- **One synchronous request for the whole replay:** up to 20 turns would exceed any reasonable request timeout.
