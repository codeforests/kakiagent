# Technical Design: FEAT-019 — Coverage report (template topics before go-live, gaps after)

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Milestone: M2
> Implements: KB-09 (and KB-18's coverage-gap source) · Realizes: UC-03 step 7 (coverage check), UC-13 step 4, UC-16 3b · Screens: SCR-APP-029 (new), SCR-APP-021 and SCR-APP-022 (extended), SCR-APP-008 (partial: coverage summary) (see [ui-design.md](ui-design.md))
> Status: Designed · Date: 2026-10-24

## 1. Intent

The Owner or an Admin sees which common customer questions the assistant can't answer yet, and fixes each with an FAQ in one step (KB-09). Before go-live the report checks the industry template's topics (ONB-06, FEAT-009's suggested FAQs) against the approved KB. After go-live it also lists the top gaps: visitor questions the assistant tried to answer but couldn't (outcome `unavailable`, `unsure` or `escalated`), grouped by meaning, most asked first. Each group of gaps is one `coverage_gap` item in the correction queue (KB-18, ADR-010), so the queue and the report are two views of the same signal: answering it with an FAQ from either screen closes it in both (UC-16 3b). Nothing reaches visitors until the owner writes and saves the answer.

## 2. Codebase context

- **Templates (FEAT-009):** `packages/tenancy/src/templates.ts`: `INDUSTRY_TEMPLATES` (F&B only, 12 `SuggestedFaq { id, question, hint }`, questions only, never answers) and `questionKey()`. `apps/api/src/settings.ts` `profileResponse` marks a suggestion `added` when an approved FAQ has the same `questionKey`; `apps/api/src/coach.ts` (~l. 440) uses the same match for coach suggestions.
- **Turn (code-map "Agent pipeline"):** `runVisitorTurn` embeds the visitor message once (`llm.embed`, purpose `query`, `turn.ts` ~l. 244) for retrieval; `store()` (~l. 132) appends the reply and audits `agent.decision` with the outcome. `TurnOutcome` = `answered | escalated | gate_closed | unavailable | out_of_scope | unsure | refused | paused | ended`. The outcome is audited only, not stored on `messages`.
- **Corrections (FEAT-018):** `corrections` (0027, 0029) already allows `source_type = 'coverage_gap'`, `proposed_by = 'system'`, `conversation_ref`; `ProposedChange` kinds `edit_fact | add_faq | edit_hours | reconfirm`; `acceptCorrection` with a `CorrectionEdit` (`add_faq` needs question and answer) sets `edited_and_accepted` + `accepted_change`; `dismissCorrection`; `correctionCounts` feeds the Review nav pill. `kb_stale_scan()` (0029) is the pattern for a cross-tenant SQL job owned by a NOLOGIN role and run by the scheduler on the outbox zone. Last migration `0029`.
- **Search:** `searchVisitorFacts` (visitor zone, `visitor_facts`), `searchCoachingFacts` (dashboard zone, approved plus labelled needs_review, returns `distance`); `kb_chunks.embedding vector(1024)`.
- **Dashboard:** Knowledge tabs in `pages/knowledge-tabs.tsx` (Facts, Sources); Corrections screens `pages/corrections.tsx`, `pages/correction.tsx`, `lib/corrections.ts` (origin label `coverage_gap` "Coverage gap" already defined); `SetupReviewPage` in `pages/review.tsx` names FEAT-019 for the coverage summary.

## 3. API contracts

New contracts section `// ---- Dashboard API: coverage (KB-09, UC-16 3b; FEAT-019 §3)`. Every route needs `kb.manage` (Owner, Admin): agent 403 `forbidden`, no session 401.

| Method, path | Body / query | 200 response | Errors |
|---|---|---|---|
| `GET /api/v1/kb/coverage` | | `CoverageReport` | 403 |
| `PUT /api/v1/kb/coverage/topics/:topicId` | `{ skipped: boolean }` | `{ topic: CoverageTopic }` | 403, 404 `not_found` (no such topic in the tenant's template) |

```ts
CoverageTopic = { id, question, hint, state: 'covered' | 'missing' | 'skipped',
  coveredBy: { factId, type: FactType, label } | null }        // null unless covered
CoverageGap = { correctionId, question /* newest ask, masked body */, asks30d, asksTotal,
  firstAskedAt, lastAskedAt, reasons: ('unavailable' | 'unsure' | 'escalated')[] }
CoverageReport = {
  stage: 'pre_live' | 'live',                                   // D4
  template: { industry, topics: CoverageTopic[], checked: 'meaning' | 'question_only' } | null,
  gaps: CoverageGap[],                                          // open items, top 20, D6 order
  summary: { topicsTotal, topicsMissing, openGaps } }
```

Changes to the corrections section (FEAT-018 §3), all additive:

- `ProposedChange` gains `{ kind: 'answer_gap' }`: no question text in the proposal (D3); the questions come from the member messages at read time.
- `CorrectionContext` gains `gap: { asks30d, asksTotal, lastAskedAt, questions: { messageId, conversationId, body, askedAt, reason }[] /* newest 5 */ } | null`.
- `POST /api/v1/corrections/:id/accept` on an `answer_gap` item requires `edit: { kind: 'add_faq', question, answer }`: without it 422 `invalid_correction` ("an FAQ needs a question and an answer"); another edit kind 422 `not_editable`. Success creates an approved FAQ (embedded with `prepareChunk`, as FEAT-018's add_faq), status `edited_and_accepted`, no replay. `POST …/close` dismisses it as for any item.
- Template topics are answered with the existing `POST /api/v1/kb/facts` (`type: 'faq'`, FEAT-011); the topic then reads `covered` by `questionKey`.

## 4. Schema changes (migration `0030_coverage.sql`; Drizzle, then grants, policies and the function by hand)

No new entity: a gap is an attribute of the visitor MESSAGE, a group of gaps is a CORRECTION (ADR-010), the skip list an attribute of BUSINESS_PROFILE.

- **`messages`** (on the visitor message a turn failed to answer): `gap_reason text null` (check in `unavailable`, `unsure`, `escalated`), `gap_embedding vector(1024) null`, `gap_correction_id uuid null`, FK (`tenant_id`, `gap_correction_id`) → `corrections`; check `(gap_reason is null) = (gap_embedding is null)` and `gap_correction_id is null or gap_reason is not null`. Partial indexes: (`tenant_id`, `created_at`) where `gap_reason is not null and gap_correction_id is null` (the job's backlog); (`tenant_id`, `gap_correction_id`, `created_at desc`) where `gap_correction_id is not null` (counts and newest asks). Grant `UPDATE (gap_reason, gap_embedding) ON messages TO app_visitor`. Erasure of a message removes its embedding with it (ADR-015).
- **`business_profiles`**: `coverage_skipped_topics text[] not null default '{}'`, check `cardinality <= 100`; `GRANT UPDATE (coverage_skipped_topics) … TO app_dashboard`.
- **Gap grouping** (pattern of 0029): NOLOGIN role `kaki_gap_cluster` with SELECT on the `messages` columns above plus `tenant_id, id, conversation_id, created_at`, UPDATE (`gap_correction_id`) on `messages`, SELECT, INSERT and UPDATE (`status`, `decided_at`, `updated_at`) on `corrections`, a `USING (true)` policy per table for that role only. Function `kb_gap_cluster() RETURNS TABLE (tenant_id uuid, grouped integer, opened integer, closed integer)`, SECURITY DEFINER, owned by it, EXECUTE to `app_outbox` only:
  1. For up to 500 ungrouped gap messages, oldest first: the nearest gap message of the same tenant asked in the last 60 days whose `gap_correction_id` is an **open** `coverage_gap` item, by cosine distance on `gap_embedding`; if it's within `0.25` (D5), join that item; otherwise insert a `coverage_gap`/`system` correction with `proposed_change = '{"kind":"answer_gap"}'`, `fact_refs = '{}'`, `conversation_ref` = the message's conversation, and join it. Each message is processed in order, so a burst of similar questions forms one item.
  2. Closes open `coverage_gap` items with no member message left (erased) as `dismissed`, `decided_by` null ("Closed automatically", FEAT-018 D8).
- `messages`, `corrections` and `business_profiles` are already tenant-scoped with forced RLS; `rls.int.test.ts` gains tenant-B cases for a gap message's columns and a `coverage_gap` item; the cluster role can't be used by any login role (asserted like the stale scan's).
- Rollback (local only): drop the function, role, columns and indexes.

## 5. Component design

### 5.1 Inbox (`packages/inbox`)
- `markQuestionGap(tx, { tenantId, messageId, reason, embedding })`: sets `gap_reason` and `gap_embedding` on a visitor message where both are null (idempotent on redelivery).
- `gapQuestions(tx, tenantId, correctionIds, { perItem })` and `gapCounts(tx, tenantId, correctionIds, since)`: the newest member messages (masked body, conversation, time, reason) and counts per item, for kb's report and the correction detail.

### 5.2 Agent (`packages/agent/src/turn.ts`)
- In `store()`'s transaction, when the outcome is `unavailable`, `unsure` or `escalated`, the plan has an `answer` task, and the turn has the query vector, call `markQuestionGap` (D2). Not for `paused`, `gate_closed`, `out_of_scope`, `refused`, `ended`, or when the embedder failed (no vector; the turn already falls back). No new audit entry: `agent.decision` already records the outcome. Keep the vector from the retrieval step in a local for `store()`.

### 5.3 KB (`packages/kb/src/coverage.ts`, `corrections.ts`)
- `coverageReport(ctx, { template, skipped, embedTopics, now })`: `ctx` is the dashboard kb context.
  - **Topics:** for each template topic: `skipped` if its id is in the skip list; else `covered` by an approved FAQ with the same `questionKey`; else, when `embedTopics` returned vectors, `covered` by the nearest approved, enabled, unconflicted fact (the `visitor_facts` set) within cosine distance `0.35` (D5), with that fact as `coveredBy`; else `missing`. If embedding fails, `checked: 'question_only'` and only the key match runs (D7).
  - **Gaps:** open `coverage_gap` items with their counts (`gapCounts` for 30 days and all time), newest question, reasons; ordered by `asks30d` desc, then `lastAskedAt` desc; top 20 (D6).
  - **Stage:** `live` when the tenant has at least one conversation, else `pre_live` (D4).
- `corrections.ts`: `ProposedChange` `answer_gap`; `acceptCorrection` on it requires an `add_faq` edit (else `InvalidCorrectionError`; other kinds `NotEditableError`), creates the FAQ as FEAT-018's add_faq does, `edited_and_accepted`; `listCorrections`/detail context fill `gap` via inbox; `correctionFactInput` handles the effective `add_faq`; the fix summary label for the list.
- `runGapCluster(zdb)`: calls `kb_gap_cluster()` on the outbox zone, like `runStaleScan`.

### 5.4 Tenancy
- `coverageSkippedTopics(tx)` and `setTopicSkipped(tx, { tenantId, userId, topicId, skipped })` on `business_profiles` (validates the id against the tenant's template; audit `coverage.topic_skipped` / `coverage.topic_unskipped` with the topic id, a code).

### 5.5 Workers and API
- Scheduler: `GAP_CLUSTER_INTERVAL_MS` (default 600 000, 10 min; first run at start-up) runs `runGapCluster` with a log line of the counts, in `.env.example`.
- API `apps/api/src/coverage.ts` `registerCoverageRoutes`: the two §3 routes. The topic vectors are embedded once per API process per template question (`purpose: 'query'`, memoized by topic id and question text, D7) through the gateway already wired for coaching. The corrections routes pick up `answer_gap` through kb.

### 5.6 Dashboard (ui-design.md)
- `pages/coverage.tsx` (SCR-APP-029) at `/knowledge/coverage`, a third Knowledge tab "Coverage"; `lib/coverage.ts` (ordering, copy). FAQ dialogs reuse FEAT-011's FAQ fields and `form-dialog`.
- Corrections (SCR-APP-021/022): `answer_gap` summary, the asked-questions context, Accept as "Add an FAQ" with the FAQ dialog.
- `SetupReviewPage` (SCR-APP-008, partial): a coverage summary card linking to Coverage.

### 5.7 Evals
- No change to what the model sees or writes, so no new eval case (plan §3 asks agent-touching features for cases; this one only records an outcome the turn already has). The turn test covers which outcomes mark a gap.

## 6. Acceptance criteria

- **AC-1** (KB-09 Owner/Admin, ADR-005) Only `kb.manage` reaches the coverage routes: agent 403, no session 401; tenant B's report never shows tenant A's topics state or gaps; the RLS suite covers gap columns and `coverage_gap` items.
- **AC-2** (KB-09 "before go-live it uses the industry template's topic list") For an F&B tenant every template topic appears once: `covered` with the covering fact when an approved FAQ has the same question or an approved fact is within the distance; `missing` otherwise; needs_review, disabled and conflicted facts never cover a topic. A tenant with no industry or no template gets `template: null`.
- **AC-3** (KB-09 "lists common customer topics … the KB cannot yet answer") Adding an approved FAQ for a missing topic makes it `covered` on the next read; skipping a topic makes it `skipped` and un-skipping restores its computed state; an unknown topic id gives 404; both are audited with codes only.
- **AC-4** (KB-09 "after go-live it shows the top gaps from escalated or unanswered questions") A visitor turn with outcome `unavailable`, `unsure` or `escalated` and an `answer` task marks the visitor message as a gap with its embedding; `answered`, `out_of_scope`, `refused`, `paused`, safety-ended turns and turns without an embedding don't; redelivery marks it once.
- **AC-5** (KB-18 coverage-gap source, ADR-010) The grouping job puts each gap into the nearest open `coverage_gap` item within the distance from the last 60 days, or opens a new one (`system`, conversation linked); similar questions form one item and unrelated ones separate items; a gap similar to an accepted or closed item opens a new one; items whose messages were all erased close automatically; no fact or `visitor_facts` row changes.
- **AC-6** (KB-09 "top gaps") The report lists open gap items ordered by asks in the last 30 days, then most recent, at most 20, each with the newest question (masked), counts and reasons; `stage` is `pre_live` before the first conversation and `live` after.
- **AC-7** (UC-16 3b, KB-18 "nothing changes until … accepts") Accepting a gap item with an FAQ creates an approved FAQ visitors get on commit, sets `edited_and_accepted`, and removes the gap from the report; accepting without an answer gives 422 `invalid_correction`, another edit kind 422 `not_editable`; closing it changes no fact; the correction detail shows the newest asked questions.
- **AC-8** (ADR-014, ADR-015) Gap text lives only on `messages` (no visitor text in `corrections` or audit payloads); deleting a message removes its embedding; audit entries for skip, accept and close carry codes and IDs only.
- **AC-9** (KB-09, D7) When topic embedding fails the report still returns, with `checked: 'question_only'` and key matching only.
- **AC-10** (ui-design) SCR-APP-029 renders every designed state (pre-live, live, all covered, no template, error), the gap item renders on SCR-APP-021/022, and the setup review shows the coverage summary, with no serious axe violations; E2E: a widget question the KB can't answer becomes a gap after the job runs, the owner answers it from Coverage, and it leaves the report and the queue.

## 7. Decisions

- **D1 — One signal, two views.** A group of gaps is a `coverage_gap` correction; Coverage and the Corrections queue read the same rows and answering or closing in either closes both. Driver: KB-18 "one queue collects every signal … coverage gaps (KB-09)". Rejected: a separate gap list with its own status (two places to keep in step).
- **D2 — Gaps are marked in the turn, grouped by a job.** The turn already has the query embedding, so marking costs no model call and needs only a column grant on its own message; grouping and filing the queue item run in SQL every 10 minutes under a NOLOGIN role, so the visitor zone never writes corrections (ADR-009). Rejected: grouping inside the turn (visitor zone reading and writing the queue); re-embedding in a consumer (an extra call for a vector we have).
- **D3 — No visitor text in the proposal.** `answer_gap` carries no question; screens read the member messages, so erasure of a conversation removes the text everywhere (ADR-015). The owner's FAQ question is their own text.
- **D4 — Go-live is the first conversation until FEAT-034.** There is no channel-live flag yet; FEAT-034 replaces the check with "a channel is live". Both stages show both sections; the stage only orders them and sets the copy.
- **D5 — Distances are starting values.** Join a gap item within cosine distance 0.25; a fact covers a topic within 0.35 (`visitor.ts` keeps 0.85 as the retrieval cut-off). Constants in kb and the SQL function, to be checked on real Cohere embeddings at the M1.5 real-model gate (pending-actions).
- **D6 — Top gaps by recent asks.** Ordered by asks in the last 30 days, then by recency, 20 shown; the queue holds every open item.
- **D7 — Template topics are matched by meaning, with a fallback.** A key match alone misses "Do you deliver?" answered by a delivery policy. The ≤ 12 topic vectors are embedded once per API process; without them the report degrades to key matching and says so.
- **D8 — Owners can mark a topic "Doesn't apply"** (a home baker has no dine-in). Stored on the business profile, reversible, audited.

## 8. Escalations and open items

- None needing an ADR: no new entity (§4); grouping reuses ADR-010's queue and the 0029 job pattern.
- **Later features:** channel-live as the go-live signal (FEAT-034); a link from a gap to its conversation (FEAT-042, SCR-APP-015); Home's KB health tiles (FEAT-065); templates for other industries (ONB-06, later); staff-handoff escalations (FEAT-043) mark gaps through the same `markQuestionGap` when they own an "escalated" question.

## 9. Self-check

KB-09 → AC-2–AC-6, AC-9, AC-10; KB-18 (coverage-gap source) → AC-5, AC-7; UC-16 3b → AC-7; UC-03 7 and UC-13 4 → AC-2, AC-3, AC-10; ADR-005 → AC-1; ADR-014/015 → AC-8. Contract changes are additive; FEAT-018's routes keep their shapes. Tasks run schema → contracts → inbox and agent → kb and tenancy → scheduler → api → UI → E2E → verify.
