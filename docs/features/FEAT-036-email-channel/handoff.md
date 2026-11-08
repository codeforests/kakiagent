# Handoff: FEAT-036 — Email channel
Branch: feat/FEAT-036-email-channel · PR: (draft, see below) · Updated: 2026-11-08 by build (UI)
Stage done: build (T1–T14 of 14), status developer-done
Next: verify — kickoff: "Verify FEAT-036 on branch feat/FEAT-036-email-channel. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: SCR-APP-038 `apps/dashboard/src/pages/email-channel.tsx` + `email-channel-parts.tsx`, `lib/email-channel.ts`; Channels changes in `channels.tsx`/`channels-parts.tsx`; inbox in `lib/inbox.ts` (`CHANNELS`, `channelOf`, `PARTY_LABEL`, `deliveryText`, `attachmentStatus`, `fileSize`), `conversation-parts.tsx` (`DeliveryLine`, `Attachments`, new glyphs), `inbox-row.tsx`, `conversation.tsx`.
- UI deviations (tasks.md T11): `echo` ignored mail is shown as a loop; "Email customer" when an email conversation has no contact name; failed Retry shows the thread's toast.
- The E2E spec leaves the dev tenant's email channel **set up but offline** (setup can't be undone through the API). Later specs now see an Email card on Channels and email conversations in the inbox; if a phone-width axe spec trips on the longer list, give it the 5000 px viewport (memory lesson from FEAT-056).
- Backend notes from the backend handoff still hold: `EMAIL_IDENTITY_PROVIDER=fixture`, `.test` domains verify on the first check, `pnpm email:receive <file.eml>`; reply-cap/domain bodies answer 422; the receive/deliver int tests live in `apps/agent-worker/test/`.
- Footer GOV-14 question still open for verify (template notice shows the business name only).

## Left to CI or later
- `email-channel.e2e.ts` and all renders: GitHub CI in verify (no Docker here). Its first live run may need small selector fixes; the risky steps are the Mailpit header names (`In-Reply-To`, `References` from `/message/:id/headers`) and the fake provider replying to "what time do you open?" by email.
- Terraform: tested on mocked providers, not applied (MD). MD checks as in the backend handoff (SES receiving in ap-southeast-1, `dns_records` output at the DNS host).
- Known time-of-day failures, not this feature: agent `language-hours` "closed today", api `escalation.int` (after hours SGT); api `uploads.int` needs LocalStack.

## Pending for Ken
- Nothing blocking.
