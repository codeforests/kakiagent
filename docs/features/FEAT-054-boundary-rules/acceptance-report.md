# Acceptance Report: FEAT-054 — Boundary rules with safe defaults

> Verdict: **Accepted** (pending GitHub CI on the PR branch; run recorded under CI) · Date: 2026-10-30
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-11) · Sources: SRS v0.4 (APR-01, AUTH-03 "change boundary rules", GOV-01, ONB-06, ONB-09), use-cases v0.4 (UC-29 steps 1–3), ADR-005, ADR-008, ADR-014, ADR-025
> Repo state audited: `5871f83` (implementation head); one E2E step corrected (see Corrected tests)

## Verdict summary

FEAT-054 is accepted. Each of AC-1..AC-11 has tests that assert what the criterion says, and the criteria encode APR-01 faithfully: all five rule kinds are configurable, the defaults are safe (no topics, 0% discount, quotes need approval, all four commitments forbidden), and every save is one `rules.updated` audit entry with field codes only. UC-29's three steps map to AC-1, AC-2 and AC-3/AC-5. Enforcement of the stored discount and quote values at dispatch is FEAT-055's APR-02 (D4); until then every discount offer in text is blocked, which is stricter than APR-01 asks, so APR-01 isn't partial.

The test diff adds files and cases only. Changed existing tests: `dispatch.test` (the boundary refusal case now decides from real rules instead of `null`; still asserts the refusal), `plan.test` (TRIAGE_SYSTEM gains `blocked`; a stronger assertion added), `coach.test`/`replay-dispatch.test`/`turn.int` (fixtures pass `SAFE_DEFAULTS` or `rulesVersion`), `privacy.e2e` (setup caption copy changed by ui-design). Nothing loosened, skipped or deleted.

## Audit standard

APR-01 (M): "allowed topics, blocked topics, maximum discount (default 0%), whether quotes need approval (default yes), forbidden commitments (delivery guarantees, refunds, legal or medical advice). Defaults are safe. Changes are recorded in the audit log." UC-29: open pre-filled with safe defaults or the industry template → edit → re-authenticate, save, apply to the next reply, audit. Every clause has a criterion; no misencoding found.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 | APR-01 defaults; UC-29 1; ONB-06 | approvals `rules.int` "runs on the safe defaults…", api `rules.int` "shows the F&B template…", tenancy `templates.test`, agent `boundary.int` "runs on the safe defaults…" | Yes: `version: null`, the four forbidden keys, `source` default vs template, no triage tail | Pass |
| AC-2 | APR-01 config; UC-29 2 | api `rules.int` "Owner and Admin save…", "refuses invalid rules with 400…", contracts `rules.test`, approvals `rules.test` normalisation | Yes: response and reload carry the new version; duplicates, both-lists, missing locked key, 101% → 400 with paths | Pass |
| AC-3 | AUTH-03; UC-29 3 | api `rules.int` stale re-auth → 403, nothing written; Agents 403 both routes; `rules.e2e` (re-auth dialog then save) | Yes | Pass (E2E in CI) |
| AC-4 | APR-01 audit; GOV-01; ADR-014 | api `rules.int` (one entry per save, actor, `changed` codes, no topic text), approvals `rules.int` stale/concurrent, RLS "never updates or deletes" | Yes | Pass |
| AC-5 | UC-29 3 | agent `boundary.int` "refuses a blocked topic on the next turn after a save" (`rulesVersion` = saved version), `coach.int` "refuses a blocked topic as a visitor would" | Yes | Pass |
| AC-6 | APR-01 blocked topics; ADR-025 | `boundary.test` phrase/CJK/plural cases and `applyBoundary`; `boundary.int` phrase, paraphrase via triage, zh, other tasks still dispatched, only the triage call made, `guardrail.boundary_topic` | Yes | Pass |
| AC-7 | APR-01 commitments; ADR-008 d3 | `boundary.test` offer/guarantee/refund/custom (en, zh) and the negatives ("We don't offer discounts" passes), unticked keys stop their check; `boundary.int` regenerate once → escalation, audited | Yes | Pass |
| AC-8 | APR-01; ADR-025 d2 | approvals `rules.test` `commitmentDecision` table; `boundary.int` "gives the dispatcher the rules in force"; coach and replay contexts take rules | Yes | Pass |
| AC-9 | ONB-09; SCR-APP-009 | approvals `rules.int` (`rulesSaved` false → true); `privacy.e2e` caption; setup page read against ui-design | Yes | Pass (E2E in CI) |
| AC-10 | ADR-005 | RLS suite (read/insert across tenants, no update/delete, visitor select only), api `rules.int` "keeps tenants apart" | Yes | Pass |
| AC-11 | SCR-APP-042/009; design.md §4.10 | `lib/rules.test` (`diffRules`, `topicError`, `rulesFieldErrors`), `rules.e2e` (confirm → toast, axe light/dark, 375 px) | Yes | Pass (E2E in CI) |

## Corrected tests

- `rules.e2e.ts` (AC-11): GitHub CI's WebKit run reported axe `target-size` on the last two topics' Remove buttons at 375×800, where the fixed tab bar covered them. The buttons are `icon-button` size (44 px on touch); the overlap is the scroll position, not the control. The phone-width axe check now runs at 375×5000, as `conflicts.e2e.ts` does; the 375 px no-sideways-scroll check is unchanged. Nothing is skipped or loosened: the same axe rules run over the whole page.

## Independent execution

Run fresh in this session at `5871f83`: `pnpm format:check`, `pnpm lint` (ESLint + dependency-cruiser), `pnpm typecheck` pass; `pnpm test` 24/24 tasks pass; `test:coverage` (unit + integration through `scripts/test-env.sh`) passes for approvals (13), agent (457), db (152, incl. RLS), tenancy (44); api 293 pass, the one failure is `uploads.int` "the S3 presigner", which needs a container runtime (no Docker here; unrelated to this feature, known). `pnpm eval`: 261 cases, every subset at threshold, `boundary` 13/13. E2E (`rules.e2e`, `privacy.e2e`) and api coverage thresholds run in GitHub CI.

## Direct verification

- Audit payloads: `rules.updated` carries `{ version, changed }` only; guardrail entries carry `kind` only; the integration tests assert no topic or reply text reaches the chain (ADR-014).
- Invariants: tenant ID from the session in `apps/api/src/rules.ts`; forced RLS and policy in `0038`, name in `TENANT_SCOPED_TABLES`; no update/delete grant; enforcement through `applyBoundary` → dispatcher and the compose guard chain, no side path (ADR-025, ADR-008); the leak guard's tag list gained `rules`.
- Screens: `rules-parts.tsx`, `rules.tsx`, `setup-rules.tsx` checked against ui-design's copy, states and a11y notes (prefill alerts, confirm title and change lines, toast, 409 alert with "Your changes will be lost.", load error, "Always on" chips, sr-only "(percent)", live region, Approvals caption, setup lede and caption). Only `var(--…)` tokens; no hard-coded colours or pixels.

## Findings

None blocking. Note for FEAT-055: D4's always-on discount guard and `commitmentDecision` are its starting points (design §8).

## RTM

APR-01 Test ref appended; AUTH-03's partial note gains this feature's "change boundary rules" re-auth.

## CI

Pending: GitHub CI on `feat/FEAT-054-boundary-rules`.
