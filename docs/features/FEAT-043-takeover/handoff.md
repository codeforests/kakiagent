# Handoff: FEAT-043 — Take over and hand back, single owner
Branch: feat/FEAT-043-takeover · PR: none · Updated: 2026-10-31 by design
Stage done: design
Next: build (backend, T1–T5) — kickoff: "Build FEAT-043 (backend) on branch feat/FEAT-043-takeover. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- The race is decided by `insert … on conflict do nothing` on `conversation_owners` (D2), then `transition(→ human)`; `transition` itself deletes the owner row on `→ closed` and `human → ai`, so every close path clears it.
- Visitor-facing name = display name only, snapshotted at take-over through the identity zone (`displayNameOf`, D3); staff-facing names stay `memberNames`.
- `messages` `tenant_isolation` policy is FOR ALL; the dashboard's insert is narrowed by a restrictive policy (§4).
- FEAT-042's db grant assertion on `last_message_at` flips by design (D5); say so in the commit.
- Seed gains `agent@kaki-bakery.test` ("Mei Ling", agent) for the E2E (T1).
- D1 decided by Ken (2026-10-31): owners and admins can take from a teammate.

## Left to CI or later
- E2E `takeover.e2e.ts` and screen renders run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken
- None.
