# Handoff: FEAT-054 — Boundary rules with safe defaults
Branch: feat/FEAT-054-boundary-rules · PR: none · Updated: 2026-10-30 by design
Stage done: design
Next: build (backend, T1–T6) — kickoff: "Build FEAT-054 (backend) on branch feat/FEAT-054-boundary-rules. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- `@kaki/approvals` gets its first file (`rules.ts`); update its package.json description ("Placeholder until FEAT-055") and add it to `@kaki/agent` and `apps/api` deps.
- Rules are immutable versions in one table (D1); the PK `(tenant_id, version)` is the concurrency check → 409 `rules_stale`.
- No new task kind: blocked topics are `out_of_scope` with `topic: 'blocked'` (phrase match in code + triage tail; D2). The triage tail is added only when the tenant has topics, so existing triage tests stay byte-identical.
- The rules block in the reply prompt goes after `<business>` so the leak guard's `ruleText` ignores it.
- Discount offers are blocked in text whatever `maxDiscountPct` says until FEAT-055 (D4); `commitmentDecision` is built and unit-tested only.
- Legal and medical advice can't be unticked (D6): contract refine + table check.
- `PUT` order: capability → parse → `requireReauth` → save (D7). First tenant-settings route with re-auth; test with `staleReauth` as in `apps/api/test/mfa.int.test.ts`.
- Migration number 0038 assumes main is still at 0037.
- UI session (T7–T11): `rules-parts.tsx` is shared by `/settings/rules` and `/setup/rules`; the topic editor copies the widget's allowed-origins list pattern (`widget-parts.tsx`).

## Left to CI or later
- E2E (`rules.e2e.ts`), screen renders and axe: verify stage's GitHub CI (no Docker in cloud sessions).

## Pending for Ken
- None.
