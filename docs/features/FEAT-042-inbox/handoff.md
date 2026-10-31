# Handoff: FEAT-042 — Real-time inbox, conversation view, context sidebar, lifecycle and auto-close
Branch: feat/FEAT-042-inbox · PR: none · Updated: 2026-10-31 by design
Stage done: design
Next: build (backend, T1–T4) — kickoff: "Build FEAT-042 (backend) on branch feat/FEAT-042-inbox. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Column stays `conversations.status`, value `ai` kept; adds `escalated`, `waiting_approval` (D1). Every status write goes through `transition` in `packages/inbox/src/lifecycle.ts` (compare-and-set on `version`, one audit entry); `endAiConversation`/`endVisitorConversation` are re-plumbed onto it and keep their audit action names (D6).
- Two existing assertions gain `from`/`to` in the payload (stricter, not weaker): `packages/agent/test/safety.int.test.ts` (`conversation.ai_ended`), and the visitor-ended checks in `packages/inbox/test/inbox.int.test.ts` / `apps/api/test/widget-controls.int.test.ts` if they compare payloads.
- Auto-close: SQL function `inbox_queue_auto_close()` (owner NOLOGIN `kaki_inbox_timer`, copy 0029's `kaki_stale_scan` setup) queues `{ kind: 'auto_close', … }` on the existing `conversation-turns` topic; the agent-worker closes it (visitor zone has audit) and publishes. No new queue or infra (D3).
- Gate: open unless `human` or `closed` (D2).
- Thread dividers read `audit_entries` by `subject_refs` (GIN index exists); names via new identity `memberNames` (identity zone) (D7).
- Keep the skeleton testids (`live-state`, `conversation-list`, `conversation-row`, `conversation-preview`) and land on `/inbox` with no query string (e2e `support.ts`).
- `GET /api/v1/conversations` moves out of `app.ts` into `apps/api/src/inbox.ts`; default view `open`.

## Left to CI or later
- E2E (`inbox.e2e.ts`) and screen renders run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken (non-blocking; in /mnt/project-files/pending-actions.md)
- INB-01's assignee filter moves to FEAT-043 (no owners exist before it).
- Intent "current page / pages viewed / UTM" needs widget page context; no feature row covers it yet.
