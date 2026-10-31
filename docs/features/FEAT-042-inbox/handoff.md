# Handoff: FEAT-042 — Real-time inbox, conversation view, context sidebar, lifecycle and auto-close
Branch: feat/FEAT-042-inbox · PR: none · Updated: 2026-10-31 by build (backend)
Stage done: build (T1–T4 of 9)
Next: build (UI, T5–T9) — kickoff: "Build FEAT-042 (UI) on branch feat/FEAT-042-inbox. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (`apps/api/src/inbox.ts`): `GET /api/v1/conversations?view&channel&cursor&limit` → `ConversationList` `{ conversations, nextCursor, counts }`; `GET /api/v1/conversations/:id` → `ConversationThread`; `GET /api/v1/conversations/:id/messages?before=<seq>` → `ThreadPage`; `POST /api/v1/conversations/:id/close` body `{ version }` → `{ conversation }`. Errors: 400 `bad_cursor`, 404 `not_found`, 409 `already_closed`, 409 `state_changed` with `{ conversation }` (a summary, no version: refetch the thread for the new version).
- Contracts (inbox section at the end of `packages/contracts/src/index.ts`): `InboxView`, `InboxCounts`, `ConversationListQuery`, `ThreadMessage`, `ThreadEvent`, `FactChip`, `IntentSignal`, `ContextSidebar`, `ConversationThread`, `ThreadPage`, `CloseConversationBody`, `CloseConversationResponse`. `ConversationStatus`/`CloseReason` sit next to `ConversationSummary` (which gained `closeReason`, `closedAt`). `ConversationList` moved to the inbox section.
- **Deviation from §3:** `ThreadEvent` has `kind: 'state' | 'flagged'`; a flag divider has `from`/`to` null and `reason` `abuse | crisis`. A state divider's `reason` is a close reason or `reopened` (`null` for FEAT-043+ edges). Actor `name` is filled only for `user` (display name, else email local part).
- Inline fact chips: label each `message.factIds` entry from `sidebar.facts` (it covers every agent message in the conversation, older pages too); an ID missing there is a deleted fact, show nothing.
- Close publishes `conversation` on `channels.inbox`; so do auto-close (agent-worker) and reopen (widget message route already publishes the summary). Realtime is unchanged.
- `apps/dashboard/src/pages/inbox.tsx` only got labels for the two new states so typecheck stays green; T6 replaces it. Dashboard `lib/api.ts` still calls `conversations()` with no query and reads `.conversations`.
- Fact chips live in `packages/kb/src/chips.ts` (not `facts.ts`: `corrections.ts` imports `facts.ts`, so `factLabel` there would cycle); identity `memberNames` in `names.ts`; inbox `mappers.ts` holds `toMessage`/`toSummary` (moved so `views.ts` doesn't cycle through the index). Add these and the §T9 items to `code-map.md`.
- Contracts also gained `AutoCloseJob` and `TurnQueueJob` (the agent-worker parses the union); scheduler-worker now depends on `@kaki/inbox`.

## Checks run here (all green)
- `pnpm typecheck`, `pnpm lint` (incl. dependency-cruiser), `pnpm format:check`, `pnpm test` (all packages).
- Integration via `scripts/test-env.sh`: db (rls suite + FEAT-042 block), inbox (new `lifecycle.int.test.ts`, `views.int.test.ts`), kb, identity (new `names.int.test.ts`), agent (turn + safety), api (new `inbox.int.test.ts`, widget-controls). `uploads.int.test.ts` needs an S3 endpoint here (no Docker), unrelated.

## Left to CI or later
- E2E (`inbox.e2e.ts`) and screen renders run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken (non-blocking; in /mnt/project-files/pending-actions.md)
- INB-01's assignee filter moves to FEAT-043 (no owners exist before it).
- Intent "current page / pages viewed / UTM" needs widget page context; no feature row covers it yet.
