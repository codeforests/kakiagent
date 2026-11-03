# Handoff: FEAT-046 — Conversation search
Branch: feat/FEAT-046-conversation-search · PR: https://github.com/codeforests/kakiagent/pull/52 (draft) · Updated: 2026-11-03 by build (UI)
Stage done: build (T1–T7 of 7), status developer-done
Next: verify — kickoff: "Verify FEAT-046 on branch feat/FEAT-046-conversation-search.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `lib/search.ts` (pure helpers + an in-memory store: `useInboxSearch`, `setSearchText` with the 300 ms debounce, `commitSearch` on Enter, `resetInboxSearch` on Escape/Clear/workspace switch, `focusInboxSearch` for the top bar). `pages/inbox-search.tsx` (`SearchField`, `SearchResults`); `Row` moved from `inbox.tsx` to `pages/inbox-row.tsx` and takes `preview`, `linkState`, `onOpen`.
- `search.active` follows the typed text (2+ code points): tabs and filters give way at once; the query commits after the pause, so the skeleton shows "Searching…" until then.
- Opening a result: router state `{ matchId }` → `ConversationPane` → `ThreadLog` (keyed `id:matchId`) centres `[data-message-id]` on first layout and `Bubble` gets `bubble--match` / `data-match="true"`.
- Top bar button (`shell/app-shell.tsx` `SearchButton`): on `/inbox`, or any `/inbox/*` at ≥ 1024, it only focuses; elsewhere it navigates with `{ focusSearch: true }`, which the field consumes and replaces away.
- Results links keep the list's filter query string (`qs`), never the search text.
- Build note B1 (backend) still to check against ADR-005.

## Left to CI or later
- E2E `e2e/tests/inbox-search.e2e.ts` and screen renders: GitHub CI in the verify stage. If the fake model echoes the word, the latest match may be the agent's message; the spec allows either author.
- `apps/api` `uploads.int.test.ts` needs S3; fails in cloud sessions only, so `@kaki/api test:coverage` thresholds weren't reported here.

## Pending for Ken
- None.
