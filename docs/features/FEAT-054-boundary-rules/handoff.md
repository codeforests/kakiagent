# Handoff: FEAT-054 — Boundary rules with safe defaults
Branch: feat/FEAT-054-boundary-rules · PR: none · Updated: 2026-10-30 by build (backend)
Stage done: build (T1–T6 of 11)
Next: build (UI, T7–T11) — kickoff: "Build FEAT-054 (UI) on branch feat/FEAT-054-boundary-rules. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes: `GET /api/v1/settings/rules` → `BoundaryRulesResponse` (`rules`, `version` null until saved, `savedAt`, `source` saved|template|default); `PUT` with `SaveBoundaryRulesRequest` (`{ version, rules }`) → the same response. Contracts in `@kaki/contracts` (section "boundary rules"): `BoundaryRules`, `COMMITMENT_KEYS`, `LOCKED_COMMITMENTS`, `BOUNDARY_LIMITS` (25 topics, 10 custom, 2–80 chars) for `topicError`.
- Errors: 400 `{ error: 'invalid_rules', fields: { 'rules.blockedTopics.1': 'duplicate' | 'also_allowed', 'rules.forbiddenCommitments': 'locked', '<path>': 'too_big' | 'too_small' | 'invalid' } }` (validated before re-auth, D7); 403 `reauth_required` (`ReauthRequired`, so `useReauthGuard().guard` handles it); 409 `rules_stale`; 403 `forbidden` for Agents.
- The server normalises (trim, collapse spaces, case-insensitive dedupe), so the response can differ from what was sent: show the response's rules after a save.
- Dev tenant Kaki Bakery is F&B: before a save, GET returns `source: 'template'` with the F&B topics; second tenant may be `default`.
- E2E: the blocked-topic refusal text is `textsFor(lang).blockedTopic(business)` (en "Sorry, I can't help with that here. I'm happy to help with other questions about {b}."). The fake model offers a guarantee or a special price when asked ("guarantee", "special price", 保证, 打折), then defers on regeneration; the visitor sees "I'll check that with the team and get back to you."
- `afterEach` in `rules.e2e.ts`: no delete grant on `boundary_rules`, so restore by saving `SAFE_DEFAULTS` from the current version (the history grows; that's fine).

## Deviations and notes from the backend build
- `blocked_topic` lead's outcome is `out_of_scope` (not `refused`), and coaching's explainer reason for it is `out_of_scope` (no new `ReasonCode`, so no contract change).
- The verifier's existing `policy` rule already blocks the words "guarantee", "refund", "money back", 保证, 退款; the boundary guard adds the phrasings it misses ("will definitely arrive", 一定会送达), discount offers and custom phrases. Its audit actions are `guardrail.boundary_commitment` / `guardrail.boundary_discount` (instead of `segment_blocked`).
- Leak guard markers now include `<rules>`. New eval subset `boundary` (13 cases, threshold 1.0 in `thresholds.json`).
- `@kaki/approvals` is a devDependency of `@kaki/contracts` (the key-match test only).

## Left to CI or later
- E2E (`rules.e2e.ts`), screen renders and axe: verify stage's GitHub CI (no Docker here).
- `uploads.int.test.ts` (S3 presigner) can't run in cloud sessions without Docker/LocalStack; the other 22 API suites pass.

## Pending for Ken
- None.
