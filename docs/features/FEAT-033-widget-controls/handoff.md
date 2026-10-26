# Handoff: FEAT-033 — Widget visitor controls and EN / 中文 chrome
Branch: feat/FEAT-033-widget-controls · PR: https://github.com/codeforests/kakiagent/pull/34 · Updated: 2026-10-26 by verify
Stage done: verify (accepted; E2E pending Ken's local CI)
Next: Ken's local CI on this branch, then squash-merge on his go; then design FEAT-058 on his go — kickoff: "Design FEAT-058. Branch feat/FEAT-058-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- FEAT-058 fills `WidgetConfigResponse.privacyNoticeUrl` (now hard-coded `null` in `apps/api/src/app.ts` config route); the widget menu item and footer line already render it (D1).
- FEAT-044 sets `controls.talkToPerson` and wires `onTalkToPerson` (D2). FEAT-042: visitor-ended inbox row (D4) and a row lock in `appendVisitorMessage` (report, Findings).

## Left to CI or later
- `e2e/tests/widget-controls.e2e.ts` (keyboard end, new chat, 中文 chrome, privacy link, axe light/dark), Firefox/WebKit: Ken's local CI.
- `apps/api/test/uploads.int.test.ts` "S3 presigner" needs Docker or `KAKI_TEST_S3_ENDPOINT` (fails on main too).

## Pending for Ken
- Run local CI on `feat/FEAT-033-widget-controls` and paste the summary; red E2E gets fixed before merge. Then approve the squash-merge.
