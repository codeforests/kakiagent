# Acceptance Report: FEAT-057 — Kill switch: pause and resume the AI on all channels

> Verdict: **Accepted** (GitHub CI run 74 green at `6dd5f6f`, 2026-10-28, incl. E2E `kill-switch.e2e.ts` in Chromium, Firefox and WebKit) · Date: 2026-10-28
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-10) · Sources: SRS v0.4 (GOV-08), use-cases v0.4 (UC-31 steps 1–4, UC-20 5e), ADR-005, ADR-013, ADR-014, NFR-02, NFR-08
> Repo state audited: `2e76834` (implementation head); one test locator corrected (see Corrected tests)

## Verdict summary

FEAT-057 is accepted. Each of AC-1..AC-10 has tests that assert what the criterion says, and the criteria encode GOV-08 faithfully: the Owner or an Admin pauses the AI on all channels from the dashboard, the send gate (unchanged, read from Postgres before every turn and segment, D1) stops replies at the next check, visitors get the tenant's fallback, and each change is one audit entry with IDs only. Partial by design and not claimed: GOV-08's "with lead capture" (the contact form is FEAT-049, D6; the paused notice shows the business's email and phone), and UC-31 step 3's staff-reply half (no inbox reply route exists yet; it arrives with FEAT-042/043, which own staff sending — the T4 "done when" line about a stored staff reply was not met and could not be, see Findings).

The test diff adds files and cases only. Seven existing agent suites changed their superuser `update tenants set ai_paused = …` fixtures to also set or clear `ai_paused_at`/`ai_paused_by`, which the new check constraint requires; their assertions are unchanged. The RTM suite's refused `update tenants set ai_paused = true` statement is replaced by a stronger positive own-tenant case, a cross-tenant 0-row case, three still-refused columns and two check-constraint cases (D5).

## Audit standard

GOV-08 (M): "Kill switch: the Owner or an Admin can pause the AI on all channels instantly (human-only mode)"; acceptance: takes effect within 5 seconds; visitors see the tenant's fallback message with lead capture; recorded in the audit log. UC-31: 1 press Pause AI; 2 within 5 s every channel stops AI replies and shows the fallback with lead capture; 3 staff answer from the inbox; 4 Resume AI; both events audited. Design §9's trace was checked against these; lead capture is deferred in D6 and §8.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 | GOV-08; UC-31 1, 4 | `apps/api/test/ai.int.test.ts` "Owner pauses, a repeat…", "an Agent gets 403…"; `packages/governance/test/kill-switch.int.test.ts` "two concurrent pauses…" | Yes: Owner pause and Admin resume return `AiStatus`; repeats 200 with no audit and no nudge; Agent 403 on both, state and publisher unchanged; concurrent pauses → `[false, true]` and one entry | Pass |
| AC-2 | GOV-08 audit | governance "pauses with who and when, audits IDs only…", "resume clears… chain verifies"; api same case | Yes: exact entry `{ai.paused, user, userId, tenant:<id>, {}}`; `verifyChain` ok | Pass |
| AC-3 | GOV-08 5 s; ADR-013 | `packages/agent/test/turn.int.test.ts` "paused: the fallback once per run…", "with the kill switch on…", "stops between segments…"; E2E `kill-switch.e2e.ts` step "one fallback" (`toHaveCount(1, {timeout: 5_000})`) | Yes: zero `generate` and `embed` calls, one `system` fallback, second message → null; mid-reply segment stop unchanged | Pass (integration); E2E in CI |
| AC-4 | GOV-08 fallback; UC-31 2 | `ai.int.test.ts` "config carries the fallback and contacts…"; `apps/widget/src/chat.test.ts` paused notice; E2E visitor steps | Yes: default and custom en/zh fallback, contacts, null after resume; notice shown, no greeting, composer enabled | Pass; E2E in CI |
| AC-5 | UC-31 3 | `ai.int.test.ts` "a visitor can still start a conversation and write while paused"; E2E | Visitor half yes. Staff-reply half not testable: no staff send route exists yet (FEAT-042/043) | Pass (visitor half); partial |
| AC-6 | UC-31 4 | turn case above (resume → `generate` > 0, `agent` author); api resume clears columns; E2E last step | Yes | Pass; E2E in CI |
| AC-7 | ADR-005 | api "works for every role…", "pausing tenant A leaves tenant B's AI running"; `packages/db/test/rls.int.test.ts` "the dashboard pauses and resumes its own tenant's AI only" | Yes: own row 1, other tenant 0 rows; other `tenants` columns permission denied; check constraint both ways | Pass |
| AC-8 | SCR-APP-058 | `apps/dashboard/src/lib/ai-status.test.ts` (`pillState`, `pausedSince`); E2E main spec (Cancel focus, pill changes only after the answer, toast, focus back) | Yes; error state judged from code (ConfirmDialog stays open with `alert`) | Pass (unit); E2E in CI |
| AC-9 | design.md banner #1 | E2E banner region, no Dismiss, on Knowledge page, Resume AI from banner | Yes; the 30 s refetch and `ai_status` invalidation judged from `lib/ai-status.ts` and `lib/realtime.ts` | E2E in CI |
| AC-10 | NFR-08, NFR-02 | E2E axe light and dark on dialog, banner page, widget notice; 375 px spec; `pnpm size` | Yes | Size pass (loader 4.43 KB, panel 12.83 KB gz); E2E in CI |

## Corrected tests

- `e2e/tests/kill-switch.e2e.ts` (AC-4, AC-5): `panel.getByLabel('Message')` also matched the paused notice region "Message from …" (label match is a substring), so the first CI run failed in strict mode at the composer check. The locator is now `getByLabel('Message', { exact: true })`; the assertions are unchanged.

## Independent execution

This session, at `2e76834`, through `scripts/test-env.sh`: `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser), `pnpm typecheck`, `pnpm test` all pass. `test:coverage` passes for db (140), channels (49), agent (404), dashboard, widget, contracts and realtime. Governance (111 passed) and api (282 passed) fail only on the known S3 suites (`anchors.int.test.ts`, `uploads.int.test.ts` "the S3 presigner": no S3 endpoint in cloud sessions); every kill-switch case passes. `pnpm size` within budget. E2E runs in GitHub CI.

## Direct verification

- Gate path read in `packages/agent/src/turn.ts`: the paused branch stores the fallback unless the last non-visitor message already is it (D2), before any triage or retrieval; the gate itself is unchanged, so ADR-013's per-segment check still applies.
- `setAiPaused` is one conditional `update … where ai_paused = !target … returning`, so the race loser writes no audit (D3); audit payload `{}` with user and tenant IDs only (ADR-014).
- Realtime: `ai_status` is filtered out of the visitor socket (`apps/realtime/src/app.ts`), so the dashboard nudge never reaches visitors.
- Playwright runs `workers: 1`, and the spec resumes in `afterEach`, so pausing the shared dev tenant can't break other specs.

## Findings

- Partial (recorded, not blocking): UC-31 step 3 staff replies and GOV-08 lead capture, as above. T4's "done when" listed "a staff reply is stored", which the build didn't meet because no staff send route exists; the owning features are FEAT-042/043.
- Deviation accepted: resume mode uses `role="alertdialog"` (ui-design: `dialog`), because `ConfirmDialog` always is one. It is still announced with its name and description; harmless.
- Deviation accepted: on a 403 the confirm button is disabled rather than hidden. Same effect, and the alert explains why.
- Observation: the Agent's tooltip is CSS hover/focus with no Esc dismiss; WCAG 1.4.13 asks for dismissal. Low impact (one short line, doesn't cover content); worth fixing when a shared tooltip component lands.
- Observation: if a tenant is paused, resumed and paused again with no AI reply in between, the visitor's next message gets no new fallback (the last reply already is it). Arguably right.

## RTM

Test ref appended: GOV-08 (partial: lead capture on the fallback with FEAT-049; staff replies while paused with FEAT-042/043).

## CI

Widget, dashboard and a new E2E spec changed, so GitHub CI (`ci.yml`, workflow_dispatch on `feat/FEAT-057-kill-switch`) decides the E2E and axe rows above. 

GitHub CI run 74, `6dd5f6f`, 2026-10-28: all jobs green, including E2E `kill-switch.e2e.ts` (both tests, axe light and dark, 375 px) in Chromium, Firefox and WebKit. Run 73 before it (`4230e11`) failed in Chromium at the composer check: the test's `getByLabel('Message')` also matched the paused notice region (see Corrected tests); it was cancelled once the cause was clear. The E2E rows of the audit table pass on run 74.
