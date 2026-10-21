# Acceptance Report: FEAT-023 — Language and register, out-of-scope handling, after-hours behaviour

> Verdict: **Accepted** (first verification; AGT-04's offer of a person or lead capture and AGT-09's lead capture arrive with FEAT-044 and FEAT-049 per design §8, and the model-dependent part of AGT-03 and AGT-04 is re-measured at M1.5, so all three Test refs are partial) · Date: 2026-10-21
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-12) @ `e170bc0` · Sources: SRS v0.4 (AGT-03, AGT-04, AGT-09, NFR-02, NFR-09, NFR-10, NFR-11, NFR-13), use-cases v0.4 (UC-20 steps 5, 5a, 5b), ADR-007, ADR-008, ADR-014, ADR-016, ADR-022, ADR-025
> Repo state audited: `9762917` (implementation head), plus this verification's test correction in `9a58690`

## Verdict summary

FEAT-023 is accepted. Each of AC-1..AC-12 has tests that assert what the criterion says, with one exception that this verification corrected: AC-4 requires that the usage ledger has a triage row and no reply row, but the integration test only counted the fake provider's calls. It now asserts on the gateway's usage sink, and the real `usage_events` rows on the local stack were also inspected (embed and triage only). Every suite ran green in this session on a fresh Docker stack: format, lint and boundaries, typecheck, unit, integration with coverage, build and widget size, 19 Chromium E2E tests, both eval modes, and the dependency audit. There are no rework or design-defect findings. The judge's agreement sample ships with draft labels that the owner must confirm before M1.5.

## Audit standard

- **AGT-03** (M): understands English, Singlish and Simplified Chinese and replies in the visitor's language or register; intent accuracy ≥ 90% on the Singlish and Chinese subsets. Covered by AC-1..AC-3, AC-8, AC-12. The ≥ 90% figure is measured on the fake provider now (subsets at 1.000) and on the real model at M1.5 (design §6, plan §3), so the Test ref is partial.
- **AGT-04** (M): low confidence or out of scope → says it will check with the team, offers handoff or lead capture, never guesses; ≥ 95% refusal or escalation. Covered by AC-4, AC-5. The offers of a person and of lead capture need FEAT-044 and FEAT-049 (design §8): partial.
- **AGT-09** (M): after hours tells the visitor when staff will be back, still answers from the KB, captures leads; follows the tenant's hours and SG public holidays. Covered by AC-6, AC-7, AC-8, AC-12. Lead capture is FEAT-049: partial.
- **UC-20** 5 (reply in the visitor's language) → AC-1..AC-3; 5a (out of scope or unsure) → AC-4, AC-5; 5b (after hours) → AC-7. **NFR-10** (SGT, `S$`, "9:00 am" formats) → AC-2, AC-6; **NFR-11** (no PII in audit) → AC-9; **NFR-13** (cost) → AC-4's skipped reply call and the eval cost line (S$0.00114 per conversation, fake prices); **NFR-02** (widget budget) → size check; **NFR-09** (accessibility) → AC-12 axe and `lang="zh-Hans"`.

The criteria were cross-checked against these sources. Each FR statement in scope is encoded by at least one criterion; the parts not built are named as partial in design §8 rather than misencoded.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | AGT-03, UC-20 5 | `agent/src/language.test.ts`, `prompt.test.ts` (tail lines; `system` byte-identical across languages, registers, times; differs when hours change) | faithful | green |
| AC-2 | AGT-03, NFR-10 | `hours-text.test.ts`, `system-slots.test.ts` (weekday names, 三明治 pass; 九点, 9点半, 10月24日 blocked), `language-hours.int.test.ts` (Chinese disclosure and reply), eval `chinese` (escalation text) | faithful | green |
| AC-3 | AGT-03 | `system-slots.test.ts` (particles, "this one nice one lah", "$55 only lah", "can collect 3pm"); eval `singlish` 22/22, `chinese` 17/17 (threshold 0.9) | faithful | green |
| AC-4 | AGT-04, ADR-025 d1/d3 | `answer.test.ts`, `dispatch.test.ts`, `language-hours.int.test.ts` | was weak (provider calls, not the ledger) → corrected | green; real ledger inspected |
| AC-5 | AGT-04 | `answer.test.ts` (`replyPlan` rules), `language-hours.int.test.ts` (unsure, no reply usage), eval `out-of-scope` 18/18 (threshold 0.95) | faithful (usage assertion added with AC-4) | green |
| AC-6 | AGT-09, NFR-10 | `tenancy/src/hours.test.ts` (every listed case incl. Monday in lieu, year end, 14-day horizon), `tenancy/test/hours.int.test.ts` | faithful | green |
| AC-7 | AGT-09, UC-20 5b | `language-hours.int.test.ts` (once per closed period, again after reopening, cites its fact, Chinese, paused fallback, human owner stores nothing); eval `ah-closed-evening-notice` (exact "tomorrow at 8:00 am" text) | faithful | green |
| AC-8 | AGT-09, AGT-01, J7 | `system-slots.test.ts` (J7 from slots, typed hours blocked, `unknown_field`), eval `zh-j7-weekend-hours`, `zh-typed-time-blocked`, `ah-next-open-unknown-while-open` | faithful | green |
| AC-9 | GOV-01, ADR-014, NFR-11 | `language-hours.int.test.ts`, `turn.int.test.ts` (codes; no visitor, reply or notice text) | faithful | green; stack entries inspected |
| AC-10 | GOV-03 | `db/test/rls.int.test.ts` "opening hours and message notices (FEAT-023)" | faithful | green |
| AC-11 | ADR-022, plan §7 | `evals/src/judge.test.ts` (7 tests), the runner's static sample checks on every run | faithful; the real-judge branch is exercised only at M1.5 | green |
| AC-12 | UC-20 5/5a/5b, NFR-09 | `e2e/tests/language.e2e.ts` (3 tests), widget `chat.test.ts` | faithful | green |

## Corrected tests

- **AC-4 / AC-5** (`packages/agent/test/language-hours.int.test.ts`, commit `9a58690`): the criterion says "the usage ledger has a triage row and no reply row"; the test asserted the fake provider saw only `triage`. The helper now passes an `onUsage` sink to the gateway (the source of `usage_events`, FEAT-004 D11) and the out-of-scope test asserts the non-embedding purposes are exactly `['triage']`; the unsure test asserts no `reply` row. Both pass against the unchanged code.

## Independent execution

Run in this session on a fresh local stack (Docker compose: Postgres 16 + pgvector, Valkey, LocalStack, Mailpit; `pnpm db:setup` applied migrations 0000–0013 to a new volume; `pnpm dev`):

- `pnpm format:check`, `pnpm lint` (ESLint, dependency-cruiser: no violations), `pnpm typecheck`: pass.
- `pnpm test`: 632 unit tests pass. `pnpm test:coverage` (unit + Testcontainers integration): 15 tasks pass, agent 250 tests at 97.71% lines (threshold 70%), tenancy 93.61%; the Valkey rate-limit and S3 anchor suites ran too.
- `pnpm build && pnpm size`: loader 1.75 KB gz, panel 9.48 KB gz, initial load 1.75 KB gz (limits 14 / 35 / 30).
- `pnpm test:e2e --project=chromium`: 19 pass, including the 3 new ones; no flakes seen in two runs of `language.e2e.ts`. Firefox and WebKit were not installed here; CI runs them.
- `pnpm eval`: 154 cases, every subset 1.000; 4 skipped (need the semantic embedder); 11 judge expectations pending. `pnpm eval --fast`: 98 cases, every subset 1.000.
- `pnpm audit --prod --audit-level=high`: no known vulnerabilities.

## Direct verification

- **Audit log (AC-9):** on the stack, `agent.decision` entries for the E2E turns carry `language`, `register`, `slots` (`hours.today`, `next_open`), `afterHours: true` and the outcome code; the out-of-scope turn has `route: null`, `models: []`, and an `agent.dispatch` entry `{task: out_of_scope, outcome: done}`. No text in any payload.
- **Usage ledger (AC-4):** `usage_events` for the two out-of-scope E2E turns hold `embed` and `triage` only.
- **Stored notices (AC-7):** `messages` rows carry `notice_kind = after_hours` with the English and Chinese notice texts.
- **Screen (SCR-WGT-002 after-hours, language):** rendered at 390 px and 1280 px: disclosure, then notice, then reply; the notice wraps untruncated; the Chinese bubbles and notice carry `lang="zh-Hans"`; axe reports no serious violations. Matches ui-design.md and the manifest's `after-hours` state.
- **Pending environment:** the real-model measurements (AGT-03 intent accuracy and register, AGT-04 refusal rate on mixed messages, judge agreement ≥ 90%) run at M1.5 with `LLM_PROVIDER=anthropic-dev`, after the owner confirms the agreement labels. Pure-Chinese retrieval (4 cases) runs with the Cohere embedder at MD.

## Findings

- **Rework:** none.
- **Design defect:** none.
- **Minor:**
  1. The agreement sample (`evals/labels/agreement-sample.json`) is labelled `draft`; the owner must review its 8 verdicts before M1.5 (design §8). Not blocking M1.
  2. The fake responder's closed-day wording ("Today's hours are closed.") reads awkwardly; it is the fake model's template, not a production text.
  3. Implementation moved the existing eval case `ground-no-fact` to the second tenant because the bakery now has hours; its expectations are unchanged and the reason is recorded in tasks.md. Reviewed: not a weakening, since the bakery's hours answers are covered by new cases.
  4. The RTM Plan ref for AGT-04 and AGT-09 names only FEAT-023, although FEAT-044 and FEAT-049 complete them; the `(partial)` marker carries this until the plan's next revision adds them.

## RTM

Test ref appended for AGT-03, AGT-04 and AGT-09: `features/FEAT-023-language-scope-hours/acceptance-report.md (partial)`.
