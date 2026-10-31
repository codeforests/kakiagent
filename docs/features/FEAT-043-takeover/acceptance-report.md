# Acceptance report: FEAT-043 — Take over and hand back, single owner

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-10-31 by an independent verify session · Branch `feat/FEAT-043-takeover` · PR #45

## Verdict summary

**Accepted.** INB-02 and INB-09 are met in full; INB-01 gains its "by assignee" filter (by current owner; FEAT-044 widens it to escalation assignees, D7), which completes INB-01. UC-23 steps 3 and 5 and exception 3a are realised. Every criterion has a test that asserts what it says; no test was weakened, and no correction was needed. Every local result below was produced in this session; E2E (`takeover.e2e.ts`, 2 tests, plus the `inbox.e2e.ts` regression after the socket moved to the shell) ran in GitHub CI (CI).

## Audit standard

Re-derived from SRS v0.4 INB-02 ("staff can pause the AI in a conversation and reply directly; hand back to the AI when done"; "while a human has taken over, the AI does not send any messages"; "the visitor sees a 'staff joined' notice"), INB-09 ("only one staff member can own a taken-over conversation at a time; others see who owns it and can request it"; "when two staff press take over at the same moment, exactly one succeeds and the other is told who has it"), INB-01's "by assignee" filter, INB-08's "recorded in the audit log", UC-23 3, 3a, 5, ADR-013 d2/d3, ADR-014, ADR-015 and technical-design §6 AC-1..AC-10, D1–D9. Every clause maps to an AC (§9 holds). D1 (owners and admins can take from the owner, Ken 2026-10-31) extends INB-09 without contradicting it: agents can still only request. D5 changes FEAT-042's grant assertion on `last_message_at` by design (staff replies are activity); the test was rewritten to assert the new grant and still refuses `flag_reasons` and `auto_close_queued_at`, so it is not weakened. D7 ("assignee" = current owner) is the only reading possible before FEAT-044 creates escalation assignees.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | INB-02 take over and reply; UC-23 3 | inbox `ownership.int` (take over from ai/escalated/approval → human, owner row); api `takeover.int` "takes over…", "the owner replies (idempotent, masked)…"; widget `chat.test` (staff name row); `takeover.e2e` test 1 (reply in the widget ≤ 2 s, `.who` = Mei Ling) | Yes: the 2 s bound is the E2E `LIVE` timeout on the widget assertion | Pass (CI E2E) |
| AC-2 | INB-02 "AI does not send"; ADR-013 d3 | agent `gate.test` (owner row closes the gate on status `ai`); `turn.int` "stays silent while staff own it…" (no stored reply, `generate` calls 0) and "a take-over mid-reply releases nothing further" (one segment, `gate_closed`); api `takeover.int` no AI reply; E2E 5 s with no reply or typing | Yes: the mid-stream clause is exercised, not just the pre-turn gate | Pass |
| AC-3 | INB-02 "staff joined" notice | inbox `ownership.int` (notice follows the conversation's language; fallback without a name); api `takeover.int` "A team member…, never the email"; widget `chat.test`; E2E widget notice and "Visitor saw: …" | Yes | Pass |
| AC-4 | INB-02 hand back; UC-23 5 | inbox `ownership.int` "the owner hands back: ai, no row, a left notice"; `turn.int` answered after hand-back; E2E left notice and the next message answered | Yes | Pass |
| AC-5 | INB-09 race; UC-23 3a; ADR-013 d2 | inbox `ownership.int` two concurrent `takeOver`s (`allSettled`: one fulfilled, the other `OwnedError` naming the row's user, version 1); api `takeover.int` parallel pair (200 + 409 `owned` with the winner's owner); dashboard `inbox.test` `takeoverErrorText` | Yes: decided by `on conflict do nothing` in Postgres, not by app locking | Pass |
| AC-6 | INB-09 one owner, see, request; D1, D6 | inbox `ownership.int` (refused hand-back, request audits, only the owner closes); api `takeover.int` conflicts, request + divider, take-from for owners/admins only (403 for agents); realtime `ws.int` member event only to that member; E2E owned bar, no Close, take-from dialog, request toast | Yes | Pass |
| AC-7 | INB-01 by assignee | inbox `ownership.int` filter by owner/none with owner on rows; api `takeover.int` me/none/member and members list; dashboard `inbox.test` URL ↔ assignee, `matchesView`; E2E "Mine" | Yes; keyset paging reuses FEAT-042's cursor (views suite green) | Pass |
| AC-8 | INB-08 audit; ADR-014 | inbox `ownership.int` (one entry each, IDs and codes only; owner removed by staff close, auto-close, visitor end, abuse) | Yes: every close path named in design §2 is covered | Pass |
| AC-9 | ADR-005, ADR-009, ADR-015 | db `rls.int` FEAT-043 block (tenant B sees/deletes nothing; dashboard inserts only staff/system; staff author ID only on staff/system; four notice kinds); api cross-tenant 404s and sign-in/2FA refusals; inbox staff message masked | Yes | Pass |
| AC-10 | SCR-APP-015, SCR-APP-014, SCR-WGT-002, NFR-09, NFR-19 | E2E: axe on five states (desktop owner, owned-by-other, request, widget left, phone), no horizontal scroll at 375 with a tall viewport; build session's stubbed Chromium runs for focus moves | Yes | Pass (CI E2E) |

## Corrected tests

None. The test diff against `origin/main` was reviewed: the only removed lines in existing tests are fixture shapes widened with the new fields (`assignee: null`, `authorUserId: null`), a reformatted `eventText` call and replaced imports. The one changed assertion (the `last_message_at` grant) is D5's design change and still refuses the other columns.

## Independent execution

Fresh in this session at `868a985`: `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser), `pnpm typecheck`, `pnpm test` (24/24 tasks) pass. `test:coverage` through `scripts/test-env.sh` with `--workspace-concurrency=1`: db (174), inbox (106), identity (54), agent (465) pass with thresholds; api 349 pass, 1 fails: `uploads.int.test.ts` "S3 presigner" needs LocalStack (no Docker here; FEAT-012's suite, untouched by this feature), so api's threshold is checked in CI. realtime integration (8) passes; widget build and `pnpm size`: loader 4.43 kB, panel 12.99 kB, initial 4.43 kB gz, all within budget.

## Direct verification

- Migration `0043_takeover.sql`: forced RLS and the tenant policy on `conversation_owners`, its name in `TENANT_SCOPED_TABLES`; the visitor zone has only SELECT/DELETE on owners; the restrictive `messages_dashboard_authors` policy narrows the dashboard's inserts.
- Routes take the tenant from the session (`s.tenantId`) only; take-from checks `inbox.reassign`; staff text goes through `piiMask` before storage; audit payloads are codes (`auditCode`).
- The gate reads the owner row and the status together (`conversationOpen`), so a stray owner row on an `ai` conversation still silences the AI.

## Findings

None blocking. Carried forward (design §8): FEAT-044 must stop escalation reminders when a conversation has an owner and widen the assignee filter; FEAT-055 decides whether hand-back during a pending approval returns to `waiting_approval`; channel delivery of staff messages arrives with FEAT-036+.

## RTM

Test ref appended for INB-02 and INB-09 (this report) and INB-01 (assignee filter now covered, completing it).

## CI

GitHub CI on `feat/FEAT-043-takeover`: see below.
