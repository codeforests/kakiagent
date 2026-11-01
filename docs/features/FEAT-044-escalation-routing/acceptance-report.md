# Acceptance report: FEAT-044 — Escalation routing, "talk to a person", reminders

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-11-01 by an independent verify session · Branch `feat/FEAT-044-escalation-routing` · PR #48

## Verdict summary

**Rework.** In GitHub CI, on Chromium, the visitor never sees "Mei Ling joined the chat." after Mei Ling takes over an escalated conversation. This failed twice in a row on `23975a8` (run 95, attempt 1 and its re-run), while Firefox and WebKit pass the same test. This breaks AC-1 ("hides the item until staff join": the visitor must learn that staff joined) and AC-10, on the most common visitor browser. Everything else holds: every criterion has a test that asserts what it says, no test was weakened, and every local check and the CI integration suite (including the Docker-only suites) is green. No RTM write until the rework is accepted.

## Audit standard

Re-derived from SRS v0.4: INB-05 ("round-robin or a specific person; notifies by email/Telegram and web push; reminders if not picked up within N minutes (default 10, configurable)"; "unclaimed escalations trigger reminders until claimed. After hours, the visitor is told when staff will respond"), CHN-13 ("an always-visible 'talk to a person' option … triggers escalation (INB-05)"), AGT-06, AGT-04, AGT-09, INB-01, LED-04 and §1.4 (urgent bypasses quiet hours), UC-23 1, 2, 2a, 2b. Also ADR-005, ADR-012, ADR-013, ADR-014, ADR-015 and ADR-025, plus technical-design §6 AC-1..AC-10 and D1–D9. Every INB-05 and CHN-13 clause maps to an AC (§9 holds). D1 (not urgent after hours) is Ken's decision and is consistent with §1.4: once the visitor has been told the return time, nobody is waiting live.

## Audit table

| AC | Source | Test(s) | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | CHN-13; UC-23 1 | widget `chat.test` (pending from notices, menu items per state, notice dedupe); api `escalation.int` "Talk to a person: escalates…", "with a person: with_person; closed: 409; another visitor or tenant: 404", "widget config offers Talk to a person while live, not while paused"; inbox `escalation.int` "escalates once" (a repeat gives `already_escalated`, with no second notice or alert); E2E `escalation.e2e` main test | Yes. The 2 s notice bound is the E2E's default expect timeout on the widget notice, which is indicative only | Pass (local + CI E2E) |
| AC-2 | AGT-06; UC-23 1; ADR-025 | agent `escalation.int` (escalate-only path: the notice is the reply; audits `escalation.assigned`, `agent.dispatch {task:'escalate', outcome:'done'}`, `agent.decision`; a redelivered job does nothing; the 中文 notice; "price and call me" answered and escalated); `dispatch.test` (handler refused in coaching scope); evals `feat-044-escalation.json` (EN, Singlish, two 中文 phrasings, after hours, with a question, not-a-request) | Yes | Pass |
| AC-3 | INB-05 routing | inbox `escalation.int` routing: round-robin A B C A; concurrent requests on two clients go to different members with one escalation each; person mode; inactive person falls back; api "a person who left shows as inactive" | Yes | Pass |
| AC-4 | INB-05 notify; LED-04; D1 | inbox "escalates once" (one urgent alert to the assignee); "unverified … quiet; a visitor asking then makes it urgent once" (dedupe keys `escalation:<id>` then `:urgent`); "after hours: not urgent"; E2E alert reaches Mailpit | Yes | Pass |
| AC-5 | INB-05 reminders; UC-23 2b; D6, D7 | inbox reminders: reminders 1 and 2 go to the assignee, and from reminder 3 owners and admins too, every N business minutes; deactivated assignee re-routed; reminder after take-over resolves and sends nothing; queue marks each due escalation once; take-over cancels pending and held alerts; each close path resolves; db `rls.int` reminder queue across tenants; api 422 for out-of-range minutes; platform `notifications.int` muted escalation skips `escalation_reminder` | Yes | Pass |
| AC-6 | INB-05 after hours; AGT-09; UC-23 2a; D5 | inbox "after hours: … the notice gives the next opening, the reminder clock starts at opening" (fixed clock, 08:00 → 08:10); "auto-close skips an escalated conversation"; db `rls.int` auto-close; tenancy `hours.test` `addBusinessMinutes`; api after-hours case; eval `escalate-after-hours` | Yes | Pass |
| AC-7 | INB-01; FEAT-043 D7 | inbox views: the assignee filter matches the owner, else the open escalation's assignee; one "escalated" divider naming the assignee; api "escalated rows carry the escalation and match assignee=<id>"; dashboard `inbox.test` (`waitingFor`, `escalationText`, `matchesView`); E2E row, strip and divider | Yes | Pass (local + CI E2E) |
| AC-8 | AGT-04; AGT-11 | agent `texts.test` (unsure and disclosure texts, EN and 中文); persona and boundary int tests updated to the new disclosure; evals feat-023 and feat-024 updated | Yes | Pass |
| AC-9 | ADR-005, ADR-014, ADR-015 | db `rls.int`: tenant B sees, writes and resolves nothing of A's; one open escalation per conversation; `escalation_candidates()` returns only the current tenant's active members and isn't executable by identity or outbox; inbox "tenant B neither sees nor routes to tenant A's"; api 404/403 cases and an agent refused on PUT; audit payloads asserted to hold IDs and codes only | Yes | Pass |
| AC-10 | SCR-WGT-002, SCR-APP-014, -015, -045; NFR-09, NFR-19 | E2E `escalation.e2e` "at phone width, the widget menu and the Team card fit" (axe, `scrollWidth ≤ 375`) and the main test's screens; dashboard `escalation.test` (card form helpers) | Yes. The Team card's saving, error and toast states are asserted at the helpers and in the build's stubbed check, not in E2E | Pass (CI E2E) |

## Changed existing tests (reviewed, not weakened)

- `widget-controls.e2e.ts`: the menu now always holds Talk to a person while live (CHN-13 "always-visible"), so the "no menu before a conversation" step and the one-item count became Talk to a person first and two items. The privacy and end-chat paths are still asserted.
- Disclosure and unsure texts (`texts.test`, `answer.test`, `language.test`, persona and boundary int tests, `assistant.e2e.ts`, eval cases feat-023 and feat-024): exact strings updated to AC-8's new wording. The assertions are as strict as before.
- `dispatch.test`: `escalate` moves from `unhandled` to a registered handler, and the registry keys gain `escalate`.
- `feat-004-multi-task.json` "escalate" case: an escalate-only plan now replies with the escalation notice (§5.4), so `reply.simple` + `prices-from-facts` became `outcome: escalated`. The question-plus-escalate case in feat-044 still checks prices from facts.
- `notifications.int`: one extra muted `escalation_reminder` row, with the counts raised to match (D6).
- The diff adds no `.skip`, `.only`, `.todo` or `fixme`.

## Corrected tests

- `escalation.e2e.ts` setup (`23975a8`): CI run 94 failed at the first step because the spec PUT Mei Ling's (an Agent's) alert preferences with `approval_pending`, and FEAT-052 D9 refuses that with a 403. The setup now leaves that event out (events not listed keep their stored setting). No assertion changed.

## Independent execution

`scripts/test-env.sh scripts/check-summary.sh` (Postgres 16 + pgvector, no Docker), 2026-11-01, at `03effa5`:
- Green: `pnpm format:check`, `pnpm lint` (ESLint + dependency-cruiser), `pnpm typecheck`, and `pnpm test` (117 files, 1451 tests, including the widget and dashboard).
- Integration green: db (183 tests), inbox `test:coverage` (71), agent `test:coverage` (474), tenancy `test:coverage` (65), contracts (42), scheduler-worker (10), `pnpm eval --fast`, `pnpm build` and `pnpm size` (loader 4.43 KB gz, panel 13.38 KB gz, initial 4.43 KB gz).
- platform (296 passed) and api integration (354 passed) are green apart from the Docker-only suites: `rate-limit.int` needs Valkey and `uploads.int` needs LocalStack. This feature touches neither, and both run in CI.

## Direct verification

- Model interprets, code acts (ADR-025): typed requests go triage → `escalate` task → dispatcher handler → `ConversationPort.escalate`. The button bypasses the model through its own widget route (D8). Both end in `requestEscalation`.
- Cross-zone member read: `escalation_candidates()` is SECURITY DEFINER, owned by a NOLOGIN role with column grants on `memberships` (IDs, role, status) and a tenant policy, with `search_path` pinned. EXECUTE is granted to the visitor and dashboard roles only.
- Timers are in Postgres (`next_reminder_at`), queued through the outbox by `inbox_queue_escalation_reminders()`, and the reminder job is idempotent (ADR-012). Alerts are written in the escalation's transaction (FEAT-052 D2).
- Both new tables are in `TENANT_SCOPED_TABLES` with forced RLS. Audit payloads hold IDs and codes only (ADR-014).
- The send gate is unchanged: the AI keeps answering while escalated (D9, ADR-013).

## Findings

- **R1 (rework, AC-1, AC-10; Chromium only).** In `escalation.e2e.ts:159-161`, after the take-over (`thread-dock` shows `data-mode="mine"`, the strip is gone), the check `visitor.panel.locator('.notice', { hasText: 'Mei Ling joined the chat.' })` finds no element within 2 s. CI run 95 (`23975a8`) failed this way on Chromium twice: job 124763046573, then the re-run job 124815466719. The trace and error context are in the `playwright-chromium` artifact of run 41277552542. FEAT-043's `takeover.e2e.ts` passes the same assertion on Chromium. The differences in this flow: the conversation is created by Talk to a person, before any visitor message (`panel.tsx` `talkToPerson`, which sets `conversationId` and then escalates while the SSE `useEffect` connects), it is escalated, and three browser contexts are open. The server side looks right on reading: `takeOver` writes `staff_joined` and `inbox.ts` publishes it on the conversation channel. So start from the trace: is the visitor's EventSource open and receiving at take-over time? Is there a race between `setConversationId`, the SSE replay and the escalate response?
- Also on that re-run, `widget-controls.e2e.ts:124` (the chrome language switches back to `en`) failed once on Chromium. It passed on run 95's first attempt and on Firefox and WebKit, so it is not counted as a finding. Worth a look while in the widget.
- Note (from the build): the abuse rule (`endAiConversation`) still ends only `ai` chats, so repeated abuse in an escalated chat warns but doesn't end the chat. This is outside FEAT-044's criteria (in pending-actions).
- Note for Ken: D5 (escalated widget chats aren't auto-closed while unclaimed) departs from the letter of INB-08 ("widget 30 minutes"). The design records it, and it is needed for INB-05's "until claimed" (in pending-actions).

## RTM

Not written (rework). On acceptance, append Test ref: INB-05 (partial: email; Telegram FEAT-037, web push FEAT-048); CHN-13 (talk to a person; after-hours lead capture FEAT-049); AGT-06 (partial: `escalate_to_human`); AGT-04 and AGT-09 (partial; lead capture FEAT-049); INB-01 (assignee = owner, else escalation assignee).

## CI

- Run 94 (`03effa5`): Chromium E2E failed at the spec's setup (an Agent's preferences PUT with approval alerts, 403). Corrected in `23975a8` (Corrected tests). The rest of run 94 was cancelled.
- Run 95 (`23975a8`): green on unit, lint and typecheck, build and size, eval, integration with coverage (including `rate-limit.int` and `uploads.int`), Terraform, scanning, workflow lint, and E2E on Firefox and WebKit. E2E on Chromium failed twice: R1.
