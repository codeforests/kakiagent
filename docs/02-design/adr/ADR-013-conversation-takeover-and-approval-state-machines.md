# ADR-013: Conversation, takeover and approval state machines with database-enforced concurrency

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** NFR-04, INB-02, INB-05, INB-08, INB-09, APR-02, APR-03, APR-04, APR-06, GOV-08, AGT-06, AGT-09, LED-09, ONB-10, UC-22, UC-23, UC-31

**Context**
Several Must requirements are about exactly-once human decisions under concurrency: only one staff owner of a takeover, and two simultaneous presses yield exactly one winner (INB-09); an approval is decided once, first decision wins, and expires after 7 days (APR-06); while a human owns the conversation the AI sends nothing (INB-02); the kill switch stops the AI on every channel within 5 seconds (GOV-08); and nothing from `draft_approval` reaches the visitor before a decision (AGT-06, APR-02). Mobile approval uses signed, single-use, 24-hour links that still need login (APR-03).

**Decision**
1. **Conversation state** (`ai_handling`, `escalated`, `human`, `waiting_for_approval`, `closed`) lives in a `conversations.state` column with a `version`. Transitions go through one function that applies the INB-08 rules, writes the audit entry and resets timers, using compare-and-set: `UPDATE … SET state=$new, version=version+1 WHERE id=$id AND version=$expected`.
2. **Takeover** is a row `conversation_owner(conversation_id PK, user_id, since)`. "Take over" is `INSERT … ON CONFLICT DO NOTHING RETURNING`; the loser gets the current owner's name (INB-09). Hand-back deletes the row and returns the state to `ai_handling`.
3. **The AI send gate.** Before every agent turn *and* before every outbound AI message is dispatched, the worker checks `ai_allowed(tenant, conversation)`: tenant not paused (kill switch), channel live (ONB-10), no human owner, state not `closed`. The kill-switch flag is written to Postgres and published on Valkey pub/sub; workers cache it for at most 2 seconds, so the 5-second target holds even for replies already mid-stream. The streaming loop re-checks between segments and stops cleanly.
4. **Approvals:** `approvals(status: pending | approved | edited_approved | rejected | expired | undeliverable, decided_by, decided_at, version)`. A decision is a conditional update `WHERE status='pending'`; zero rows updated means "already decided by X" (APR-06). Delivery of an approved result is an outbox message to the conversation's **latest** channel, even if the conversation has closed; if no channel can reach the contact it becomes `undeliverable` and staff are alerted (UC-22 6a). Timers: SLA breach → escalation; 7 days → `expired` plus a visitor notice.
5. **Approval links (APR-03):** an HMAC-signed token `{approvalId, userId, exp ≤ 24h, nonce}`. Opening it requires an authenticated session for that user (or sign-in, then continue), and the nonce is consumed on first use in a `used_link_nonces` table. Expired or reused links show the in-app queue instead.

**Options considered**
- **Database row-level atomicity (chosen)** — Postgres guarantees the single winner; behaviour is simple to test with parallel requests. Con: every decision touches the primary database, which is trivial at this volume.
- **Distributed locks in Valkey** — fast. Lost: locks can expire or be lost on failover, giving two winners — the exact failure INB-09 and APR-06 forbid.
- **Actor-per-conversation runtime** — elegant serialisation. Lost: new infrastructure; the SQS FIFO group plus compare-and-set already serialise per conversation.

**Consequences**
Concurrency acceptance tests (two simultaneous takeovers, two simultaneous approvals) are integration tests against a real Postgres. Every state transition produces exactly one audit entry. The send gate is the single place that answers "may the AI speak now?", which keeps GOV-08 and INB-02 provable.
