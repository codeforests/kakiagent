# Handoff: FEAT-046 — Conversation search
Branch: feat/FEAT-046-conversation-search · PR: https://github.com/codeforests/kakiagent/pull/52 · Updated: 2026-11-03 by verify
Stage done: verify (accepted; INB-11 partial)
Next: merge after Ken's go-ahead; then FEAT-049 design — kickoff: "Design FEAT-049. Branch feat/FEAT-049-<slug> (create it from main).
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- FEAT-049 must add contact name, email and normalised phone as another `hits` source in `searchConversations` (`packages/inbox/src/search.ts`) and its tests; the contract doesn't change (D1). Then INB-11's Test ref can lose "partial".
- Search reads go through SECURITY DEFINER `inbox_search_hits()` (B1, accepted against ADR-005); a contacts source likely needs the same pattern for index use under RLS.

## Left to CI or later
- None: GitHub CI run 100 green (acceptance-report.md, CI).

## Pending for Ken
- Merge PR #52 (squash): CI is green.
