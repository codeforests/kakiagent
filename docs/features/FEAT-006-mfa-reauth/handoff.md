# Handoff: FEAT-006 — Two-step verification and re-authentication
Branch: feat/FEAT-006-mfa-reauth · PR: none · Updated: 2026-10-28 by design
Stage done: design
Next: build (backend) — kickoff: "Build FEAT-006 (backend) on branch feat/FEAT-006-mfa-reauth. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Backend is T1–T5; the UI session starts at `## Build session 2 (UI)` (T6–T11).
- The two-step state is computed in `authenticate` per request (D2), not stored; `sessionFrom` then refuses pending sessions, so no existing route changes. Watch FEAT-005's api and realtime suites: they must pass unchanged.
- The sealer moves from `packages/channels/src/secrets.ts` to `@kaki/platform/secrets`; channels re-exports it (D3). Add the export to platform's `package.json` `exports` and dependency-cruiser stays happy.
- Re-auth link = a `magic_links` row with `purpose = 'reauth'` and `session_id`; claim it only when the verifying request's cookie session matches, and leave it unclaimed otherwise (`link_other_session`).
- Lockout counts on the factor (per user), recovery attempts on the rate limiter; both keys in design §5.2.
- Audit user-level MFA events into every active-membership tenant (§5.5), payload `{}`.
- `uqr` 0.1.3 (pinned exact) is a dashboard dependency for the UI session only.
- New env: `MFA_SECRET_KEY` (32 bytes base64url), `APP_NAME` (default `KakiAgent`) in api config, `.env.example`, `gen-local-env.mjs`, terraform `envs/prod`.

## Left to CI or later
- E2E (`two-step.e2e.ts`), renders and axe: verify stage's GitHub CI (no local stack).
- Google re-prompt for re-auth deferred (D4); live Google check pending since FEAT-005.

## Pending for Ken
- Nothing blocking. Noted in pending-actions: lost authenticator + all recovery codes has no self-service reset until an operator tool exists (design §8 item 2).
