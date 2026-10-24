# Handoff: FEAT-027 — Coaching mode
Branch: feat/FEAT-027-coaching · PR: https://github.com/codeforests/kakiagent/pull/25 (draft) · Updated: 2026-10-24 by build
Stage done: build (T1–T12 of 12), developer-done
Next: verify — kickoff: "Verify FEAT-027 on branch feat/FEAT-027-coaching. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Evidence per AC is in `tasks.md` (Verification evidence); deviations are in each task's Note.
- **Run CI before merging:** the dashboard gained Vitest, so `pnpm-lock.yaml` changed (STATE.md cadence). The E2E spec `e2e/tests/coach.e2e.ts` and the screen renders have only run in CI's E2E job, never locally.
- API: `apps/api/src/coach.ts`, wired in `app.ts`; schema failures on coaching routes are 422 `invalid_body` (other routes keep 400). The api's fake gateway now uses `fakeAgentScript` (main and test support) since turns run in the api (D1).
- Evals: `evals/coaching/cases.json` (22 cases, 4 `realOnly`), new `coaching` threshold 0.9 in `thresholds.json`.
- Dashboard: `pages/coach.tsx` (CoachPage, SetupTestPage), `pages/coach-chat.tsx`, `pages/quick-coach-panel.tsx`, `lib/coach.ts`; `SlideOver` added to `@kaki/ui`. The review step's Continue now goes to `/setup/test`.
- Lint fix: `fakeAgentScript` moved to `packages/agent/src/fake-coach.ts` to break a cycle; still exported from `@kaki/agent`.
- The chats list has no creator name (`CoachSession` has no creator field).

## Left to CI or later
- E2E (`coach.e2e.ts`) and axe on SCR-APP-030/010: pending CI.
- api `uploads.int.test.ts` S3 presigner case needs Docker (unchanged by this feature).
- The coaching eval set on the real model (pending-actions.md).

## Pending for Ken
- None new.
