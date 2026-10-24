# Handoff: FEAT-027 — Coaching mode
Branch: feat/FEAT-027-coaching · PR: none (build opens the draft PR) · Updated: 2026-10-24 by design
Stage done: design
Next: build — kickoff: "Build FEAT-027 on branch feat/FEAT-027-coaching. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Wait for Ken's sign-off on ADR-026 (`docs/02-design/adr/ADR-026-coaching-task-kind-and-runtime.md`, Proposed) before T2. D10 is decided: hours corrections are proposals (T6 stays).
- Coaching runs in the api role, synchronously (D1): `runCoachingTurn` in `@kaki/agent`, called from `apps/api/src/coach.ts`. No SQS, no realtime.
- Reuse, don't copy: `answerTurn`/`composeReply` for the answer, `dispatchToolCall` for `propose_correction` (first real use), `updateFact`/`createFact` for a confirm, `prepareChunk` before the transaction.
- `correct` is added to the shared `TaskKind`; the visitor triage prompt must not list it. `outOfScopeHandler` gets `scopes: ['visitor', 'coaching']`.
- `corrections` is created here with ADR-010's full column set; FEAT-018 adds the queue screen, other producers and replay. Only `coaching` rows are written now.
- Tenant state for coaching: whatever `runVisitorTurn` gets from `aiAllowed(...).tenant` (name, GST, route policy, persona, hours), read on the dashboard zone; check whether `visitorTenantState` works under `app_dashboard` or add a dashboard reader in tenancy.
- Owner text goes through `piiMask` before storage and model calls (D9).

## Left to CI or later
- T11's E2E spec and the screen renders run only in CI's E2E job (STATE.md).
- The coaching eval set on the real model (pending-actions.md, M1.5-style).

## Pending for Ken
- ADR-026 sign-off (also in /mnt/project-files/pending-actions.md).
