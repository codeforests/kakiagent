# Handoff: FEAT-057 — Kill switch: pause and resume the AI on all channels
Branch: feat/FEAT-057-kill-switch · PR: none · Updated: 2026-10-28 by build (backend)
Stage done: build (T1–T4 of 9)
Next: build (UI, T5–T9) — kickoff: "Build FEAT-057 (UI) on branch feat/FEAT-057-kill-switch.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the UI session needs
- Routes (apps/api/src/ai.ts): `GET /api/v1/ai/status` (any member), `POST /api/v1/ai/pause`, `POST /api/v1/ai/resume` (Owner/Admin; no body; 403 `forbidden` for Agent). All answer `AiStatusResponse` `{ status: { paused, pausedAt, liveChannels, fallback: { en, zh } } }`; a repeat is 200 with the same status.
- Contracts (`@kaki/contracts`): `AiStatus`, `AiStatusResponse`, `AiStatusEvent` (`{ type: 'ai_status', paused }`, now in `RealtimeEvent`), `WidgetConfigResponse.aiPaused` (`{ message: { en, zh }, contact: { email, phone } } | null`).
- The dashboard WebSocket (realtime role) forwards `ai_status` on the inbox channel as is; the visitor SSE drops it. `lib/realtime.ts` should invalidate `['ai-status']` on it.
- `aiPaused` is a required (nullable) field: any widget fixture or stub config needs `aiPaused: null` (done in `preview.ts`, contracts and api contract tests). The E2E stubbed config needs it too.
- The paused turn now stores the fallback once per run of visitor messages (T3); the E2E "visitor sees the fallback" step should send one message and expect one fallback.

## Deviations
- The new check `tenants_ai_paused_at_ck` requires `ai_paused_at` when paused, so agent test fixtures that flip `ai_paused` by hand now also set/clear `ai_paused_at` (setup only; no assertion changed). 0035 backfills `ai_paused_at` for a tenant already paused.
- T4's "a staff reply is stored" while paused is not tested: no staff-reply route exists yet (inbox replies come with a later feature). `ai.int.test.ts` covers start + visitor message while paused. Verify should note AC-5's staff half as pending that feature.

## Left to CI or later
- E2E (T8), dashboard renders and `pnpm size` run in the verify stage's GitHub CI.
- `governance` anchors and `api` uploads S3 suites fail locally only (no S3/Docker in cloud sessions); not touched here.

## Pending for Ken
- None.
