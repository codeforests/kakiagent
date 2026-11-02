# Acceptance report: FEAT-045 — AI-suggested replies for staff (verified)

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-11-02 by an independent verify session · Branch `feat/FEAT-045-suggested-replies` · PR #50

## Verdict summary

**Accepted** (2026-11-02). Every criterion AC-1..AC-9 has a test that asserts what it says, all local checks are green at `b328451` (the only red is the LocalStack-only `uploads.int`, unrelated), no existing test was changed or weakened, and the invariants hold (Direct verification). GitHub CI run 98 is green in all 11 jobs, including E2E on all three browsers.

## Audit standard

Re-derived from SRS v0.4: INB-03 ("AI-suggested replies for staff, draft only; staff can edit and then send; suggestions pass the same AGT-02 checks"), KB-18 (the staff-edit producer of the correction queue; "nothing changes the KB until accepted"), UC-23 step 4 and alternate 4a, GOV-08 (pause), AGT-14. Also ADR-005, ADR-007, ADR-008, ADR-009, ADR-010, ADR-014, ADR-015, ADR-025, and technical-design §6 AC-1..AC-9 with D1–D10. Every INB-03 clause maps to an AC (§9 holds). KB-18 and UC-23 4a stay partial by design: the `staff_reply` producer (a staff answer that fills a gap) is a later feature (§8). D1 (synchronous in the API, against ADR-026's "agent-worker") follows replay's precedent and is recorded in §8 for the next architecture revision.

## Audit table

| AC | Source | Test(s) | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | INB-03; UC-23 4 | agent `suggest.int` "a price question…" (ready draft, slot price, fact IDs; message count and outbox count unchanged), "answers a Chinese question in Chinese", "answers the latest visitor message and supersedes the open draft"; api `suggestion.int` "201 with a checked draft and its fact chips; nothing sent"; E2E `suggested-reply.e2e` (visitor sees no staff message before Send) | Yes | Pass (local; E2E in CI) |
| AC-2 | INB-03 "same AGT-02 checks" | agent `suggest.int` "a reply that types a literal price twice gives no draft" (body null), "never uses a needs_review fact", "a blocked topic and a crisis give no draft" (and the crisis doesn't flag the conversation: no side effects); evals `feat-045-suggest.json` | Yes. The path is `answerStep`, shared with coaching and replay (code read: `suggest.ts` calls it with caller meta, nothing copied from `turn.ts`) | Pass |
| AC-3 | INB-03 "edit and then send" | inbox `suggestions.int` "unedited (case, spacing, trailing punctuation only)…", "edited: sent_edited, no facts on the message"; api `suggestion.int` "unedited: the message carries the draft facts", "edited: … factIds []"; dashboard `suggestion.test` (`sendBody` carries the ID only while the text came from a draft); E2E edit and Send | Yes | Pass (local; E2E in CI) |
| AC-4 | KB-18; UC-23 4a | api `suggestion.int` "edited: one open staff_edit item… a retry adds none; accepted as an FAQ" (list row, item context with question/draft/sent/facts, bare accept 422, FAQ accept approved); inbox `suggestions.int` "a used, superseded…is ignored", "a retried send records nothing again"; kb `queue.int` "one open staff_edit item per suggestion…"; db `rls.int` "one reply_edit correction per suggestion"; inbox unit `normalise` (D8); dashboard `corrections.test` staff edit items; E2E corrections row, item, prefilled FAQ, "FAQ added" | Yes | Pass (local; E2E in CI) |
| AC-5 | UC-23 3–4; design.md §4.6; GOV-08 | agent `suggest.int` refusals; api `suggestion.int` "409 not_owner, ai_paused, nothing_to_answer" (exact bodies); dashboard `suggestion.test` "maps refusals to the dock states"; E2E Suggest from the takeover bar → `data-mode` `mine` | Yes. The disabled control while paused is checked by the T5 stubbed-API script (tasks.md evidence), not by E2E | Pass |
| AC-6 | D5; ADR-007 cost | agent `suggest.int` 11th refused with `retryAfterS` > 3500; api `suggestion.int` "429 with Retry-After after 10"; agent `suggest.int` first case: usage rows carry the conversation ID and no coaching session | Yes | Pass |
| AC-7 | ADR-005/009/014/015 | db `rls.int` "tenant B sees and writes nothing of tenant A's; the visitor zone has no grant", "the dashboard updates only fact_ids, only on staff messages"; api `suggestion.int` "404 for another tenant on both routes"; inbox `suggestions.int` "masks the draft"; agent `suggest.int` audit payload IDs and codes, no price | Yes | Pass |
| AC-8 | SCR-APP-015/021/022; NFR-09; NFR-19 | E2E `suggested-reply.e2e` (label text, focus, `aria-describedby`, fact links, Suggest again, axe at 1280 and 375×5000, no sideways scroll at 375, row and item texts, Open conversation link); T5/T6 stubbed-API scripts for the none, 429, replace-confirm and paused states | Yes for the main path; the alternate dock states rest on unit tests and the stubbed scripts | CI E2E |
| AC-9 | AGT-14 | `pnpm eval --fast`: 155 cases, every subset at 1.000, thresholds unchanged | Yes (the suggestion cases score the answer path's outcome, which `suggestionOutcome` maps; that mapping has its own unit test) | Pass |

## Changed existing tests (reviewed, not weakened)

None removed or loosened: `git diff origin/main...HEAD` on test files has no deleted lines and no `.skip`/`.only`. Additions only (`corrections.int` gains two lines of setup, `rls.int` a new describe, `queue.int` a new describe, `corrections.test` a new describe).

## Corrected tests

None.

## Independent execution

`scripts/test-env.sh scripts/check-summary.sh` (Postgres 16 + pgvector, no Docker), 2026-11-02, at `b328451`:
- Green: `pnpm format:check`, `pnpm lint` (ESLint, dependency-cruiser, RTM check), `pnpm typecheck`, `pnpm test` (121 files, 1474 tests).
- Integration with coverage green: db (187), inbox (89), kb (372), agent (483); `pnpm eval --fast`.
- api `test:coverage`: 373 passed; the only failing file is `uploads.int` (needs LocalStack or `KAKI_TEST_S3_ENDPOINT`, unrelated, runs in CI). The dashboard has no `test:coverage` script; its unit tests ran in `pnpm test`.

## Direct verification

- Model interprets, code acts (ADR-025): the suggestion's plan runs through `dispatchPlan(replayRegistry, …)` with `ReplayPorts`, so no escalation, lead or flag; a crisis `endTurn` gives no draft (test asserts the conversation isn't flagged).
- Protected values (ADR-008): the draft is `answerStep`'s verified, slot-rendered text; a failing draft is stored with a null body (check `(outcome = 'ready') = (body is not null)`), so unchecked text can't be returned. Only unedited sends carry fact IDs.
- Facts (ADR-010): retrieval is `searchCoachingFacts(…, { includeUnreviewed: false })`; a staff edit only proposes a `reply_edit` correction, accepted only as an FAQ.
- Tenant isolation (ADR-005, ADR-009): `suggestions` forced RLS with policy, in `TENANT_SCOPED_TABLES`, dashboard grants only; the new `UPDATE (fact_ids)` on `messages` is restricted to staff rows by a restrictive policy (the dashboard had no earlier UPDATE grant on `messages`). Tenant ID comes from the session.
- Kill switch (GOV-08, D9): checked in `prepare` before any model call.
- Audit (ADR-014): `inbox.suggestion.created`/`sent` and `correction.proposed` payloads hold IDs and codes; the correction carries no text (D6).

## Findings

None blocking. Observations for later (also noted in `pending-actions.md`):
- O1: the D5 rate limit is checked in the prepare transaction and the row stored after the model calls, so two concurrent requests at the 10th slot could both pass (at most a few extra drafts; cost bound only).
- O2: ADR-026 still names the agent-worker for suggested replies (§8 escalation, for the next architecture revision).

## RTM

Test ref appended 2026-11-02: INB-03; KB-18 (partial: staff-edit producer; `staff_reply` gap producer later); AGT-02 (partial: suggested replies pass the same checks). `node scripts/check-rtm.mjs FEAT-045 --stage verify`: `RTM check passed (FEAT-045).`

## CI

GitHub CI run 98 (`workflow_dispatch`, https://github.com/codeforests/kakiagent/actions/runs/41457860757) at `b328451`, 2026-11-02: all 11 jobs green, including integration with coverage (Testcontainers, so `uploads.int` with LocalStack too), the eval, build and size, and E2E on Chromium, Firefox and WebKit (`suggested-reply.e2e` with axe at 1280 and 375). The later verify commit changes docs only.
