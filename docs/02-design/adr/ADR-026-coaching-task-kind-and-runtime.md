# ADR-026: Coaching-scope task kinds and where coaching turns run

**Status:** Proposed (FEAT-027 design, 2026-10-24); needs the product owner's sign-off. Amends ADR-025 decision 1 (task table) and architecture §5.1 (agent-worker row). ADR-025's other decisions are unchanged.

**Requirements addressed:** AGT-17, ONB-05, AGT-16, UC-04

**Context**
ADR-025 decision 7 says coaching uses the same `TurnPlan` and dispatcher with its own registry, including `propose_correction`. But decision 1's task table is closed and has no kind for "the owner is correcting the assistant", and decision 3 refuses a tool call whose task the plan didn't enable. So a coaching correction has no legal path without a new kind. Separately, architecture §5.1 lists coaching under the agent-worker, which receives visitor turns through SQS and streams them through realtime. A coaching turn is a dashboard request-response with no visitor and no channel.

**Decision**
1. **Coaching-only task kinds** are added to the task table:

   | Kind | Scope | Handling | Owner |
   |---|---|---|---|
   | `correct` | coaching only | Model-assisted: a structured proposal step produces a `propose_correction` tool call, which the dispatcher validates; the handler writes an open correction (ADR-010) and never edits a fact | `kb` (FEAT-027) |
   | `replay` | coaching only | Reserved for FEAT-028 (`replay_conversation`, tools stubbed) | `agent` (FEAT-028) |

   The visitor triage prompt never lists these kinds, and the visitor registry has no handler for them, so a visitor plan carrying one dispatches nothing (`unhandled`) and the handler's scope check refuses it in visitor scope (`scope`). Coaching triage uses its own fixed prompt (its own cached prefix).
2. **Coaching turns run in the `api` role**, synchronously, through `@kaki/agent`'s `runCoachingTurn` and `llm-gateway`. They use the dashboard trust zone, write only coaching tables and corrections, and never enqueue channel sends. The agent-worker keeps visitor turns, suggested replies and (FEAT-018/028) replay jobs.

**Options considered**
- **Coaching kinds in the shared task table, api-hosted turn (chosen)** — one dispatcher and one plan schema, as decision 7 intended; no new queue or dashboard stream. Con: a long model call holds an api request (bounded by gateway timeouts).
- **A separate coaching plan schema** — keeps the visitor table untouched. Lost: two dispatchers' worth of checks, against decision 7.
- **Coaching as an agent-worker job with an SSE stream to the dashboard** — matches §5.1 as written. Lost: a new queue and a new dashboard realtime channel for one screen, and more latency for the owner.

**Consequences**
`TaskKind` gains `correct` (FEAT-027) and later `replay` (FEAT-028). The AGT-07 red-team suite keeps proving that visitor entry points can't reach either. The api role's model spend is metered to `usage_events` with `coaching_session_id`, outside per-conversation cost (NFR-13).
