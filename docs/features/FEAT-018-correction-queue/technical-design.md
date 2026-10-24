# Technical Design: FEAT-018 — Correction queue, stale-fact scan and old-versus-new replay

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Milestone: M2
> Implements: KB-18, KB-17 · Realizes: UC-16 (main flow, 3a; 3b is FEAT-019's) · Screens: SCR-APP-021, SCR-APP-022 (see [ui-design.md](ui-design.md))
> Status: Designed · Date: 2026-10-24

## 1. Intent

The Owner or an Admin works one queue of signals that the KB may be wrong (KB-18): today the coaching corrections (FEAT-027) and the stale facts this feature's daily scan flags (KB-17). Each item shows where it came from, the facts involved and the proposed fix, and can be accepted, edited then accepted, or closed with no change. Nothing in the queue changes the KB until it is accepted (ADR-010 decision 4). After an accepted fact change, up to 20 past visitor questions whose answers used that fact are re-answered against the current KB and shown next to what the visitor got, through FEAT-028's `replayQuestion` (ADR-027). The other producers (thumbs-down FEAT-031, staff edits FEAT-045, oversight FEAT-064, coverage gaps FEAT-019) append to the same table later and render with no change here.

## 2. Codebase context

- **Corrections (FEAT-027):** table `corrections` (migration 0027) with `source_type` (all seven KB-18 sources already allowed), `proposed_by`, `conversation_ref`, `coaching_session_id`, `coaching_message_id`, `fact_refs`, `proposed_change`, `status` (open, accepted, edited_and_accepted, dismissed), `decided_by`, `decided_at`. `packages/kb/src/corrections.ts`: `ProposedChange` (`edit_fact`, `add_faq`, `edit_hours`), `proposeCorrection` (coaching only), `getCorrection`, `confirmCorrection` (fact edit / new FAQ / hours change and the decision in one transaction; `CorrectionStaleError` when the fact or profile moved on), `dismissCorrection`, audit `correction.proposed|accepted|dismissed`. API: `POST /api/v1/coach/corrections/:id/confirm|dismiss` (`apps/api/src/coach.ts`; confirm embeds `correctionFactInput` with `prepareChunk`, then `reanswer`). Errors in `app.ts`: 409 `correction_closed`, 409 `correction_stale`.
- **Facts:** `facts.last_confirmed_at` (set on approval and on a changed edit, `writes.ts`, `facts.ts`); `fact_versions` immutable; `kb_chunks.fact_version`. ADR-010: `stale` is a flag computed from `last_confirmed_at` and the per-type interval, not a status; re-confirm is a new version.
- **Replay (FEAT-028):** `packages/agent/src/replay.ts` `replayQuestion(deps, { tenantId, userId, sessionId, conversationId, messageId, includeUnreviewed })` stores one `coaching_messages` row (`kind` replay, `replay_of`) per question under a session lock; `prepareQuestion` checks the message is the conversation's visitor message, builds the original history and the abuse count from the session's earlier rows; `loadReplay` groups original replies per question. Sessions of origin `replay` cascade-delete with their conversation (`replay_conversation_id`). Rate limit `replay:{userId}` 30/min in the api.
- **Messages:** `messages.fact_ids` (the facts an agent reply's slots rendered, AGT-01), `in_reply_to` (the visitor message answered). No index on `fact_ids`.
- **Scheduler:** `apps/scheduler-worker/src/main.ts` runs recurring jobs on the outbox zone through SECURITY DEFINER functions owned by NOLOGIN roles (`cost_governor_evaluate`, 0009). Last migration `0028`.
- **Dashboard:** Review hub tabs in `pages/review.tsx` (`ReviewTabs`: Facts, Conflicts); `/review/corrections` is a placeholder naming FEAT-018; nav count in `lib/nav-counts.ts` from `GET /api/v1/kb/review/summary`. `pages/replay.tsx` renders `answer-compare` rows.

## 3. API contracts

New contracts section `// ---- Dashboard API: corrections (KB-18, KB-17, UC-16; FEAT-018 §3)`. Every route needs capability `kb.manage` (Owner, Admin): agent role 403 `forbidden`, no session 401. Another tenant's or a malformed ID gives 404 `not_found`.

| Method, path | Body / query | 200 response | Errors |
|---|---|---|---|
| `GET /api/v1/corrections` | `?status=open\|closed&source=<CorrectionSource>&cursor` | `{ corrections: CorrectionItem[] (20; open: newest first; closed: newest `decidedAt` first), nextCursor }` | 403, 422 `invalid_query` |
| `GET /api/v1/corrections/:id` | | `{ correction: CorrectionItem, context: CorrectionContext, replay: CorrectionReplay \| null }` | 403, 404 |
| `POST /api/v1/corrections/:id/accept` | `{ edit: CorrectionEdit \| null }` | `{ correction: CorrectionItem, replay: CorrectionReplay \| null }` | 403, 404, 409 `correction_closed`, 409 `correction_stale`, 422 `invalid_correction` (edit fails the fact rules or changes nothing), 422 `not_editable` |
| `POST /api/v1/corrections/:id/close` | `{}` | `{ correction: CorrectionItem }` | 403, 404, 409 `correction_closed` |
| `POST /api/v1/corrections/:id/replay/next` | `{}` | `{ turn: CorrectionReplayTurn, remaining: number }` | 403, 404 (no replay), 409 `replay_complete`, 429 `rate_limited` (shared `replay:{userId}` key, 30/min) |
| `GET /api/v1/kb/review-intervals` | | `{ intervals: ReviewIntervals }` | 403 |
| `PUT /api/v1/kb/review-intervals` | `{ intervals: ReviewIntervals }` | `{ intervals: ReviewIntervals }` | 403, 422 `invalid_body` |

Changed routes:

- `GET /api/v1/kb/review/summary` gains `openCorrections: number` and `overdueFacts: number` (the Review nav count and FEAT-065's KB health).
- `POST /api/v1/coach/corrections/:id/confirm` also starts the correction replay; `CorrectionConfirmResponse` gains `replayQuestions: number` (0 when nothing replays), so the coach card can link to the comparison.
- `GET /api/v1/coach/sessions` and `GET /api/v1/coach/replays/:id` exclude or 404 sessions of origin `correction`.

Shapes:

- `CorrectionSource` = the seven `source_type` codes. `ProposedChange` gains `{ kind: 'reconfirm', factId, factVersion, factType, label, lastConfirmedAt }` (a stale fact; accepting it changes no value).
- `CorrectionItem { id, status, source, proposedBy: 'system' | 'coaching' | 'staff', change: ProposedChange, acceptedChange: ProposedChange | null (set when edited), facts: CorrectionFact[], coachingSessionId: string | null, conversationId: string | null, createdAt, decidedAt: string | null, closedBySystem: boolean }`.
- `CorrectionFact { id, label, type, status: FactStatus | 'deleted', version, lastConfirmedAt, overdue: boolean }`: each `fact_refs` entry as it is now.
- `CorrectionContext { coaching: { question: string | null, proposal: string } | null, conversation: OriginalReply[] | null }`: for a coaching item, the owner's message that taught it and the agent's proposal text (coaching text, not visitor text); for an item with a `conversation_ref`, the last 6 messages up to the item's creation (masked, read from `messages` on each GET). Null when absent.
- `CorrectionEdit` = `{ kind: 'edit_fact', after: FactValueView }` (for `edit_fact` and `reconfirm` items: a reconfirm edited becomes a fact edit) | `{ kind: 'add_faq', question, answer }` (for `add_faq` items). Any other pairing, or an `edit_hours` item, is 422 `not_editable`.
- `CorrectionReplay { status: 'replaying' | 'complete', matched: number (all past questions that used the facts), turns: CorrectionReplayTurn[] (≤ 20) }`.
- `CorrectionReplayTurn { messageId, conversationId, index, question, askedAt, original: OriginalReply[], status: 'pending' | 'done', replayed: CoachMessage | null, effects: ReplayEffect[], answerChanged: boolean | null }`. `OriginalReply` and `ReplayEffect` are FEAT-028's. `answerChanged`: the replayed text differs from the first original agent reply's (whitespace-normalised); null while pending or with no agent reply.
- `ReviewIntervals { product, faq, policy, promotion }`: whole months, 1–24, default 6.

## 4. Schema changes (migration `0029_corrections_queue.sql`; Drizzle, then checks, grants and the function by hand)

No new entity: the queue is CORRECTION, the replay a COACHING_SESSION (architecture §5.3, ADR-027).

- **`corrections`**: add `accepted_change jsonb null`; check `(status = 'edited_and_accepted') = (accepted_change is not null)`; partial unique index `corrections_open_stale_uq` on (`tenant_id`, `(fact_refs[1])`) where `source_type = 'stale' and status = 'open'` (one open stale item per fact; ADR-010 "de-duplicated by fact"); index (`tenant_id`, `status`, `decided_at desc`) for the closed list.
- **`coaching_sessions`**: origin check gains `correction`; add `correction_id uuid null`, FK (`tenant_id`, `correction_id`) → `corrections`; check `(origin = 'correction') = (correction_id is not null)`; unique (`tenant_id`, `correction_id`); add `replay_question_ids uuid[] not null default '{}'` (the visitor messages chosen at acceptance, newest first) and `replay_matched integer null`.
- **`coaching_messages`**: add `replay_conversation_id uuid null`, FK (`tenant_id`, `replay_conversation_id`) → `conversations` **on delete cascade**; backfill FEAT-028 rows from their session; check `(kind = 'replay') = (replay_conversation_id is not null)`. A correction replay spans conversations, so erasure cascades per answer (ADR-015).
- **`messages`**: GIN index `messages_fact_ids_gin` on `fact_ids` (the "questions that used this fact" lookup).
- **`tenants`**: add `fact_review_months jsonb not null default '{"product":6,"faq":6,"policy":6,"promotion":6}'` with a check that the four keys are integers 1–24; `GRANT UPDATE (fact_review_months) ON tenants TO app_dashboard`.
- **Stale scan** (pattern of 0009): NOLOGIN role `kaki_stale_scan` with SELECT on the `facts` columns it needs and `tenants (id, fact_review_months)`, SELECT, INSERT and UPDATE (`status`, `decided_at`, `updated_at`) on `corrections`, a `USING (true)` policy per table for that role only. Function `kb_stale_scan() RETURNS TABLE (tenant_id uuid, flagged integer, closed integer)`, SECURITY DEFINER, owned by it, EXECUTE granted to `app_outbox` only:
  1. Flags each `approved` fact whose `last_confirmed_at < now() - make_interval(months => tenant months for its type)`, except a promotion whose `valid_until <= now()`: inserts a `stale`/`system` correction with `fact_refs = {id}` and `proposed_change` `reconfirm` (label from `value` by type, as `factLabel`), `on conflict do nothing`.
  2. Closes open `stale` items whose fact is no longer an overdue approved fact (re-confirmed, edited, disabled, deleted): `status = 'dismissed'`, `decided_at = now()`, `decided_by` null.
- RLS: no new tenant table. `rls.int.test.ts` gains tenant-B cases for a correction replay session and a stale item; the stale-scan role can't be used by any login role (asserted like the governor's).
- Rollback (local only): drop the function, role, columns, indexes and restore the checks.

## 5. Component design

### 5.1 KB (`packages/kb/src/corrections.ts`, new `stale.ts`)

- **`listCorrections(ctx, { status, source?, cursor? })`** and **`correctionFacts(ctx, ids)`** (labels, status, version, `lastConfirmedAt`, `overdue` by the tenant's months); **`correctionCounts(ctx)`** → `{ open, overdueFacts }` for the summary.
- **`acceptCorrection(ctx, id, { edit?, chunk?, applyHours? })`** generalises `confirmCorrection` (which stays as the coaching wrapper with `edit` absent): locks the row; with `edit`, builds the edited change through the same validation as `proposeCorrection` (`editChange` against the current fact version for `edit_fact`, FAQ rules for `add_faq`), stores it in `accepted_change` and decides `edited_and_accepted`; applies the change (`edit_fact`, `add_faq`, `edit_hours` as today; `reconfirm` → `reconfirmFact`); audit `correction.accepted` or `correction.edited` `{ kind, sourceType, factIds }`. The caller embeds `correctionFactInput` of the *effective* change (`acceptedChange ?? change`); `correctionFactInput` gains the edit argument for that.
- **`reconfirmFact(ctx, factId, version)`**: version mismatch or not approved → `CorrectionStaleError` via the caller; otherwise version + 1, a `fact_versions` row with the same value (ADR-010 "re-confirm = new version"), `kb_chunks.fact_version` moved to the new version without re-embedding (content unchanged), `last_confirmed_at = now()`, audit `fact.reconfirmed` `{ factId, version }`.
- **`dismissCorrection`** unchanged (Close with no change).
- **`proposeCorrection`** gains an optional `origin` (`sourceType`, `proposedBy`, `conversationRef`) for later producers; coaching calls are unchanged.
- **`runStaleScan(outboxZdb)`** (`stale.ts`) calls `kb_stale_scan()` and returns the rows.

### 5.2 Tenancy (`packages/tenancy/src/review-intervals.ts`)

`reviewIntervals(tx, tenantId)` and `saveReviewIntervals(tx, tenantId, userId, intervals)` (audit `kb.review_intervals.changed` with the four numbers). Last write wins: one small settings object, no version.

### 5.3 Inbox (`packages/inbox`)

**`pastQuestionsUsing(tx, { tenantId, factIds, before, limit })`** → `{ questions: { messageId, conversationId }[], matched }`: agent messages with `fact_ids && factIds` created before `before`, mapped by `in_reply_to` to distinct visitor messages, newest first, at most `limit`; `matched` counts all such questions.

### 5.4 Agent (`packages/agent/src/correction-replay.ts`)

- **`startCorrectionReplay(deps, { tenantId, userId, correctionId })`**: idempotent (unique `correction_id`). Only for an accepted correction whose effective change is `edit_fact` (D3). Picks `pastQuestionsUsing(factRefs, before: decidedAt, limit REPLAY_LIMIT)`; creates a session (origin `correction`, `include_unreviewed` false, no title); audit `correction.replay.started` `{ correctionId, questions, matched }`. Returns the view, or null when nothing replays.
- **`getCorrectionReplay(deps, { tenantId, correctionId })`**: the session's question IDs, each joined with its stored replay row and the original replies (FEAT-028's grouping, exported from `replay.ts` as `originalRepliesFor`); questions whose conversation is gone are left out.
- **`correctionReplayNext(deps, { tenantId, userId, correctionId })`**: the first pending question → `replayQuestion` (unchanged contract) → the turn and `remaining`; none pending → `ReplayCompleteError`.
- **`replay.ts` changes:** `insertReplayMessage` sets `replay_conversation_id`; `prepareQuestion`'s abuse count only counts earlier rows of the same conversation (a correction session spans many); `getReplay`/`replayNext` reject a session that isn't origin `replay`; `listSessions` excludes `correction`.

### 5.5 Workers and API

- **scheduler-worker:** `STALE_SCAN_INTERVAL_MS` (default 24 h; first run at start-up) runs `runStaleScan`, logs `{ tenants, flagged, closed }`; errors are logged and retried on the next tick. In `.env.example`.
- **api (`apps/api/src/corrections.ts`, `registerCorrectionRoutes`):** the §3 routes. Accept: read the correction, embed the effective change's fact input (`prepareChunk`), `acceptCorrection` with `applyHoursWith`, then `startCorrectionReplay` (its failure is logged and the GET retries it lazily for an accepted correction without a replay). Coach confirm calls `startCorrectionReplay` the same way. Rate limiter as FEAT-028. Review-interval routes in `apps/api/src/review.ts`.

### 5.6 Dashboard

`lib/corrections.ts` (client and pure helpers: origin labels, fix diff rows, effective change, replay progress), `pages/corrections.tsx` (SCR-APP-021 at `/review/corrections`, with the review-intervals dialog), `pages/correction.tsx` (SCR-APP-022 at `/review/corrections/:id`), a Corrections tab in `ReviewTabs`, the Review nav count including open corrections, and the coach confirm card's "See past answers" link. The `answer-compare` row moves from `replay.tsx` into a shared `pages/answer-compare.tsx`. Details in ui-design.md.

### 5.7 Evals

None: no new model behaviour. Replay reuses the visitor pipeline (FEAT-028 AC-4); the scan and accept paths are deterministic and integration-tested.

## 6. Acceptance criteria

- **AC-1** (KB-18 Owner/Admin, ADR-005) Only `kb.manage` reaches the queue routes: agent 403, no session 401; tenant B gets 404 for tenant A's items and an empty list; the RLS suite covers stale items and correction sessions.
- **AC-2** (KB-18 "links to the conversation and the facts involved and proposes a fix", UC-16 1–2) The open list shows each item's source, facts and proposed fix, newest first, filterable by source; the detail adds the coaching or conversation excerpt and each fact as it is now; closed items list with their decision.
- **AC-3** (KB-18 "nothing in the queue changes the KB until the Owner or an Admin accepts it", UC-16 3) Open items leave `facts` and `visitor_facts` unchanged; accepting an `edit_fact` changes the fact (approved, new version) and visitors get it on commit; closing changes nothing; a decided item gives 409 `correction_closed`; a fact changed since gives 409 `correction_stale`.
- **AC-4** (UC-16 3 "edits it") Accepting with an edit applies the edited value, stores `accepted_change`, status `edited_and_accepted`; an invalid or no-op edit gives 422 `invalid_correction`; an hours item or a mismatched edit kind gives 422 `not_editable`; a `reconfirm` item edited becomes a fact edit.
- **AC-5** (KB-17) The scan flags each approved fact not confirmed within its type's interval exactly once (open), skips other statuses and expired promotions, uses each tenant's own months, and closes items whose fact was since confirmed, edited, disabled or deleted; a flagged fact stays in `visitor_facts`. Intervals read and save per type, 1–24, default 6.
- **AC-6** (KB-17 "re-confirm a fact in one tap", UC-16 3a) Accepting a `reconfirm` item makes a new version with the same value, sets `last_confirmed_at`, keeps the fact's chunk searchable, and the next scan doesn't flag it.
- **AC-7** (KB-18 "re-runs up to 20 past questions that used the changed facts and shows the old and new answers side by side", UC-16 4) After a fact edit is accepted (queue or coaching), the replay holds the newest ≤ 20 visitor questions asked before acceptance whose agent reply cited the fact, with `matched` counting all; each `…/replay/next` answers one in order, rendering the new value, next to the original replies; 409 after the last; starting is idempotent; other change kinds have no replay.
- **AC-8** (ADR-009, ADR-015) A correction replay writes no `conversations`, `messages` or `outbox` rows; usage rows carry `coaching_session_id`; deleting a conversation deletes its replayed answers and drops the question from the replay; no visitor text is stored in `coaching_*`; correction sessions don't appear in Coach or `GET /coach/replays/:id`.
- **AC-9** (UC-16 5, ADR-014) Accept, edit-and-accept, close, re-confirm, interval changes, replay start and each replayed question have audit entries with codes and IDs only.
- **AC-10** (KB-18 "number of open items", KB-17 "number of overdue facts") The review summary returns `openCorrections` and `overdueFacts`; the Review nav count and the Corrections tab include open corrections.
- **AC-11** (ui-design) SCR-APP-021 and SCR-APP-022 render every designed state with no serious axe violations; the J11 flow (coach correction → queue → accepted → comparison) works end to end.
- **AC-12** (NFR-01) One `…/replay/next` on the fake provider completes within 8 s in the API integration test.

## 7. Decisions

- **D1 — Stale scan in SQL, owned by a NOLOGIN role** (pattern of the cost governor). Driver: cross-tenant work from the outbox zone without giving it table grants. Rejected: a per-tenant job through the outbox (one message per tenant per day for one statement).
- **D2 — Stale flags aren't audited one by one.** The scan proposes, never changes the KB, and has no actor; its counts are logged. Every decision on an item is audited (UC-16 5).
- **D3 — Only accepted fact edits replay.** "Questions that used the changed facts" comes from `messages.fact_ids`; a new FAQ was used by no past answer, a re-confirm changes no value, and hours aren't stored as fact IDs. The UI says why no comparison appears.
- **D4 — The replay set is fixed at acceptance**: the newest 20 questions asked before `decided_at`, so the comparison doesn't shift as new chats arrive. Newest first because recent askers matter most.
- **D5 — Correction replays use approved facts only** (the KB visitors now get) and FEAT-028's runtime: one question per request while SCR-APP-022 is open (ADR-027). ADR-010 decision 5's "enqueues a replay job" is read through ADR-027.
- **D6 — Review intervals are per fact type on `tenants`** (KB-17 "configurable per entity type"), edited from the Corrections screen; per-fact intervals aren't required. Hours in the business profile aren't facts and aren't scanned.
- **D7 — Edits keep the proposal.** `proposed_change` stays as proposed; `accepted_change` holds what was accepted, so the history shows both.
- **D8 — The system closes obsolete stale items** (fact since confirmed or changed) as `dismissed` with no decider, shown as "Closed automatically".
- **D9 — Erasure cascades per replayed answer** (`coaching_messages.replay_conversation_id`), because one correction replay spans many conversations.

## 8. Escalations and open items

- None needing an ADR: the queue table, statuses and sources are ADR-010's; the runtime is ADR-027's.
- **Gaps left to later features:** the producers thumbs-down (FEAT-031), staff edits of suggested replies (FEAT-045; staff replies to escalations with the inbox feature that owns them), oversight findings (FEAT-064) and coverage gaps with UC-16 3b's "add a new FAQ" (FEAT-019) call `proposeCorrection` with their origin; the Conversation-screen link from an item (FEAT-042, SCR-APP-015); KB health tiles on Home (FEAT-065, reading the summary fields); a "last confirmed" line on the Fact screen (FEAT-021, SCR-APP-028).

## 9. Self-check

KB-18 → AC-1–AC-4, AC-7–AC-10; KB-17 → AC-5, AC-6, AC-10; UC-16 1–5 and 3a → AC-2–AC-7, AC-9. No new entity; the conceptual model is unchanged. Routes don't collide with `/api/v1/coach/corrections/*`, which stay for the coach card. Tasks run schema → contracts → kb and tenancy → scheduler → agent → api → UI → E2E → verify.
