# Technical Design: FEAT-028 — Replay a past conversation against the current KB

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E3) · Milestone: M2
> Implements: AGT-17 (p: "replay a real past conversation against the current KB") · Realizes: UC-04 4b · Screens: SCR-APP-031 (see [ui-design.md](ui-design.md))
> Status: Designed (D1 decided and ADR-027 accepted by Ken, 2026-10-24) · Date: 2026-10-24

## 1. Intent

The Owner or an Admin picks a real past conversation and sees, question by question, what the assistant would say now against the current KB, next to what the visitor actually got. Nothing is sent, flagged or created: every handler is stubbed (ADR-009, ADR-025 decision 7). It closes AGT-17's last clause and UC-04 4b, and its per-question core is what FEAT-018 reuses for the 20-question replay after an accepted correction (KB-18).

## 2. Codebase context

- **Coaching (FEAT-027):** `packages/agent/src/coach.ts` has `prepare` (tenant state, hours), `answerStep` (dispatch with `coachingRegistry` then `answerTurn` with slots and verifier, gate always open), `explain()` (the `Explainer`, built in code), `dispatchContext` and `search` (`searchCoachingFacts` with `includeUnreviewed`). `coach-store.ts` writes `coaching_sessions`/`coaching_messages` on the dashboard zone. Usage is metered with `meta.coachingSessionId` (`usage_events.coaching_session_id`). Routes in `apps/api/src/coach.ts` behind capability `coach.use` with the `rateLimiter`.
- **Dispatcher:** `visitorRegistry` = `crisisHandler`, `abuseHandler`, `outOfScopeHandler` (`dispatch.ts`). Their only side effects go through `ctx.conversation` (`flag`, `recordAbuse`, `endAi`) and `ctx.audit`. `runVisitorTurn` renders a safety `endTurn` with `safetyText` (`turn.ts` ~316).
- **Conversations:** `conversations`, `messages` (`author` visitor/agent/staff/system, `seq` global identity, `inReplyTo`, `factIds`; bodies masked at the edge). `@kaki/inbox` has `recentMessages(tx, {upToSeq, limit})`, `messagesSince`, `getConversation`, `listConversations`. The dashboard zone reads both tables (`GET /api/v1/conversations`). The Conversation screen (SCR-APP-015) is FEAT-042; today's inbox rows aren't links.
- **Schema:** last migration `0027`. `COACHING_ORIGINS` = coach, setup, panel; `COACHING_MESSAGE_KINDS` = question, answer, proposal, after. `coaching_messages` → `coaching_sessions` FK has no `on delete`.
- **ADR-026** decision 2 says the agent-worker keeps replay jobs, and reserves task kind `replay`. This design runs replay in the api, one question per request (D1, ADR-027), and doesn't add the kind (D2).

## 3. API contracts

New contracts section `// ---- Dashboard API: replay (AGT-17, UC-04 4b; FEAT-028 §3)`. Every route needs `coach.use` (Owner, Admin): staff 403 `forbidden`, no session 401. Another tenant's or a malformed ID gives 404 `not_found`.

| Method, path | Body / query | 200/201 response | Errors |
|---|---|---|---|
| `GET /api/v1/coach/replay-candidates` | `?cursor` | `{ conversations: ReplayCandidate[] (20, newest `lastMessageAt` first, only those with ≥ 1 visitor message), nextCursor }` | 403 |
| `POST /api/v1/coach/replays` | `{ conversationId: uuid, includeUnreviewed: boolean }` | 201 `{ replay: Replay }` (every turn `pending`) | 403, 404 (conversation), 422 `invalid_body`, 422 `nothing_to_replay` (no visitor message) |
| `GET /api/v1/coach/replays/:id` | | `{ replay: Replay }` | 403, 404 |
| `POST /api/v1/coach/replays/:id/next` | `{}` | `{ turn: ReplayTurn, remaining: number }` | 403, 404, 409 `replay_complete`, 404 `conversation_gone` (erased since), 429 `rate_limited` (30 replayed questions a minute per user) |

Shapes:

- `ReplayCandidate { id, channel, status, startedAt, lastMessageAt, firstQuestion: string (masked, ≤ 120 chars), questions: number (visitor messages), flagged: boolean, lastReplayId: string | null }`.
- `Replay { id (the coaching session), conversationId, includeUnreviewed, createdAt, totalQuestions: number, turns: ReplayTurn[] }`. `turns` covers the first `REPLAY_LIMIT` = 20 visitor messages, oldest first; `totalQuestions` is the conversation's count, so the UI can say "the first 20 of 34".
- `ReplayTurn { messageId (the original visitor message), index, question: string, askedAt, original: OriginalReply[], status: 'pending' | 'done', replayed: CoachMessage | null, effects: ReplayEffect[], factsChanged: boolean | null }`.
  - `OriginalReply { author: 'agent' | 'staff' | 'system', text, factIds: string[], createdAt }`: the conversation's non-visitor messages after this question and before the next visitor message, in `seq` order (empty if nobody answered).
  - `replayed` is FEAT-027's `CoachMessage` with `kind: 'replay'`, its `explainer` and `correction: null`.
  - `ReplayEffect { task: TaskKind, outcome: 'done' | 'refused' | 'unhandled' }`: what the dispatcher would have done live (crisis flag, abuse warning or end, out-of-scope refusal; future kinds such as `capture_lead` show as `unhandled` until their feature registers a handler). Codes only.
  - `factsChanged`: whether the replayed answer's fact IDs differ, as a set, from the first original agent reply's (`null` while pending or when no original agent reply exists).
- `Explainer` gains outcome `ended` and reason codes `crisis`, `abuse_warning`, `abuse_ended` (a safety task ended the turn); FEAT-027's coaching never produces them.
- `CoachSession.origin` gains `replay`; `GET /api/v1/coach/sessions` excludes replay sessions (they're reached from SCR-APP-031).

`POST …/next` is synchronous and answers the lowest-index pending turn; NFR-01's full-reply bound (p95 ≤ 8 s) applies to it. Two concurrent calls can't store the same turn twice (unique key, §4); the loser returns the stored turn.

## 4. Schema changes (migration `0028_replay.sql`; Drizzle, then checks and grants by hand)

No new entity: a replay is a COACHING_SESSION (architecture §5.3) whose content is replayed answers, which keeps it outside analytics and fair use by construction (ADR-009).

- **`coaching_sessions`**: origin check gains `replay`; add `replay_conversation_id uuid null` with FK (`tenant_id`, `replay_conversation_id`) → `conversations` **on delete cascade**; add `include_unreviewed boolean not null default false`; check `(origin = 'replay') = (replay_conversation_id is not null)`; index (`tenant_id`, `replay_conversation_id`, `created_at desc`).
- **`coaching_messages`**: kind check gains `replay`; add `replay_of uuid null` (the original visitor message ID, no FK: `messages` rows go with their conversation); check `(kind = 'replay') = (replay_of is not null)`; unique (`tenant_id`, `session_id`, `replay_of`); replace the FK to `coaching_sessions` with the same columns **on delete cascade**. Effects are stored in `explainer.effects` (jsonb).
- Erasing a conversation (later deletion features) removes its replays and their answers, which may echo visitor details (ADR-015). Visitor text is never copied: questions and original replies are read from `messages` on each GET.
- Grants unchanged in kind: `app_dashboard` already has SELECT, INSERT on both tables; it gains nothing else. `app_agent_visitor` still has no grant (asserted). RLS policies are unchanged (same tables); `rls.int.test.ts` gains a tenant-B case for a replay session.
- Rollback (local only): drop the columns and restore the checks and FK.

## 5. Component design

### 5.1 Agent (`packages/agent/src/replay.ts`)

- **`replayCandidates(deps, { tenantId, cursor })`**, **`startReplay(deps, { tenantId, userId, conversationId, includeUnreviewed })`** (creates the session, origin `replay`, title = the first question cut to 80; audit `coach.replay.started` `{ conversationId, questions }`), **`getReplay(deps, { tenantId, sessionId })`** (joins the stored `replay` messages with the conversation's messages read through `@kaki/inbox`), **`replayNext(deps, { tenantId, userId, sessionId })`**.
- **`replayQuestion(deps, { tenantId, userId, sessionId, conversationId, messageId, includeUnreviewed })`**, the reusable core (FEAT-018 calls it per past question):
  1. `prepare` (tenant state, current hours; D4). History = the original conversation up to and including the visitor message (`recentMessages`, `upToSeq`, `HISTORY_LIMIT`), mapped as `runVisitorTurn` maps it (D3).
  2. Visitor triage (`TRIAGE_SYSTEM`, the live prompt) ∥ embed + `searchCoachingFacts` with `includeUnreviewed`. `meta = { tenantId, coachingSessionId }`.
  3. `dispatchPlan(replayRegistry, plan, replayContext)`. A safety `endTurn` gives the `safetyText` the visitor would get, outcome `ended`. Otherwise `answerStep` with that dispatch result (FEAT-027's step, refactored to take the registry's result instead of running `coachingRegistry` itself).
  4. `explain()` plus `effects` from the dispatch reports; store one `coaching_messages` row (`author` agent, `kind` replay, `replay_of`, masked body, fact IDs, explainer) with `on conflict do nothing`, then return the stored row. Audit `coach.replay.turn` `{ outcome, tasks, factIds, effects }`.
- **`replayRegistry`** = `stubAll(visitorRegistry)`: each visitor handler re-scoped to `['coaching']` with its own `run`, so the replay sees exactly the live decisions (ADR-025 decision 7). **`replayContext`** stubs every port: `conversation.flag` and `endAi` resolve without writing; `recordAbuse` counts this replay's earlier turns whose effects include a done `abuse` plus one; `audit` collects entries in memory (the turn's single audit entry carries them as codes); `gateOpen` true (FEAT-027 D5); `consentGiven` false; `coaching` absent, so `propose_correction` can't run (`correct` never appears in a visitor-triage plan, and if it did it would be `unhandled`).
- Typed so a replay context can't reach a writing port: `ReplayPorts` implements `ConversationPort` with no database handle.

### 5.2 Storage, usage and exclusion

`coach-store.ts` gains `createReplaySession`, `replayMessages`, `insertReplayMessage`. Nothing writes `conversations`, `messages` or `outbox`; usage rows carry `coaching_session_id` and no `conversation_id`, as coaching does.

### 5.3 API (`apps/api/src/coach.ts`)

`registerCoachRoutes` gains the four routes. Rate limit with the existing `rateLimiter`, key `replay:{userId}`, 30 a minute. Errors: `ReplayCompleteError` → 409, `NothingToReplayError` → 422, `CoachingSessionNotFoundError` / missing conversation → 404.

### 5.4 Dashboard

`lib/replay.ts` (client and pure helpers: progress, the "first 20 of N" line, effect sentences), `pages/replay.tsx` (picker at `/coach/replay`, comparison at `/coach/replay/:id`), a "Replay a conversation" link in the Coach page head, and a "Teach a fix" action per turn that opens the quick coach panel prefilled with the visitor's question. The page drives `…/next` one call at a time while it's open (D1). Details in ui-design.md.

### 5.5 Evals

No new eval set: replay reuses the visitor triage, retrieval and verifier pipeline already scored by the AGT-14 sets. An agent integration test proves a replayed answer equals a fresh visitor turn's on the same KB and history (AC-4).

## 6. Acceptance criteria

- **AC-1** (AGT-17, ADR-009) Only Owner and Admin reach replay: staff 403 on every route, no session 401; tenant B gets 404 for tenant A's conversations and replays, and tenant A's conversations never appear in tenant B's candidates.
- **AC-2** (UC-04 4b) Candidates list only conversations with a visitor message, newest first, with the first question and the question count; `POST /replays` returns every turn pending with the original replies grouped under each question.
- **AC-3** (AGT-17 "against the current KB") After a fact changes, replaying a question that used it gives an answer rendering the new value from slots, through the verifier, with an explainer; with `includeUnreviewed` false no `needs_review` fact is used, with true it can be and is labelled.
- **AC-4** (ADR-009 "real visitor behaviour") On the fake provider, a replayed answer for a question equals the reply `runVisitorTurn` gives for the same KB and history (text, outcome, fact IDs).
- **AC-5** (ADR-025 decision 7) A crisis question replays with the crisis text and effect `crisis done`, and writes no flag; a repeated-abuse conversation replays the warning then the end, and `conversations.status`, `flag_reasons` and `abuse_turns` are unchanged.
- **AC-6** (AGT-17, ADR-009) A replay writes no `conversations`, `messages` or `outbox` rows; its `usage_events` rows have `coaching_session_id` set and `conversation_id` null.
- **AC-7** Turns are answered in order, one per `…/next`; after the last, 409 `replay_complete`; two concurrent calls store one row; a conversation of 34 questions replays the first 20 and reports `totalQuestions` 34.
- **AC-8** (ADR-015) Deleting the conversation deletes its replay sessions and replayed answers; no visitor text is stored in `coaching_*`; `…/next` on a replay whose conversation is gone gives 404 `conversation_gone`.
- **AC-9** (AGT-17 "audit-logged", ADR-014) Starting a replay and each replayed question have an audit entry with codes and IDs only.
- **AC-10** (UC-04 4b; ui-design) SCR-APP-031 renders picking, replaying and comparison with every designed state and no serious axe violations; replay sessions don't appear in the Coach chat list.
- **AC-11** (NFR-01) One `…/next` on the fake provider completes within 8 s in the API integration test.

## 7. Decisions

- **D1 — Replay runs in the api, one question per request** (Ken, 2026-10-24; ADR-027). Driver: coaching already runs there (FEAT-027 D1); results appear as they arrive; no queue, infra or dashboard-zone worker. Rejected: an agent-worker job (ADR-026 as written) needing a dashboard-zone connection, an SQS queue, an outbox topic and Terraform changes. Consequence: the replay advances only while SCR-APP-031 is open and resumes from the next pending question.
- **D2 — No `replay` task kind.** Replay starts from the screen, not from chat text, so nothing needs triage to recognise it. ADR-026's reservation lapses (recorded in ADR-027).
- **D3 — Each question replays against the original history** (what the visitor saw up to that point), not against earlier replayed answers. It isolates each answer's change and matches KB-18's per-question replay.
- **D4 — Replay uses the current time and hours.** "The current KB" includes today's hours; a past "are you open now?" is answered for now. The UI says so once.
- **D5 — First 20 questions** (`REPLAY_LIMIT`, the same bound as KB-18's replay), oldest first; the count of the rest is shown.
- **D6 — Facts are approved-only by default**, with FEAT-027's include-unreviewed choice made once per replay and stored on the session.
- **D7 — Visitor text is read, never copied**, and replays cascade-delete with their conversation (ADR-015).
- **D8 — The replay core is `replayQuestion`**, exported for FEAT-018's post-correction replay.

## 8. Escalations and open items

- **ADR-027 (accepted by Ken, 2026-10-24):** replaces ADR-026 decision 2's "the agent-worker keeps … (FEAT-018/028) replay jobs" with "replay runs in the api, one question per request" and lapses the `replay` kind reservation. File: `docs/02-design/adr/ADR-027-replay-runtime.md`.
- **Gaps left to later features:** the Replay entry point on the Conversation screen (FEAT-042, SCR-APP-015); the 20-question replay after an accepted correction (FEAT-018, through `replayQuestion`).

## 9. Self-check

AGT-17 (replay clause) → AC-2–AC-9; UC-04 4b → AC-2, AC-3, AC-10. No new entity (COACHING_SESSION only). The runtime change is escalated as ADR-027. Routes sit under `/api/v1/coach/` with no collision. Tasks run schema → contracts → agent → api → UI → E2E → verify.
