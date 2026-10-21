# Tasks: FEAT-024 — Assistant persona and disclosure settings

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: pending · Last updated: 2026-10-21

- [x] T1 — Schema: `assistant_settings` with its checks (drizzle schema + `0014`), `0015` with forced RLS, policy, grants and `visitor_tenant_state()` recreated with the persona columns; `TENANT_SCOPED_TABLES` (design §4)
      Done when: `pnpm db:setup` applies 0014–0015 on the running stack; the RLS suite passes with new cases: tenant B can't read or write tenant A's row, the visitor role can't select the table, the function returns the current tenant's persona only (defaults with no row), and the checks reject a digit in the name, a blank text and an unknown tone.
- [x] T2 — Tenancy: `AssistantPersona`, `DEFAULT_PERSONA`, `getAssistantSettings`, `saveAssistantSettings` with version and audit, `SettingsConflictError`, and `visitorTenantState().persona` (design §5.1; AC-1, AC-9)
      Done when: tenancy integration tests pass: defaults with no row; first save (version 0) and later save (version n) bump the version; stale and racing first saves raise `SettingsConflictError` and change nothing; the audit entry carries the changed field codes and no text; `visitorTenantState` returns the saved persona.
- [x] T3 — Agent texts: `textsFor(lang, persona)` (core + note, fallback, after-hours lead + message), `DEFAULT_GREETING`, `assistantDefaults` (design §5.2; D2, D3, D7; AC-5, AC-6, AC-7)
      Done when: unit tests pass: no persona → FEAT-023 texts byte for byte; named and unnamed cores in en and zh; a note appended; custom fallback and after-hours message per language; a Chinese text falls back to the Chinese default when only `en` is set; `assistantDefaults` renders the business name.
- [x] T4 — Agent prompt, emoji and fake: the `<assistant>` block and register-within-tone rule, `stripEmoji`, `ComposeInput.emoji`, the fake responder's tone/emoji/name behaviour (design §5.3; D4, D5; AC-3, AC-4)
      Done when: unit tests pass: `system` byte-identical across languages, registers and times for one persona and different after each persona change; professional lines forbid particles; `stripEmoji` cases (ZWJ families, flags, skin tones, keycaps, spacing, © kept); compose strips before render with slot values intact and reports it; the fake adds 🙂 only for friendly + emoji and answers the name question.
- [x] T5 — Agent turn: persona through the turn (disclosure, fallbacks, notice, compose), audit `tone` and `emojiRemoved` (design §5.4; AC-4, AC-5, AC-6, AC-9)
      Done when: agent integration tests pass: a saved name and note appear in the first reply's disclosure (en and zh); a paused tenant's fallback and an unavailable turn's fallback are the tenant's; the after-hours notice keeps the return time and uses the tenant's message; emoji off stores no emoji; the decision payload has the new codes and no text; with no settings every existing turn test is unchanged.
- [x] T6 — Contracts and api: the §3.1 shapes, `GET`/`PUT /api/v1/settings/assistant`, the 409 mapping, and the widget config's name and greeting (design §3, §5.5; AC-1, AC-2, AC-8)
      Done when: api integration tests pass for GET defaults, PUT success, 400 per invalid field, 403 for an Agent, 409 on a stale version, and the widget config returning the saved name and greeting (defaults with none); contract unit tests cover the schema rules (digits, length, blank → null).
- [x] T7 — Widget: the greeting in the empty state by locale (design §5.6; ui-design.md; AC-8 UI half)
      Done when: widget unit tests pass for the greeting choice, `pnpm build && pnpm size` stays within budget, and the panel shows a custom greeting on the local stack.
- [x] T8 — Dashboard: the Settings index and SCR-APP-041 (design §5.7; ui-design.md; AC-11)
      Done when: the screen renders and conforms to ui-design.md on the local stack at 375 px and desktop (default, loading, validation, saving, saved, conflict, no-permission, error), and component tests cover validation messages, blank → default and the preview.
      Note (2026-10-21): checked on the local stack at 375 and 1280 px (default, validation with the error summary and tab error counts, the 中文 tab, the long-text preview, the sticky action bar over the bottom nav). The dashboard has no component-test framework (FEAT-011 covered its screens the same way), so the component-test part moves to T9's E2E spec: validation messages, blank → default, the preview, saving/saved, conflict and no-permission are asserted there. The contracts package has no test runner either; its schema rules are covered by `apps/api/test/settings.int.test.ts`. `Field`, `describedBy` and `useToast` moved to `src/lib/` so both forms share them (react-refresh lint).
- [x] T9 — E2E and evals: `e2e/tests/assistant.e2e.ts` (AC-12, with axe on the screen) and `feat-024-persona.json`, the `persona` fixture/case field, the `emoji` expectation, the `tone` criterion, `version.json` 0.6.0 and the draft agreement items (design §5.8; AC-11, AC-12, AC-13)
      Done when: the new spec and the existing E2E suite pass on Chromium against the local stack; `pnpm eval` and `--fast` pass every threshold with existing cases unchanged; a deliberately wrong recorded output in a new case drops its subset below threshold (then restored).
      Note (2026-10-21): `assistant.e2e.ts` (4 tests: the owner flow to the widget with axe, validation and blank → default, conflict and reload, the no-permission state) and the whole Chromium suite pass, 23/23. The spec found that a save remounted the form (keyed on the version) and lost the "saved" toast; the toast now lives on the page. Evals: 14 cases (8 fast); `pnpm eval` 168 cases and `--fast` 106 pass every threshold, existing cases unchanged with the default persona. Planting five wrong outputs reported each as FAIL, took `chinese` to 17/20 = 0.850 BELOW and exited 1; restored, exit 0. Beyond §5.8, the cases needed a `disclosure` expectation (the disclosure is added by the turn, not the reply) and `replyFails` (the fallback is only sent when the reply model fails); both mirror `turn.ts`. The agreement sample gains three draft `tone` items (11 for 13 judge expectations).
- [x] T10 — Verify: every AC in design §6 demonstrably passes; format, lint and boundaries, typecheck, unit, integration with coverage, build and size, E2E, evals and audit green; scaffold notes, RTM design ref and the manifest updated
      Done when: all of the above pass in one fresh run, with the evidence recorded here.

## T10 evidence (2026-10-21, one run from the committed tree, local stack up)

| Check | Result |
|---|---|
| `pnpm format:check` | pass |
| `pnpm tokens && pnpm lint` (ESLint, then dependency-cruiser) | pass; no dependency violations (276 modules, 733 dependencies) |
| `pnpm typecheck` | pass (26 tasks) |
| `pnpm test` | pass (22 tasks); agent 241 unit tests, widget 9, evals 8 |
| `pnpm test:coverage` (unit + integration, Testcontainers) | pass (15 tasks); agent 281 tests, 98.04% lines; tenancy 21, 95.52%; db 80; api 61; governance 93; platform 265; kb 30; identity 30 |
| `pnpm build && pnpm size` | pass: loader 1.75 KB gz (≤ 14), panel 9.43 KB gz (≤ 35), initial 1.75 KB gz (≤ 30) |
| `pnpm test:e2e --project=chromium` | pass: 23 tests, including the 4 in `assistant.e2e.ts` |
| `pnpm eval` / `pnpm eval --fast` | pass: 168 / 106 cases, every subset at 1.000; eval set 0.6.0; 4 skipped (semantic embedder); 13 judge expectations pending the real judge |
| `pnpm audit --prod --audit-level=high` | no known vulnerabilities |

| Criterion | Where it is shown |
|---|---|
| AC-1 | `apps/api/test/settings.int.test.ts` (read, save, version bump, 403 for an Agent, 401, 409 for stale and second first save); `tenancy/test/assistant.int.test.ts` |
| AC-2 | `settings.int.test.ts` (11 rejected bodies, blanks stored as null, names in other scripts); `db/test/rls.int.test.ts` "assistant settings (FEAT-024)" (database checks); `assistant.e2e.ts` (inline and summary errors) |
| AC-3 | `agent/src/persona.test.ts` "persona in the prompt" (cached block, byte-identical, changes on any change, none without a persona) |
| AC-4 | `persona.test.ts` (strip before render, slot values intact, emoji-only segment, fake responder); `persona.int.test.ts` (stored reply has no emoji, decision `emojiRemoved`); `assistant.e2e.ts` (name in the widget header, name answer, 🙂); eval `persona-emoji-*` |
| AC-5 | `texts.test.ts`, `persona.int.test.ts` (named core and note in en and zh; no settings = FEAT-022's sentence); eval `persona-disclosure-*`; `assistant.e2e.ts` |
| AC-6 | `texts.test.ts`, `persona.int.test.ts` (paused and unavailable fallback; return time kept); eval `persona-fallback-custom-en`, `persona-after-hours-custom-keeps-return-time` |
| AC-7 | `texts.test.ts` (Chinese turn gets the Chinese default); eval `persona-fallback-zh-uses-chinese-default` |
| AC-8 | `settings.int.test.ts` "GET /widget/v1/config"; widget `chat.test.ts` (greeting per locale); `pnpm size`; `assistant.e2e.ts` |
| AC-9 | `tenancy/test/assistant.int.test.ts` and `settings.int.test.ts` (one `settings.assistant_updated` per save with version and field codes, no text); `turn.int.test.ts` and `persona.int.test.ts` (decision `tone`, `emojiRemoved`) |
| AC-10 | `db/test/rls.int.test.ts` "assistant settings (FEAT-024)" (forced RLS, cross-tenant read and write blocked, visitor role only via `visitor_tenant_state()`) |
| AC-11 | `assistant.e2e.ts` (load, validation with linked summary, preview as typed, toast, conflict with Reload, Agent no-permission, axe); screenshots at 375 and 1280 px during T8 |
| AC-12 | `assistant.e2e.ts` "the owner names the assistant and the widget introduces itself that way" (row cleared after each test) |
| AC-13 | `pnpm eval` and `--fast` above; planted wrong outputs fail (T9 note) |
