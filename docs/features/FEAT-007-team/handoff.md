# Handoff: FEAT-007 — Team, invitations, roles, approval-rights grants, tenant switcher
Branch: feat/FEAT-007-team · PR: https://github.com/codeforests/kakiagent/pull/42 · Updated: 2026-10-31 by verify
Stage done: verify (accepted, pending GitHub CI green)
Next: merge on Ken's go-ahead, then FEAT-008 design — kickoff: "Design FEAT-008. Branch feat/FEAT-008-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- `canApprove(…)` and `Me.canApprove` exist for the approvals features (FEAT-045/046); approval rights live on `memberships.approval_rights`.
- `channels.member(tenantId, userId)` + `session_ended` closes a member's sockets; reuse it for any later forced sign-out.
- FEAT-008 (My account) can show the switcher's workspace list from `GET /api/v1/workspaces`.

## Left to CI or later
- E2E `team.e2e.ts` and the two-step leftovers: GitHub CI only.
- Google sign-in to join (D4): no end-to-end test (needs a real Google account).

## Pending for Ken
- Merge approval for PR #42 once CI is green.
