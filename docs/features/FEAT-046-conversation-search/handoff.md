# Handoff: FEAT-046 — Conversation search
Branch: feat/FEAT-046-conversation-search · PR: none · Updated: 2026-11-03 by design
Stage done: design
Next: build (backend, T1–T4) — kickoff: "Build FEAT-046 (backend) on branch feat/FEAT-046-conversation-search.
Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."
Then: build (UI, T5–T7) — kickoff: "Build FEAT-046 (UI) on branch feat/FEAT-046-conversation-search. …stage build."

## What the next stage needs
- No new table. One migration (0047): `pg_trgm` + `btree_gin` extensions and a composite GIN index on `messages (tenant_id, body gin_trgm_ops)`; declare the index in `schema.ts` with `.op('gin_trgm_ops')` so drizzle shows no drift.
- Search is `POST /api/v1/conversations/search` (D3): the text must never be in a URL, log, audit entry or browser storage. Don't add a GET variant.
- Matching is `ILIKE '%q%'` on masked bodies (D2), q masked with `piiMask` first, LIKE metachars escaped, SG phone queries expanded to three spellings (D6). Order by `last_message_at desc, id desc`, reusing `encodeCursor`/`decodeCursor`, `namedPeople`, `toSummary`.
- Contact fields (name/email/phone) are not searchable yet: `contacts` comes with FEAT-049 (D1). Keep `searchConversations` easy to extend with a second `hits` source.
- T3's volume test is the INB-11 performance proof (≤ 2 s, 60k conversations / 480k messages); record timings and plan lines. If the CTE is slow on a common term, try the `exists` form (design §5.1).
- pg_trgm only indexes CJK when the cluster's LC_CTYPE isn't `C`; results stay correct either way. If the 2-character Chinese timing fails locally, check `SHOW lc_ctype` before changing the design.

## Left to CI or later
- E2E (`inbox-search.e2e.ts`) and screen renders run in the verify stage's GitHub CI.

## Pending for Ken
- None. D1 decided 2026-11-03: Ken chose message text now, contact fields in FEAT-049.
