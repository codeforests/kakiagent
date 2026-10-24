# Handoff: FEAT-018 — Correction queue, stale-fact scan and old-versus-new replay
Branch: feat/FEAT-018-correction-queue · PR: none · Updated: 2026-10-24 by design
Stage done: design
Next: build (backend, T1–T6) — kickoff: "Build FEAT-018 (backend) on branch feat/FEAT-018-correction-queue. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Migration is `0029_corrections_queue.sql`. The stale scan copies 0009's governor pattern (NOLOGIN owner, SECURITY DEFINER, EXECUTE to `app_outbox` only).
- The `corrections` table and its seven sources already exist (0027); FEAT-018 adds `accepted_change`, the `reconfirm` change kind and the open-stale unique index. Keep `confirmCorrection` as the coaching wrapper of the new `acceptCorrection` so FEAT-027's route and tests are untouched.
- Re-confirm follows ADR-010 (a new version, same value): bump `kb_chunks.fact_version` in place, no re-embed.
- Correction replay reuses `replayQuestion` as is; the replay.ts changes are small (§5.4): `replay_conversation_id` on each answer (cascade per answer, D9), abuse count per conversation, origin checks.
- Only accepted fact edits replay (D3); the set is fixed at acceptance, newest 20 before `decided_at` (D4).
- New routes live in `apps/api/src/corrections.ts`; capability `kb.manage`. The coach confirm route also starts the replay and returns `replayQuestions`.
- UI session: move FEAT-028's `answer-compare` row to `pages/answer-compare.tsx` first, then build both screens on it.

## Left to CI or later
- E2E `corrections.e2e.ts` and screen renders: CI only (STATE.md).

## Pending for Ken
- Nothing blocking. Design calls taken without a card (D3 no replay for FAQ/hours/re-confirm, D6 per-type intervals on the Corrections screen) are in technical-design §7.
