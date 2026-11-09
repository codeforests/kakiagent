# Handoff: FEAT-036 — Email channel
Branch: feat/FEAT-036-email-channel · PR: https://github.com/codeforests/kakiagent/pull/61 · Updated: 2026-11-09 by verify
Stage done: verify (accepted)
Next: FEAT-037 design, when Ken says — kickoff: "Design FEAT-037. Branch feat/FEAT-037-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- FEAT-037/040 reuse `channels/src/deliver.ts`, the `messages_channel_delivery` trigger and `ai_reply_cap` unchanged (design §8).
- The dev tenant's email channel is set up but offline after `email-channel.e2e`.
- E2E: `ConfirmDialog` is `role=alertdialog`.

## Left to CI or later
- Live mail checks at MD (mail-tester, real Gmail/Outlook threading, SES receipt rule, bounce alarm).
- Two FEAT-009 tests fail on SG public holidays (acceptance-report F1); fix with a non-holiday date.

## Pending for Ken
- F2: email footer links the privacy notice only for link-mode notices (pending-actions.md).
