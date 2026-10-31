# Handoff: FEAT-042 — Real-time inbox, conversation view, context sidebar, lifecycle and auto-close
Branch: feat/FEAT-042-inbox · PR: (draft, see the thread) · Updated: 2026-10-31 by build (UI)
Stage done: build (T1–T9 of 9), status developer-done
Next: verify — kickoff: "Verify FEAT-042 on branch feat/FEAT-042-inbox. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `pages/inbox.tsx` (list, both routes), `pages/conversation.tsx` (thread pane), `pages/conversation-parts.tsx`; data in `lib/inbox.ts`, `lib/realtime.ts`, `lib/media.ts`; styles in the FEAT-042 block of `app.css` (replaces the skeleton's `.badge--*`). `@kaki/ui` `SlideOver` gained an optional `className` (the details drawer / bottom sheet).
- Deviations: T6 and T7 are one commit (the inbox page renders the thread pane). View tabs keep the open conversation (`/inbox/:id?view=`). The drawer focuses its close button on open (Radix default), not the title; focus returns to "Conversation details" by hand (no Radix trigger). Close below 640 sits in a "More actions" menu. Inline fact chips refetch the thread on each live AI message (WebSocket messages carry no fact IDs).
- E2E edits outside the new spec, for the paginated Open view: `safety.e2e.ts` reads `?view=flagged`; `skeleton.e2e.ts` checks the new row is first instead of `count + 1`. Review these as part of the test diff.
- Rows carry `data-id` (the conversation ID) so E2E finds its own row among other runs'.
- Stubbed Chromium checks (scratch script, not committed) are summarised in tasks.md T7's note.

## Left to CI or later
- `inbox.e2e.ts` (3 tests) and the updated skeleton/safety specs run only in GitHub CI (no Docker here). The Reconnecting state wasn't exercised anywhere.
- `apps/api` `uploads.int.test.ts` needs an S3 endpoint (no Docker here), unrelated.

## Pending for Ken (non-blocking; in /mnt/project-files/pending-actions.md)
- INB-01's assignee filter moves to FEAT-043 (no owners exist before it).
- Intent "current page / pages viewed / UTM" needs widget page context; no feature row covers it yet.
