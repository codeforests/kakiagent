# Handoff: FEAT-036 — Email channel
Branch: feat/FEAT-036-email-channel · PR: none · Updated: 2026-11-08 by design
Stage done: design
Next: build (backend, T1–T10) — kickoff: "Build FEAT-036 (backend) on branch feat/FEAT-036-email-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Ten backend tasks: stop at a task boundary after about six (T6) and hand off a second backend session, then the UI session (T11–T14).
- Delivery is a trigger on `messages` (D2): don't add delivery calls to the existing writers. The trigger's only branch is `channel <> 'widget'`.
- Inbound arrives on SQS (SES → S3 → SNS → SQS), not the generic `/hooks/:kind/:id` route; `verifyInbound` checks the SNS topic ARN and bucket.
- `appendVisitorMessage` needs an option to skip the turn job for an attachment-only email with no text (§5.1); `createConversation` gains a `channel` parameter.
- `IgnoreReason` gains `spam`, `unsafe`, `bounce`; the page's `EmailIgnoreReason` adds `list` and `loop` (stored in `inbound_events`).
- SES rewrites `Message-ID`: store ours and `<sesId>@<SES_MESSAGE_ID_DOMAIN>`; check the SES ID domain format against live AWS docs.
- `EMAIL_IDENTITY_PROVIDER=fixture` (a `.test` domain verifies on first check) is dev/test only and refused when `KAKI_BUILD=production`.
- Capability for the routes is `settings.manage` (as Channels); retry uses `inbox.reply`, download `inbox.read`.
- New dependency: `mailparser` (pin exact). Migration is `0053`.

## Left to CI or later
- E2E (`email-channel.e2e.ts`) and screen renders: GitHub CI in verify (no Docker here).
- Terraform is written and tested, not applied (MD). Real Gmail/Outlook threading and mail-tester at MD.

## Pending for Ken
- Nothing blocking. Decisions taken in the design (D1 forward-in/custom-domain-out, D3 offline email silent by default, D7 cards don't travel by email) are listed in technical-design §7 for him to overrule.
