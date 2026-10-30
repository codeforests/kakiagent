# Tasks: FEAT-054 — Boundary rules with safe defaults

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-30

- [x] T1 — Schema: `0038_boundary_rules.sql` (table, checks, forced RLS, policy, `select, insert` to `app_dashboard`, `select` to `app_visitor`) + Drizzle table; name in `TENANT_SCOPED_TABLES`; RLS suite cases (design §4; D1; AC-4, AC-10)
      Done when: `drizzle-kit generate` reports no drift after 0038; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with: tenant B reads none of A's rows; inserting A's tenant ID in B's context fails; `app_dashboard` update and delete are permission denied; `app_visitor` insert is denied; the check refuses a row without `legal_advice`, with an unknown key, or 101%.
- [x] T2 — Domain: `packages/approvals/src/rules.ts` (`BoundaryRules`, `SAFE_DEFAULTS`, `currentRules`, `rulesInForce`, `saveRules` with normalisation, `RulesStale` and the `rules.updated` audit, `rulesSaved`, `commitmentDecision`), exports, package.json deps; tenancy F&B `suggestedRules` (design §5.1, §5.2; D1, D3, D6; AC-1, AC-4, AC-8, AC-9)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/approvals test:integration` and `pnpm --filter @kaki/approvals test` pass: no row → `rulesInForce` is `SAFE_DEFAULTS`, `version: null`, `rulesSaved` false; first save is version 1, the next 2; saving from a stale version throws `RulesStale` (also two concurrent saves from the same version: one wins); one `rules.updated` entry per save with `changed` codes only and `verifyChain` holds; dedupe keeps the first spelling; `commitmentDecision` table test (above max → refuse; within max → needs_approval / allowed by the flag). Tenancy unit test: the F&B template has `suggestedRules` and no topic is in both lists.
- [x] T3 — Agent, rules in the turn: `BoundaryRules` type from approvals in `dispatch.ts`; `rulesInForce` loaded in `runVisitorTurn`'s first transaction and in coaching and replay; `boundary.ts` `blockedTopicHit` + `applyBoundary`; `OutOfScopeArgs` `blocked` → `ReplyKey` `blocked_topic` + `texts.ts` in every language + `answer.ts` render; triage tail with the topics and the `TRIAGE_SYSTEM` line; `fake-triage` reads the tail; `agent.decision` `rulesVersion`, `guardrail.boundary_topic` (design §5.3; D2, D3; AC-5, AC-6, AC-8)
      Done when: `pnpm --filter @kaki/agent test` passes with unit cases for `blockedTopicHit` (whole word, plural, case, NFKC, CJK substring, no partial-word hit) and `applyBoundary` (answer → out_of_scope blocked; other tasks kept); `scripts/test-env.sh pnpm --filter @kaki/agent test:integration` passes with: after a save with a blocked topic the next visitor message about it stores the `blocked_topic` text and the reply model isn't called; `agent.decision` has the new `rulesVersion`; a tenant with no rules gets the same triage request as before (no tail); `boundaryRules()` is non-null in visitor and coaching turns.
- [x] T4 — Agent, reply side: `rulesLines` in the cached tenant block of `buildVisitorPrompt`; `boundaryGuard` (`discount_offer`, `commitment` per forbidden key and custom phrases) run in `compose.ts` after the leak guard; guardrail audit codes; `fake-responder` scripted replies (design §5.3; D4, D5; AC-7)
      Done when: `pnpm --filter @kaki/agent test` passes with guard unit cases: each pattern hits on an offer and misses its negative ("we don't offer discounts", "delivery fee is [[slot]]", "our refund policy is [[slot]]"), slot renderings are masked, unticked keys don't check, zh cases; prompt unit test: rules block sits after `<business>` (so `ruleText` excludes it) and is byte-stable for the same rules; integration: a scripted guarantee reply regenerates once then stores the escalation text with `guardrail.boundary_commitment` audited.
- [x] T5 — Evals: `evals/cases/feat-054-boundary.json` (~12 cases, design §5.3), thresholds if a metric is added (plan §3; AC-6, AC-7)
      Done when: `pnpm eval --fast` passes on the fake provider with the new cases included and no existing case changed.
- [x] T6 — Contracts and API: contract section (§3) + unit test (keys match the approvals interface; superRefine cases); `apps/api/src/rules.ts` `GET`/`PUT /api/v1/settings/rules` with template prefill, parse → `requireReauth` → save, 400/403/409 errors; wired in `app.ts`; `apps/api/test/rules.int.test.ts` (design §3, §5.4; D7; AC-1, AC-2, AC-3, AC-4, AC-10)
      Done when: `pnpm --filter @kaki/contracts test` and `scripts/test-env.sh pnpm --filter @kaki/api test:integration` pass with the cases listed in design §5.4; `pnpm --filter @kaki/api typecheck` is clean.

## Build session 2 (UI)

- [x] T7 — Dashboard data: `api.getRules`/`api.saveRules`, `lib/rules.ts` (`useRules`, `useSaveRules` through `useReauthGuard().guard`, `diffRules`, `topicError`), `lib/rules.test.ts` (design §5.5; AC-3, AC-11)
      Done when: `pnpm --filter @kaki/dashboard test` passes with `diffRules` (each field's change line, no lines when equal) and `topicError` (empty, too short, too long, duplicate any case, already in the other list, list full) cases; dashboard typecheck clean.
- [ ] T8 — SCR-APP-042: `pages/rules-parts.tsx` (`RulesForm`, `TopicListEditor`), `pages/rules.tsx`, route `settings/rules`, Settings index link, confirm dialog with change lines, toast, 409 alert, permission, loading and error states (ui-design SCR-APP-042; AC-2, AC-3, AC-11)
      Done when: dashboard typecheck and `pnpm --filter @kaki/dashboard build` pass; the page renders against the dev API in the cloud session's Chromium if the stack can run, else noted for CI.
      Note: screen renders and axe run in the verify stage's GitHub CI (no Docker here).
- [ ] T9 — SCR-APP-009: `setup-rules.tsx` shows `RulesForm` (setup variant) above the privacy block; the ready caption counts saved rules; manifest status (ui-design SCR-APP-009; AC-9, AC-11)
      Done when: dashboard typecheck and build pass; the step shows the rules block with the template prefill for the dev F&B tenant (CI if not runnable here).
- [ ] T10 — E2E `e2e/tests/rules.e2e.ts` (design §5.6; AC-3, AC-5, AC-6, AC-11)
      Done when: the spec typechecks and lints; it runs in the verify stage's GitHub CI (all three browsers).
- [ ] T11 — Verify: full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, this feature's tests; `code-map.md` updated (approvals module, the boundary step in the agent pipeline, `rules-parts.tsx`); tasks status `developer-done`
      Done when: all pass, evidence below, draft PR open.

## Verification evidence

- AC-1 —
- AC-2 —
- AC-3 —
- AC-4 —
- AC-5 —
- AC-6 —
- AC-7 —
- AC-8 —
- AC-9 —
- AC-10 —
- AC-11 —
