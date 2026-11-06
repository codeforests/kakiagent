# Handoff: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry
Branch: feat/FEAT-055-approvals · PR: https://github.com/codeforests/kakiagent/pull/54 · Updated: 2026-11-06 by verify
Stage done: verify (accepted)
Next: merge (Ken), then FEAT-056 design — kickoff: "Design FEAT-056. Branch feat/FEAT-056-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- `acceptance-report.md` has the audit table and findings. FEAT-056 adds the signed single-use link in the `approval_pending` alert (`linkFor('approval_pending')`) and SCR-APP-018's link-expired and reused states.
- Verify corrected two tests: FEAT-045's flaky `suggest.int` audit check, and a keyboard-only rejection in `approvals.e2e.ts` (AC-13).
- UI deviations accepted as minor (report F2); ui-design may adopt them later.

## Left to CI or later
- `apps/api` `uploads.int` needs LocalStack (CI only).
- Pre-existing date flake: tenancy `profile.int` fails on 5–6 Nov 2026 (Deepavali); passes from 7 Nov.

## Pending for Ken
- Review and squash-merge PR #54.
