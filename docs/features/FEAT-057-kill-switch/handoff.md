# Handoff: FEAT-057 — Kill switch: pause and resume the AI on all channels
Branch: feat/FEAT-057-kill-switch · PR: none · Updated: 2026-10-28 by design
Stage done: design
Next: build (backend, T1–T4) — kickoff: "Build FEAT-057 (backend) on branch feat/FEAT-057-kill-switch.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- The gate already honours `tenants.ai_paused` before every turn and segment (`gate.ts`, `turn.ts`); don't touch `aiAllowed`. No Valkey cache (D1): Valkey only carries the `ai_status` dashboard nudge.
- `killswitch.toggle` already exists for Owner/Admin in `packages/identity/src/capabilities.ts`.
- `rls.int.test.ts` lists `update tenants set ai_paused = true` as refused for `app_dashboard`; T1 replaces that line with the positive own-tenant + cross-tenant case (D5, a designed change, not a weakened test). Keep the other refused statements.
- Fallback text resolution: `textsFor(lang, persona).fallback` from `@kaki/agent` with the persona from `getAssistantSettings` (dashboard zone) or `visitorTenantState(tx).persona` (widget config).
- `setAiPaused` uses one conditional update (`where ai_paused = not $paused`) so repeats and races are no-ops with no audit (D3). Copy the audit call shape from `setChannelState` in `packages/channels/src/connections.ts`.
- T3 changes the paused branch to "once" (D2): check existing paused cases in `turn.int.test.ts` and `language-hours.int.test.ts` each use a fresh conversation (they do at the anchors read in design).
- API publishes through the existing `notify()` in `app.ts`; pass it into `registerAiRoutes`.
- Backend session stops at `## Build session 2 (UI)` in tasks.md; UI kickoff is the same with "(UI)".

## Left to CI or later
- E2E (T8), dashboard renders and the widget size check run in the verify stage's GitHub CI (no Docker/stack in cloud sessions).

## Pending for Ken
- None. GOV-08 stays partial on lead capture until FEAT-049 (D6), noted for the acceptance report.
