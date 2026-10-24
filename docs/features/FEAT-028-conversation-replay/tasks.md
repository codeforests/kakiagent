# Tasks: FEAT-028 — Replay a past conversation against the current KB

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: developer-done · Last updated: 2026-10-24

- [x] T1 — Schema: `0028_replay.sql` and Drizzle: `coaching_sessions` origin `replay`, `replay_conversation_id` (FK to conversations, on delete cascade), `include_unreviewed`, checks and index; `coaching_messages` kind `replay`, `replay_of`, unique key, FK to sessions on delete cascade; RLS suite: tenant-B case for a replay session, still no visitor-role grant (design §4; AC-8 schema half)
      Done when: `pnpm db:setup` applies 0028 on a database at 0027; `drizzle-kit generate` reports no drift; the RLS suite passes; deleting a conversation removes its replay sessions and messages (db integration test).
- [x] T2 — Contracts: the §3 replay section (`ReplayCandidate`, `Replay`, `ReplayTurn`, `OriginalReply`, `ReplayEffect`), `CoachSession.origin` `replay`, `CoachMessage.kind` `replay`, `Explainer` outcome `ended` and reasons `crisis`, `abuse_warning`, `abuse_ended` (design §3)
      Done when: workspace typecheck passes; contracts unit tests parse a sample `Replay` and reject a turn with `status: 'done'` and no `replayed`.
- [x] T3 — Agent, stubbed dispatch: `stubAll`, `replayRegistry`, `ReplayPorts` (in-memory flag/endAi, `recordAbuse` from earlier turns' effects, collected audit); `explain()` handles `ended` and the safety reasons; `answerStep` takes a dispatch result instead of running `coachingRegistry` itself, coaching behaviour unchanged (design §5.1; AC-5)
      Done when: agent unit tests pass: crisis, abuse (warn then end) and out-of-scope plans give the visitor's texts and effects with no port writes; `propose_correction` is refused in a replay context; FEAT-027's coach tests still pass.
- [x] T4 — Agent, replay core: `coach-store` replay functions, `replayCandidates`, `startReplay`, `getReplay` (original replies grouped per question, `factsChanged`, first 20 and `totalQuestions`), `replayQuestion`, `replayNext`, errors; audit entries (design §5.1, §5.2; D3–D8; AC-2–AC-4, AC-6–AC-9)
      Done when: agent integration tests on the fake provider pass: a replayed answer equals `runVisitorTurn`'s for the same KB and history; a changed fact gives the new value; `includeUnreviewed` respected; no `conversations`/`messages`/`outbox` writes and usage rows carry `coaching_session_id`; concurrent `replayNext` stores one row; 34 questions → 20 turns, total 34; audit payloads codes and IDs only; no visitor text in `coaching_*`.
- [x] T5 — API: the four routes in `apps/api/src/coach.ts`, rate limit `replay:{userId}` 30/min, error mapping; the sessions list excludes replay sessions (design §3, §5.3; AC-1, AC-7, AC-8, AC-11)
      Done when: api integration tests pass for every designed success and error, including tenant B's 404s and empty candidates, staff 403, 409 `replay_complete`, 404 `conversation_gone`, the 429, and one `…/next` under 8 s on the fake provider.
## Build session 2 (UI)

- [x] T6 — Dashboard: `lib/replay.ts` (client, helpers), `pages/replay.tsx` (picker with dialog; comparison with progress, pause/continue, `answer-compare` rows, effects, "Teach a fix" → quick panel), routes, the Coach page-head link (ui-design SCR-APP-031)
      Done when: dashboard typecheck and unit tests pass (`lib/replay.test.ts`: progress text, "first 20 of N", effect sentences, the drive loop stops on error and on pause).
      Note: no local stack in cloud sessions; renders are checked by T7's E2E in CI.
      Done 2026-10-24: dashboard typecheck green, `lib/replay.test.ts` 12 cases green. The quick panel is generalised as `CoachPanelButton` ("Ask Coach" wraps it). Deviation: the Coach page head keeps the "Replay a conversation" link at every width (the header wraps) instead of a below-768 overflow menu, which no component provides yet.
- [x] T7 — E2E: `e2e/tests/replay.e2e.ts`: a widget conversation asks a price → the owner changes the fact → replays the conversation → the "now" column shows the new price with "Uses different facts", the original column the old; axe on picking and comparison (design §6; AC-3, AC-10)
      Done when: the spec passes in CI's E2E job.
      Note: E2E runs only in CI (STATE.md); written and typechecked here, pending CI.
      Done 2026-10-24: written, typechecked and linted; pending CI. The spec replaces the fact (deletes it, adds one at the new price) rather than editing it, because `factsChanged` compares fact IDs and an in-place edit keeps the ID (see handoff).
- [x] T8 — Verify: every AC in design §6 demonstrated; `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, this feature's package unit and integration tests green
      Done when: the evidence below is filled in, one bullet per AC.

## Verification evidence

Build sessions, 2026-10-24. Final run (UI session): `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser), `pnpm typecheck` (26 tasks) green; dashboard unit 20/20 (`lib/replay.test.ts` 12); agent unit 317/317; agent integration 71/71 (replay.int 12); api `replay.int` all green. The only red was `uploads.int` (S3 presigner), which needs a container runtime this session lacks; FEAT-028 doesn't touch it.

- **AC-1** api `replay.int`: staff 403 on all four routes, 401 without a session, tenant B 404 on A's conversation and replay, B's candidates empty.
- **AC-2** api and agent `replay.int`: candidates only with a visitor message, newest first, first question and count; `POST /replays` all pending with the original replies grouped.
- **AC-3** agent `replay.int` "renders a changed fact's new value" and the unreviewed case; E2E `replay.e2e.ts` (new price in "now", old in "original", "Uses different facts"): pending CI.
- **AC-4** agent `replay.int`: replayed answer equals `runVisitorTurn`'s (text, outcome, fact IDs).
- **AC-5** agent unit (replay-dispatch) and `replay.int`: crisis and abuse texts and effects, conversation row unchanged.
- **AC-6** agent `replay.int`: no `conversations`/`messages`/`outbox` writes; usage rows carry `coaching_session_id`.
- **AC-7** agent and api `replay.int`: in order, 409 after the last, concurrent calls store one row, 34 → 20 with total 34.
- **AC-8** db and agent `replay.int`: cascade on conversation delete, no visitor text in `coaching_*`; api 404 `conversation_gone`.
- **AC-9** agent `replay.int`: audit entries with codes and IDs only.
- **AC-10** SCR-APP-031 built (`pages/replay.tsx`) with every designed state; drive loop and copy unit-tested; renders and axe in `replay.e2e.ts`: pending CI. The Coach chat list excludes replay sessions (api `replay.int`).
- **AC-11** api `replay.int`: one `…/next` under 8 s on the fake provider.
