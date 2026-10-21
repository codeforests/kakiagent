# Tasks: FEAT-023 — Language and register, out-of-scope handling, after-hours behaviour

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: developer-done · Last updated: 2026-10-21

- [x] T1 — Schema: `business_profiles.hours` and `open_on_public_holidays`, `messages.notice` and `notice_kind` with their checks (drizzle schema + `0012`), and `0013` recreating `visitor_tenant_state()` with the hours (design §4)
      Done when: `pnpm db:setup` applies 0012–0013 on the running stack; the RLS suite passes with new cases: the function returns the current tenant's hours only, the visitor role still can't select `business_profiles`, the notice check rejects a notice without a kind and an unknown kind, and tenant B can't read tenant A's notices.
- [x] T2 — Tenancy: `WeeklyHours`, SGT day helpers, `openStatus`, the SG holiday calendar, and `visitorTenantState` with hours (design §5.1; AC-6)
      Done when: unit tests for every AC-6 case pass (open, overnight, weekend, split day, 24:00 merge, holiday closed and open, the Monday in lieu, SGT midnight and the year end, nothing in 14 days, invalid hours → null), and a tenancy integration test reads hours through `visitorTenantState`.
- [x] T3 — Agent language: `replyLanguage`, `texts(lang)` in en and zh, the prompt's language and register lines and the hours lines (design §5.2; D4, D5; AC-1)
      Done when: unit tests pass for `replyLanguage` on every plan language and the fallback plan, both text tables, and the prompt: tail names language and register, `system` byte-identical across languages, registers and times, and different when the hours change.
- [x] T4 — Agent system slots and verifier: `[[s:…]]` rendering in both languages (intervals, holidays, `next_open`), unknown system slots, the D7 verifier exceptions, the fake responder's Chinese and hours answers and the fake triager's `out_of_scope` rule (design §5.2; D7; AC-2, AC-3, AC-8)
      Done when: unit tests pass for each rendered value in en and zh, `unknown_field` for an unknown or unavailable system slot, the AC-2 and AC-3 verifier cases (blocked and allowed), and the fake responder's answers passing the verifier in both languages.
- [x] T5 — Agent dispatch and reply plan: `TaskResult.reply`, `dispatchPlan` replies, the `out_of_scope` handler in `visitorRegistry`, `replyPlan` and `answerTurn` (design §5.3; D1, D9; AC-4, AC-5)
      Done when: unit tests pass for each `replyPlan` rule (out-of-scope only, mixed, unsure, confident with no facts, facts with low confidence, `[escalate]` unchanged) and for `answerTurn` releasing fixed texts through the gate and the closing segment after a verified reply, with no reply-model call where the design says none.
- [x] T6 — Agent turn and inbox: language through the turn, the after-hours notice once per closed period, `noticeSince`, `appendAgentReply` notice, `Message.notice` in contracts, the audit payload and the worker log line (design §5.4, §5.5; D6; AC-2, AC-4, AC-5, AC-7, AC-9)
      Done when: agent integration tests pass: a Chinese turn stores Chinese disclosure and reply; an out-of-scope-only turn has no reply usage row; an unsure turn; a closed turn stores the notice and still cites its fact; the next turn in the same closed period has none; after a reopening it returns; a paused tenant's fallback carries it; a human-owned conversation stores nothing; the audit entries carry the new codes and no text.
- [x] T7 — Dev seed: bakery hours and holiday flag; none for the second tenant (design §5.8)
      Done when: `pnpm db:setup` is idempotent with the new seed and a local widget question at the bakery gets the hours from the profile.
- [x] T8 — Evals: fixture hours, case `at` and `needs`, the new deterministic expectations and the `retrieval` subset, the runner on `answerTurn` with the notice and the registry-aware dispatch check, the four case files, the judge, `version.json` and the agreement sample with its checks (design §5.7; D8; AC-3, AC-5, AC-11)
      Done when: `pnpm eval` and `pnpm eval --fast` pass every threshold with the existing cases unchanged; a deliberately wrong recorded output in a new case drops its subset below threshold (then restored); judge unit tests cover verdict parsing, fail-closed, the agreement maths, the draft refusal and the static sample checks.
- [x] T9 — Widget: the after-hours `system-notice` row and `lang="zh-Hans"` on Chinese bubbles (design §5.6; ui-design.md; AC-12 UI half)
      Done when: widget unit tests pass for the language rule and the notice ordering, `pnpm build && pnpm size` stays within budget, and the panel renders the notice state in the browser at 390 px and desktop.
- [x] T10 — E2E: `e2e/tests/language.e2e.ts`: the Chinese weekend-hours answer, the out-of-scope refusal, and the after-hours notice once per closed period with the bakery's hours set for the test and restored, axe on the panel with the notice (AC-12; UC-20, J7)
      Done when: the new spec and the existing E2E suite pass on Chromium against the local stack.
- [x] T11 — Verify: every AC in design §6 demonstrably passes; format, lint and boundaries, typecheck, unit, integration with coverage, build and size, E2E, evals and audit green; scaffold notes, RTM design ref and the manifest updated
      Done when: all of the above pass in one fresh run, with the evidence recorded here.

## Notes

- **T8, one existing case moved (recorded, not hidden).** `ground-no-fact` ("What time do you open on Sunday?", expects "check with the team" and no cited facts) was written when hours were not known anywhere. With the bakery fixture's hours (§5.7), the correct reply is now the Sunday hours from the `[[s:hours.*]]` slots, so the case as written would demand the wrong behaviour. It now runs on the `second` fixture tenant, which has no hours, so it still tests what it was written for (no fact, no guess). Its expectations are unchanged; every other existing case is unchanged. The bakery's hours answers are covered by the new Singlish, Chinese and after-hours cases.
- **T8, evidence.** `pnpm eval`: 154 cases (4 pure-Chinese retrieval cases skipped until the multilingual embedder, P3), every subset at 1.000; 11 judge expectations reported pending; agreement sample 8 items for 11 judge expectations (static checks pass). `pnpm eval --fast`: 98 cases, every subset at 1.000. With `oos-mixed-fudge-weather` given a typed-price recorded output, `out-of-scope` fell to 17/18 = 0.944 (below 0.95) and the run exited 1; restored. The judge's unit tests (7) cover verdict parsing, fail-closed, the agreement maths (a missing verdict disagrees), the draft refusal and the static sample checks.
- **Agreement labels are drafts.** `evals/labels/agreement-sample.json` was labelled by the implementer and is marked `draft`; the real-judge run refuses it until the owner confirms each label (technical design §8, before M1.5).
- **T9, evidence.** Widget unit tests 8 pass (row order disclosure → notice → bubble; `lang="zh-Hans"` rule). `pnpm build && pnpm size`: loader 1.75 KB gz, panel 9.48 KB gz, initial load 1.75 KB gz, all within budget. On the local stack the panel was rendered closed at 390 px (Chinese question: Chinese disclosure, Chinese notice with 明天上午9:00, Chinese reply) and at 1280 px (English); the notice wraps without truncation and sits between the disclosure and the reply.
- **T10, evidence.** `e2e/tests/language.e2e.ts` (3 tests) passes on Chromium against the local stack (compose, `pnpm db:setup`, `pnpm dev`); the after-hours test sets the bakery closed for the rest of today and restores the seeded hours in `finally`.

## Verification evidence (T11, 2026-10-21, one fresh run)

The local stack ran under Docker in this session (compose, `pnpm db:setup`, `pnpm dev`), so the integration suites that need Valkey and S3 ran too.

| Check | Result |
|---|---|
| `pnpm format:check` | pass |
| `pnpm lint` (ESLint + dependency-cruiser) | pass; no dependency violations (263 modules) |
| `pnpm typecheck` | pass (26 tasks) |
| `pnpm test` | pass: 632 unit tests, including 7 eval-judge tests |
| `pnpm test:coverage` (unit + integration, Testcontainers) | pass (15 tasks); agent 250 tests, 97.71% lines; tenancy 17, 93.61%; db 75; governance 93; platform 265; inbox 5; kb 30; api 44 |
| `pnpm build && pnpm size` | pass: loader 1.75 KB gz (≤ 14), panel 9.48 KB gz (≤ 35), initial 1.75 KB gz (≤ 30) |
| `pnpm test:e2e --project=chromium` | pass: 19 tests, including the 3 in `language.e2e.ts` |
| `pnpm eval` / `pnpm eval --fast` | pass: 154 / 98 cases, every subset at 1.000; 4 cases skipped (need the semantic embedder); 11 judge expectations pending the real judge |
| `pnpm audit --prod --audit-level=high` | no known vulnerabilities |

| Criterion | Where it is shown |
|---|---|
| AC-1 | `language.test.ts`, `prompt.test.ts` (tail names language and register; `system` byte-identical; changes with hours) |
| AC-2 | `hours-text.test.ts`, `system-slots.test.ts`, `verify` cases in `compose.test.ts`; `language-hours.int.test.ts` (Chinese disclosure and reply); eval `chinese` |
| AC-3 | eval `singlish` (22 cases) and `chinese` (17 cases) at 1.000 (threshold 0.9); verifier cases for particles, "this one nice one lah", typed "$55 only lah" and "can collect 3pm" |
| AC-4 | `answer.test.ts`, `dispatch.test.ts`; `language-hours.int.test.ts` (triage call only, `out_of_scope: done` audited, mixed answer then refusal) |
| AC-5 | `answer.test.ts` (`replyPlan` rules); `language-hours.int.test.ts` (unsure, triage call only); eval `out-of-scope` 18 cases at 1.000 (threshold 0.95) |
| AC-6 | `tenancy/src/hours.test.ts` (14 tests), `tenancy/test/hours.int.test.ts` |
| AC-7 | `language-hours.int.test.ts` (notice once per closed period, again after reopening, Chinese, paused fallback, human owner stores nothing); eval after-hours cases |
| AC-8 | eval `zh-j7-weekend-hours`, `zh-typed-time-blocked`, `ah-next-open-unknown-while-open`; `system-slots.test.ts` (`unknown_field`) |
| AC-9 | `language-hours.int.test.ts` and `turn.int.test.ts` (decision payload codes, no text) |
| AC-10 | `db/test/rls.int.test.ts` "opening hours and message notices (FEAT-023)" |
| AC-11 | `evals/src/judge.test.ts`; the runner's static sample checks on every run; the draft refusal with a real model |
| AC-12 | `e2e/tests/language.e2e.ts` (3 tests); widget `chat.test.ts`; screenshots at 390 px and 1280 px during T9 |
