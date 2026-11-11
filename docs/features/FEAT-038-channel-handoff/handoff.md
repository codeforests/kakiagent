# Handoff: FEAT-038 — Continue on another channel with the history
Branch: feat/FEAT-038-channel-handoff · PR: none · Updated: 2026-11-11 by design
Stage done: design
Next: build (backend) — kickoff: "Build FEAT-038 (backend) on branch feat/FEAT-038-channel-handoff.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- The same conversation moves channel (D2): `inbox.moveConversation` flips `conversations.channel` from `widget`; the `messages_channel_delivery` trigger then delivers the recap and every later reply on the new channel. No new history loading in the agent.
- Identity: call FEAT-039's `attachVerified` with source `link` (0056 widens the `contact_identities` checks); the email path also sets the survivor's display `contacts.email` (D7), because `email/send.ts` sends to it.
- Codes are HMAC-signed (`HANDOFF_LINK_SECRET`), prefixes `c-` (Telegram, must not match `LINK_CODE` `link-…`) and `e-` (email); the outbox job carries only `linkId` (D4).
- Telegram redemption is a branch in `telegram/receive.ts` beside the alert-link branch; a group `/start` keeps today's leave path and doesn't consume.
- The email confirm page follows `apps/api/src/privacy.ts`'s HTML headers; GET never consumes (scanner-safe), POST checks the Origin.
- Add code-map lines (Schema 0056, channels `handoff/`, agent `handoffChannelHandler`, api `handoff.ts`) as the tasks land.

## Left to CI or later
- E2E (`handoff.e2e.ts`, T11) and axe run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken
- None. D1 decided 2026-11-11: no consent card before email handoff; the form states the purpose.
