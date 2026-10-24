# Tasks: FEAT-028 — Replay a past conversation against the current KB

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-24

- [x] T1 — Schema: `0028_replay.sql` and Drizzle: `coaching_sessions` origin `replay`, `replay_conversation_id` (FK to conversations, on delete cascade), `include_unreviewed`, checks and index; `coaching_messages` kind `replay`, `replay_of`, unique key, FK to sessions on delete cascade; RLS suite: tenant-B case for a replay session, still no visitor-role grant (design §4; AC-8 schema half)
      Done when: `pnpm db:setup` applies 0028 on a database at 0027; `drizzle-kit generate` reports no drift; the RLS suite passes; deleting a conversation removes its replay sessions and messages (db integration test).
- [ ] T2 — Contracts: the §3 replay section (`ReplayCandidate`, `Replay`, `ReplayTurn`, `OriginalReply`, `ReplayEffect`), `CoachSession.origin` `replay`, `CoachMessage.kind` `replay`, `Explainer` outcome `ended` and reasons `crisis`, `abuse_warning`, `abuse_ended` (design §3)
      Done when: workspace typecheck passes; contracts unit tests parse a sample `Replay` and reject a turn with `status: 'done'` and no `replayed`.
- [ ] T3 — Agent, stubbed dispatch: `stubAll`, `replayRegistry`, `ReplayPorts` (in-memory flag/endAi, `recordAbuse` from earlier turns' effects, collected audit); `explain()` handles `ended` and the safety reasons; `answerStep` takes a dispatch result instead of running `coachingRegistry` itself, coaching behaviour unchanged (design §5.1; AC-5)
      Done when: agent unit tests pass: crisis, abuse (warn then end) and out-of-scope plans give the visitor's texts and effects with no port writes; `propose_correction` is refused in a replay context; FEAT-027's coach tests still pass.
- [ ] T4 — Agent, replay core: `coach-store` replay functions, `replayCandidates`, `startReplay`, `getReplay` (original replies grouped per question, `factsChanged`, first 20 and `totalQuestions`), `replayQuestion`, `replayNext`, errors; audit entries (design §5.1, §5.2; D3–D8; AC-2–AC-4, AC-6–AC-9)
      Done when: agent integration tests on the fake provider pass: a replayed answer equals `runVisitorTurn`'s for the same KB and history; a changed fact gives the new value; `includeUnreviewed` respected; no `conversations`/`messages`/`outbox` writes and usage rows carry `coaching_session_id`; concurrent `replayNext` stores one row; 34 questions → 20 turns, total 34; audit payloads codes and IDs only; no visitor text in `coaching_*`.
- [ ] T5 — API: the four routes in `apps/api/src/coach.ts`, rate limit `replay:{userId}` 30/min, error mapping; the sessions list excludes replay sessions (design §3, §5.3; AC-1, AC-7, AC-8, AC-11)
      Done when: api integration tests pass for every designed success and error, including tenant B's 404s and empty candidates, staff 403, 409 `replay_complete`, 404 `conversation_gone`, the 429, and one `…/next` under 8 s on the fake provider.
## Build session 2 (UI)

- [ ] T6 — Dashboard: `lib/replay.ts` (client, helpers), `pages/replay.tsx` (picker with dialog; comparison with progress, pause/continue, `answer-compare` rows, effects, "Teach a fix" → quick panel), routes, the Coach page-head link (ui-design SCR-APP-031)
      Done when: dashboard typecheck and unit tests pass (`lib/replay.test.ts`: progress text, "first 20 of N", effect sentences, the drive loop stops on error and on pause).
      Note: no local stack in cloud sessions; renders are checked by T7's E2E in CI.
- [ ] T7 — E2E: `e2e/tests/replay.e2e.ts`: a widget conversation asks a price → the owner changes the fact → replays the conversation → the "now" column shows the new price with "Uses different facts", the original column the old; axe on picking and comparison (design §6; AC-3, AC-10)
      Done when: the spec passes in CI's E2E job.
      Note: E2E runs only in CI (STATE.md); written and typechecked here, pending CI.
- [ ] T8 — Verify: every AC in design §6 demonstrated; `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, this feature's package unit and integration tests green
      Done when: the evidence below is filled in, one bullet per AC.

## Verification evidence
