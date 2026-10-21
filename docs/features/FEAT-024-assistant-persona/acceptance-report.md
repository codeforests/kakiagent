# Acceptance Report: FEAT-024 — Assistant persona and disclosure settings

> Verdict: **Accepted** (first verification; whether a real model keeps the professional tone with Singlish visitors is measured by the `tone` judge at M1.5, so AGT-08's Test ref is partial; AGT-11 is complete with FEAT-022's partial report) · Date: 2026-10-21
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-13) @ `a6a2217` · Sources: SRS v0.4 (AGT-08, AGT-11; AGT-09 p, NFR-02, NFR-04 p, NFR-09, NFR-10, NFR-11, NFR-19), use-cases v0.4 (UC-20; UC-29 as the plan maps it), ADR-005, ADR-007, ADR-008, ADR-014, ADR-016, ADR-022
> Repo state audited: `a6a2217` (implementation head), plus this verification's test correction in `749d4a8`

## Verdict summary

FEAT-024 is accepted. Each of AC-1..AC-13 has tests that assert what the criterion says, with one gap that this verification closed: AC-5's clause that no setting can produce a first reply without the disclosure core had no test at the API boundary, so a test now sends a body that tries to set a core and shows the core still leads the disclosure in both languages. The feature's test diff only adds lines; no existing assertion, case or threshold was removed or loosened, and the existing eval cases pass unchanged with the default persona. There are no rework or design-defect findings. Two minor notes for the owner are listed under Findings.

This verification ran in the same session as the implementation. Its standard was re-derived from the SRS, the use cases and design §6, not from tasks.md, and every green below was observed in this session.

## Audit standard

- **AGT-08 (M):** "Configurable persona: bot name, tone (friendly / professional), greeting, emoji on or off. Register matching (AGT-03) stays within the chosen tone." Acceptance: "Settings are reflected in replies." Encoded by AC-1 (save and read), AC-2 (validation), AC-3 (prompt carries name, tone, emoji; professional forbids particles), AC-4 (emoji off enforced in code, emoji on and the name reflected on the fake model), AC-8 (greeting and name in the widget), AC-11 (the screen), AC-12 (end to end), AC-13 (evals). Faithful. "Reflected in replies" for tone depends on the model; on the fake provider it is shown by the prompt lines and the decision audit, and with a real model only at M1.5 (the `tone` judge), hence partial.
- **AGT-11 (M):** "Discloses that it is an AI assistant at the start of a conversation." Acceptance: "Disclosure text appears in the first message and can be edited but not removed." Encoded by AC-5 (fixed core naming the AI, plus the tenant's editable note; no field for the core) and AC-12. See Findings, minor 1, on how "edited" is read.
- **UC-20** main flow (first reply carries the disclosure; replies use the persona): AC-5, AC-12. **UC-29** as mapped by the plan: AC-1, AC-11.
- Binding NFRs: NFR-02 (widget budget) AC-8; NFR-09/NFR-19 (accessibility, inline validation) AC-11; NFR-10 (per-language texts) AC-7; NFR-11 (audit without PII) AC-9; NFR-04 p and AGT-09 p (fallback and after-hours texts) AC-6. Tenant isolation (GOV-03, ADR-005): AC-10.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | AGT-08, UC-29 | `apps/api/test/settings.int.test.ts` (read, save, version + 1, 403 for an Agent on both routes, 401, 409 for a stale version and a second first save, nothing changed); `packages/tenancy/test/assistant.int.test.ts` | faithful | green |
| AC-2 | AGT-08, NFR-19 | `settings.int.test.ts` (11 rejected bodies incl. digit, > 30 chars, symbols, each text limit; blanks stored as null); `packages/db/test/rls.int.test.ts` "assistant settings (FEAT-024)" (database checks on direct writes); `e2e/tests/assistant.e2e.ts` (inline errors and linked summary) | faithful | green |
| AC-3 | AGT-08, ADR-007 d2 | `packages/agent/src/persona.test.ts` "persona in the prompt" (lines in the cached block, never the tail; byte-identical across languages, registers and times; changes after any persona change; professional line forbids particles) | faithful | green |
| AC-4 | AGT-08 | `persona.test.ts` (strip before render and verify, slot values intact, emoji-only segment dropped; fake responder); `packages/agent/test/persona.int.test.ts` (stored reply has no emoji, `emojiRemoved: true`; emoji on adds one); `assistant.e2e.ts` (name in the widget header, the name answer, 🙂); eval `persona-emoji-*` | faithful | green |
| AC-5 | AGT-11, UC-20 | `packages/agent/src/texts.test.ts`, `persona.int.test.ts` (named core and note, en and zh; no settings = FEAT-022's sentence byte for byte); `settings.int.test.ts` "has no field for the disclosure core" (added here); eval `persona-disclosure-*`; `assistant.e2e.ts` | gap in the "no setting can remove the core" clause → corrected | green |
| AC-6 | AGT-09 p, NFR-04 p | `texts.test.ts`; `persona.int.test.ts` (paused and unavailable use the tenant's fallback in en and zh; after-hours notice keeps the system sentence); eval `persona-after-hours-custom-keeps-return-time` (known return time + tenant message), `persona-fallback-custom-en` | faithful | green |
| AC-7 | NFR-10 | `texts.test.ts` (a Chinese turn gets the Chinese default when only English is customised); `persona.int.test.ts` (zh fallback); eval `persona-fallback-zh-uses-chinese-default` | faithful | green |
| AC-8 | AGT-08, SCR-WGT-002, NFR-02 | `settings.int.test.ts` "GET /widget/v1/config" (defaults, then the saved name and greeting, zh default kept); `apps/widget/src/chat.test.ts`; `pnpm size`; `assistant.e2e.ts` | faithful | green |
| AC-9 | GOV-01, ADR-014, NFR-11 | `tenancy/test/assistant.int.test.ts`, `settings.int.test.ts` (one `settings.assistant_updated` per save with version and field codes); `persona.int.test.ts` and `turn.int.test.ts` (decision `tone`, `emojiRemoved`, no text) | faithful | green |
| AC-10 | GOV-03, ADR-005 | `rls.int.test.ts` "assistant settings (FEAT-024)" (forced RLS, tenant B can't read or write A's row, the visitor role can't select the table and gets only its own persona from `visitor_tenant_state()`) | faithful | green |
| AC-11 | SCR-APP-041, NFR-09, NFR-19 | `assistant.e2e.ts` (load, validation with focused linked summary and tab error count, preview as typed, toast, conflict alert with Reload, Agent no-permission state, axe) | faithful; the screen has no component tests, its states are covered in E2E (tasks.md T8 note) | green |
| AC-12 | UC-20, UC-29 | `assistant.e2e.ts` "the owner names the assistant and the widget introduces itself that way" (settings row cleared after each test) | faithful | green |
| AC-13 | AGT-14 | `pnpm eval` / `--fast`; five planted wrong outputs each reported FAIL, `chinese` 0.850 BELOW, exit 1; restored, exit 0 | faithful | green |

## Corrected tests

- **AC-5** (`749d4a8`): the criterion says no setting can produce a first reply without the core, because the API has no field for it. The suites showed the core in every first reply, but nothing tried to set the core through the API. The new case in `apps/api/test/settings.int.test.ts` PUTs `disclosure` and `disclosureCore` alongside a note, then checks that the saved settings carry neither and that the disclosure built from them starts with the fixed core in English and Chinese. It passed against the unchanged code (the contract drops unknown keys).

## Independent execution

All on the local Docker stack (Postgres 16 + pgvector, Valkey, LocalStack, Mailpit), with the harness's own commands, at `a6a2217`:

- `pnpm format:check`, `pnpm tokens && pnpm lint` (no dependency violations, 276 modules), `pnpm typecheck`: pass.
- `pnpm test`: pass (22 tasks). `pnpm test:coverage` (unit + integration on Testcontainers, migrations applied to a fresh database per suite, including `0014`/`0015`): pass; agent 281 tests at 98.04% lines, tenancy 21 at 95.52%, db 80, api 61, governance 93, platform 265.
- `pnpm build && pnpm size`: loader 1.75 KB gz, panel 9.43 KB gz, initial 1.75 KB gz.
- `pnpm test:e2e --project=chromium`: 23 passed, including the 4 in `assistant.e2e.ts`. No flakes in two full runs.
- `pnpm eval`: 168 cases, `--fast`: 106 cases, every subset at 1.000; 4 skipped (semantic embedder, P3); 13 judge expectations pending the real judge.
- `pnpm audit --prod --audit-level=high`: no known vulnerabilities.
- After the correction at `749d4a8`: `apps/api` settings integration file, 18 passed; typecheck and lint of the file clean.

## Direct verification

- **Audit entries (AC-9, NFR-11):** on the local stack after the E2E run, the latest `settings.assistant_updated` payloads were `{"fields": ["bot_name", "emoji", "greeting", "disclosure_note"], "version": 1}` and similar: codes only, no text. The latest `agent.decision` payloads carry `tone` and `emojiRemoved` and contain no business, reply or note text.
- **Widget (AC-8, AC-12):** on the local stack the widget header showed the saved name, the empty state the saved greeting, the first reply the named disclosure with the note, and the fake answer ended with 🙂.
- **Screen (SCR-APP-041):** spot-checked against ui-design.md at 375 and 1280 px: Persona and Messages cards, English/中文 tabs with error counts, the Preview aside (beside the form at ≥ 1024 px, between the cards on phones), the sticky action bar above the bottom navigation, the read-only disclosure core shown in full, long text wrapping in the preview.
- **NFR-02:** measured above, far inside budget.
- **Pending environment:** the `tone` and `register` judge expectations (13 across the set) and the agreement sample's draft labels need the real model and a person's labels at M1.5.

## Findings

**Rework:** none.

**Design defect:** none.

**Minor:**

1. AGT-11's acceptance says the disclosure "can be edited but not removed". The design (D2) reads this as a fixed core sentence that names the AI, which the owner cannot change, plus a note the owner writes per language. That guarantees it can't be removed, but the owner can't reword the core sentence itself. It is a deliberate, recorded decision; the owner may want to confirm it is the reading they intended.
2. The plan maps FEAT-024 to UC-29, which is "Configure boundary rules". The persona settings have no use case of their own; the design treats UC-29 "as mapped" and keeps re-authentication for boundary rules only (D8). Worth tidying in a later plan revision (an open issue for planning, not this feature).
3. After a save, the Messages card opens on the English tab again (the form reloads at the new version). Harmless; noted for a later polish.

## RTM

Test ref appended (Test ref column only):

- AGT-08: `features/FEAT-024-assistant-persona/acceptance-report.md (partial)`
- AGT-11: `features/FEAT-024-assistant-persona/acceptance-report.md`
