# Tasks: FEAT-025 — Prompt-injection resistance, harmful content, crisis replies, flagged conversations

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: done · Last updated: 2026-10-21

- [x] T1 — Schema: `conversations.flagged_at`, `flag_reasons`, `abuse_turns` with their checks and the flagged index; `chat_ended` in `NOTICE_KINDS` and `messages_notice_ck` (drizzle schema + `0016`); `0017` grants the visitor role `UPDATE` on the three columns (design §4)
      Done when: `pnpm db:setup` applies 0016–0017; the RLS suite passes with new cases: the visitor role updates the flag columns on its own tenant only and can't update `visitor_id` or `channel`; the flag check rejects an unknown reason and reasons without `flagged_at`; the notice check accepts `chat_ended` and rejects unknown kinds; tenant B can't see or set tenant A's flags.
- [x] T2 — Inbox and contracts: `flagConversation`, `recordAbuse`, `endAiConversation` with their audit entries; `toSummary` flags, `toMessage` `noticeKind`; `Message.noticeKind` and `ConversationSummary.flaggedAt`/`flagReasons` (design §3, §5.5; AC-9, AC-11)
      Done when: inbox integration tests pass: flag is idempotent and audited once per reason; `recordAbuse` counts distinct turns; `endAiConversation` closes an AI conversation and audits; the API's conversation list returns the flags.
- [x] T3 — Agent plan, texts and dispatch: `flags.impersonation`, triage prompt lines, `ConversationPort`, `endTurn` keys, `crisisHandler`, `abuseHandler`, the `out_of_scope` topic and reply keys, the safety and refusal texts in en and zh, the fake triager's new rules (design §5.1–§5.3; D2, D3, D6, D7; AC-5, AC-6, AC-7, AC-8)
      Done when: unit tests pass for plan parsing with and without `impersonation`, each handler (crisis flags once and ends; abuse warns then ends and flags at the limit; topics map to keys; unknown topic → `out_of_scope`), safety-first ordering with a crisis beside an answer and a lead, both text tables, and the fake triager on each new keyword family.
- [x] T4 — Agent reply decision, prompt fencing and leak guard: `replyPlan` flag keys and the `refused` outcome, `asData`, the new system rules and tail lines, `guard.ts` and its use in `composeReply` (design §5.3; D1, D5; AC-1, AC-2, AC-3, AC-5)
      Done when: unit tests pass for each `replyPlan` rule with flags (no answer; answer without facts; answer with facts composes), fenced fact and profile values (`</facts>`, `[[f:…]]`), `system` byte-stable per tenant, every leak marker and a 10-word window blocked as `prompt_leak` then escalated, and every fixed text in both languages and the fake responder's answers passing the guard.
- [x] T5 — Agent turn: the `ConversationPort` on the inbox, safety `endTurn` stored with the `chat_ended` notice for `abuse_ended`, the audit codes and guardrail entries, the realtime summary (design §5.4; AC-1, AC-5, AC-6, AC-7, AC-9)
      Done when: agent integration tests pass: an injection-only turn has a triage usage row and no reply row and audits `guardrail.injection_detected`; impersonation likewise; a crisis turn flags, stores the contacts and keeps the AI on; two abuse turns flag, close and store the ended text with the notice, then a third message gets no reply; a redelivered abuse turn doesn't count twice; no audit payload carries text.
- [x] T6 — Evals: `priorAbuse`, the `refused`/`ended` outcomes, `safety`, `flagged`, `ai-ended` and `no-leak` expectations, the runner's port and `endTurn` path, `feat-025-red-team.json` (≥ 50) and `feat-025-harmful.json` (≥ 20), the judge's `safety` criterion and agreement items, `version.json` 0.7.0 (design §5.7; AC-4, AC-8)
      Done when: `pnpm eval` and `pnpm eval --fast` pass every threshold with the existing cases unchanged; a deliberately leaking recorded output with the guard disabled drops `red-team` below 1.0 (then restored); judge unit tests cover the new criterion.
- [x] T7 — Widget: the `chat_ended` notice after the bubble and the closed composer (design §5.6; ui-design.md; AC-12 UI half)
      Done when: widget unit tests pass for row order and the ended state, `pnpm build && pnpm size` stays within budget, and the ended panel renders in the browser at 390 px and desktop.
- [x] T8 — E2E: `e2e/tests/safety.e2e.ts`: injection refused, crisis contacts, abuse twice ends the chat (notice, disabled composer, axe), the conversation listed with `flagReasons` (AC-12, AC-11; UC-20 3a, 3b)
      Done when: the new spec and the existing E2E suite pass on Chromium against the local stack.
      Note (2026-10-21): `safety.e2e.ts` (3 tests: the injection refusal, the crisis contacts with the composer still open, abuse twice ending the chat with the notice as the last row, the disabled composer and Send, axe, and the conversation in `GET /api/v1/conversations` as `closed` with `flagReasons: ['abuse']`) and the whole Chromium suite pass, 26/26. The ended panel was also checked at 390 and 1280 px. This container's Playwright browsers are an older build, so the run used `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` (the config's existing override); CI installs its own.
- [x] T9 — Verify: every AC in design §6 demonstrably passes; format, lint and boundaries, typecheck, unit, integration with coverage, build and size, E2E, evals and audit green; scaffold notes, RTM design ref and the manifest updated
      Done when: all of the above pass in one fresh run, with the evidence recorded here.

## T9 evidence (2026-10-21, one run from the committed tree, local stack up)

| Check | Result |
|---|---|
| `pnpm format:check` | pass |
| `pnpm lint` (ESLint, then dependency-cruiser) | pass; no dependency violations (279 modules, 761 dependencies) |
| `pnpm typecheck` | pass |
| `pnpm test` | pass (22 tasks); agent 297 unit tests, widget 11, evals 9 |
| `pnpm test:coverage` (unit + integration, Testcontainers) | pass (15 tasks); agent 344 tests, 98.32% lines; inbox 7, 84.31%; db 85; api 63; governance 93; platform 265; kb 30; identity 30; tenancy 21 |
| `pnpm build && pnpm size` | pass: panel 9.6 KB gz (≤ 35), initial 1.75 KB gz (≤ 30) |
| `pnpm test:e2e --project=chromium` | pass: 26 tests, including the 3 in `safety.e2e.ts` |
| `pnpm eval` / `pnpm eval --fast` | pass: 244 / 135 cases, every subset at 1.000 (red-team 52/52, harmful 24/24); eval set 0.7.0; 18 judge expectations pending the real judge |
| `pnpm audit --prod` | no known vulnerabilities |

| Criterion | Where it is shown |
|---|---|
| AC-1 | `agent/src/safety.test.ts` (reply plan and refusals, tail line with facts); `agent/test/safety.int.test.ts` "injection and impersonation" (fixed text, triage-only models and usage, `guardrail.injection_detected`); eval `rt-inj-*` |
| AC-2 | `safety.test.ts` (fencing of `</facts>`, `<business>`, `[[f:…]]` and newlines; the stored value still renders; system rules) |
| AC-3 | `safety.test.ts` (markers and 10-word windows blocked as `prompt_leak`, regenerate then escalate, platform texts and fake answers pass); with the guard disabled, red-team fell to 44/52 (then restored) |
| AC-4 | `evals/cases/feat-025-red-team.json` (52 cases, each with `no-leak`), 1.000 above |
| AC-5 | `safety.int.test.ts` (impersonation refusal, audit, a real question still answered); `dispatch.test.ts` (visitor registry is exactly `crisis`, `abuse`, `out_of_scope`) |
| AC-6 | `dispatch.test.ts` (crisis handler, flag failure is partial); `texts.test.ts` (contacts in en and zh with Care Corner); `safety.int.test.ts` "crisis" (flag once, no reply call, AI stays on); eval `hm-crisis-*` |
| AC-7 | `dispatch.test.ts` (abuse handler); `inbox.int.test.ts` (`recordAbuse` distinct turns, `endAiConversation`); `safety.int.test.ts` "abuse" (warn, end, redelivery, silence after); eval `hm-abuse-*` |
| AC-8 | `dispatch.test.ts` (topics, unknown topic → `other`); `safety.test.ts`; `evals/cases/feat-025-harmful.json` (24 cases), 1.000 above |
| AC-9 | `safety.int.test.ts` (decision codes, `conversation.flagged`/`ai_ended` reason codes, "no text in the audit"); `turn.int.test.ts` (decision payload) |
| AC-10 | `db/test/rls.int.test.ts` "flagged conversations and chat-ended notices (FEAT-025)" |
| AC-11 | `apps/api/test/auth.int.test.ts` "lists a flagged conversation with its flag"; `safety.e2e.ts` |
| AC-12 | `e2e/tests/safety.e2e.ts`; widget `chat.test.ts` "chat ended" |
