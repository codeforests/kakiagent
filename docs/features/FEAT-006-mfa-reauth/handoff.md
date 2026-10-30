# Handoff: FEAT-006 — Two-step verification and re-authentication
Branch: feat/FEAT-006-mfa-reauth · PR: https://github.com/codeforests/kakiagent/pull/38 · Updated: 2026-10-30 by verify
Stage done: verify (accepted, pending GitHub CI green)
Next: Ken's review and squash-merge; then the next feature (FEAT-054) only after Ken says go — kickoff: "Design FEAT-054. Branch feat/FEAT-054-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- FEAT-054 (boundary rules) is the first sensitive action: wrap its route in `requireReauth` (`@kaki/identity`) and its dashboard mutation in `useReauthGuard().guard` (design D9).
- One test strengthened in verify (AC-3: TOTP re-auth locked too); see acceptance-report.md.

## Left to CI or later
- E2E (three browsers), axe, `terraform validate`, the Docker-only S3 and Valkey suites: GitHub CI on the PR.
- Forced enrolment and Admin/Agent read-only Team in E2E once FEAT-007 adds members.

## Pending for Ken
- Merge approval. Lost-authenticator reset is already in pending-actions (design §8 item 2).
