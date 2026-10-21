# Tasks: FEAT-023 — Language and register, out-of-scope handling, after-hours behaviour

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: in progress · Last updated: 2026-10-21

- [x] T1 — Schema: `business_profiles.hours` and `open_on_public_holidays`, `messages.notice` and `notice_kind` with their checks (drizzle schema + `0012`), and `0013` recreating `visitor_tenant_state()` with the hours (design §4)
      Done when: `pnpm db:setup` applies 0012–0013 on the running stack; the RLS suite passes with new cases: the function returns the current tenant's hours only, the visitor role still can't select `business_profiles`, the notice check rejects a notice without a kind and an unknown kind, and tenant B can't read tenant A's notices.
- [ ] T2 — Tenancy: `WeeklyHours`, SGT day helpers, `openStatus`, the SG holiday calendar, and `visitorTenantState` with hours (design §5.1; AC-6)
      Done when: unit tests for every AC-6 case pass (open, overnight, weekend, split day, 24:00 merge, holiday closed and open, the Monday in lieu, SGT midnight and the year end, nothing in 14 days, invalid hours → null), and a tenancy integration test reads hours through `visitorTenantState`.
- [ ] T3 — Agent language: `replyLanguage`, `texts(lang)` in en and zh, the prompt's language and register lines and the hours lines (design §5.2; D4, D5; AC-1)
      Done when: unit tests pass for `replyLanguage` on every plan language and the fallback plan, both text tables, and the prompt: tail names language and register, `system` byte-identical across languages, registers and times, and different when the hours change.
- [ ] T4 — Agent system slots and verifier: `[[s:…]]` rendering in both languages (intervals, holidays, `next_open`), unknown system slots, the D7 verifier exceptions, the fake responder's Chinese and hours answers and the fake triager's `out_of_scope` rule (design §5.2; D7; AC-2, AC-3, AC-8)
      Done when: unit tests pass for each rendered value in en and zh, `unknown_field` for an unknown or unavailable system slot, the AC-2 and AC-3 verifier cases (blocked and allowed), and the fake responder's answers passing the verifier in both languages.
- [ ] T5 — Agent dispatch and reply plan: `TaskResult.reply`, `dispatchPlan` replies, the `out_of_scope` handler in `visitorRegistry`, `replyPlan` and `answerTurn` (design §5.3; D1, D9; AC-4, AC-5)
      Done when: unit tests pass for each `replyPlan` rule (out-of-scope only, mixed, unsure, confident with no facts, facts with low confidence, `[escalate]` unchanged) and for `answerTurn` releasing fixed texts through the gate and the closing segment after a verified reply, with no reply-model call where the design says none.
- [ ] T6 — Agent turn and inbox: language through the turn, the after-hours notice once per closed period, `noticeSince`, `appendAgentReply` notice, `Message.notice` in contracts, the audit payload and the worker log line (design §5.4, §5.5; D6; AC-2, AC-4, AC-5, AC-7, AC-9)
      Done when: agent integration tests pass: a Chinese turn stores Chinese disclosure and reply; an out-of-scope-only turn has no reply usage row; an unsure turn; a closed turn stores the notice and still cites its fact; the next turn in the same closed period has none; after a reopening it returns; a paused tenant's fallback carries it; a human-owned conversation stores nothing; the audit entries carry the new codes and no text.
- [ ] T7 — Dev seed: bakery hours and holiday flag; none for the second tenant (design §5.8)
      Done when: `pnpm db:setup` is idempotent with the new seed and a local widget question at the bakery gets the hours from the profile.
- [ ] T8 — Evals: fixture hours, case `at` and `needs`, the new deterministic expectations and the `retrieval` subset, the runner on `answerTurn` with the notice and the registry-aware dispatch check, the four case files, the judge, `version.json` and the agreement sample with its checks (design §5.7; D8; AC-3, AC-5, AC-11)
      Done when: `pnpm eval` and `pnpm eval --fast` pass every threshold with the existing cases unchanged; a deliberately wrong recorded output in a new case drops its subset below threshold (then restored); judge unit tests cover verdict parsing, fail-closed, the agreement maths, the draft refusal and the static sample checks.
- [ ] T9 — Widget: the after-hours `system-notice` row and `lang="zh-Hans"` on Chinese bubbles (design §5.6; ui-design.md; AC-12 UI half)
      Done when: widget unit tests pass for the language rule and the notice ordering, `pnpm build && pnpm size` stays within budget, and the panel renders the notice state in the browser at 390 px and desktop.
- [ ] T10 — E2E: `e2e/tests/language.e2e.ts`: the Chinese weekend-hours answer, the out-of-scope refusal, and the after-hours notice once per closed period with the bakery's hours set for the test and restored, axe on the panel with the notice (AC-12; UC-20, J7)
      Done when: the new spec and the existing E2E suite pass on Chromium against the local stack.
- [ ] T11 — Verify: every AC in design §6 demonstrably passes; format, lint and boundaries, typecheck, unit, integration with coverage, build and size, E2E, evals and audit green; scaffold notes, RTM design ref and the manifest updated
      Done when: all of the above pass in one fresh run, with the evidence recorded here.
