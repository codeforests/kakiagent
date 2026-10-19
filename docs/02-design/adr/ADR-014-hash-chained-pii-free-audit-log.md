# ADR-014: Hash-chained, PII-free audit log with a separate deletable PII store

**Status:** Accepted — Q5 (PII-free chain kept 12 months after tenant deletion) decided by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** GOV-01, GOV-02, GOV-05, GOV-06, D7, AUTH-07, AGT-05, AGT-06, KB-16, APR-02, DSH-06, NFR-06, UC-32, UC-30, J6

**Context**
GOV-01 requires an append-only, hash-chained log of agent decisions (reasoning summary, KB IDs retrieved, tool calls, guardrail results), human actions and admin events; any tampering must break a verification check. D7 requires entries to hold only IDs, masked values and hashes, with any personal data the entry needs kept in a separate store that is deleted with the contact, so that deleting a contact (GOV-05) leaves the chain verifiable (J6). GOV-02 needs filtered export of 30 days in ≤ 1 minute. D7 sets retention at the life of the tenant plus 12 months, and at least 24 months.

**Decision**
1. **One hash chain per tenant** (plus one platform chain for operator and cross-tenant events), in an `audit_entries` table:
   `tenant_id, seq (gap-free per tenant), ts, actor_type (agent | user | operator | system), actor_ref, event_type, subject_refs (IDs), payload (JSON: masked values, KB IDs, tool names and argument hashes, guardrail results, model and prompt version, rationale), pii_ref (nullable), pii_commitment (nullable), prev_hash, hash`.
   `hash = SHA-256(canonical_json(all fields except hash) ‖ prev_hash)`, using RFC 8785 canonical JSON so verification is deterministic.
2. **No personal data in entries.** Payload builders accept only typed, PII-free fields (IDs, enums, numbers, masked strings). The agent's "summary of reasoning" is a short structured rationale produced with the reply (intent, facts used by ID, rule applied), passed through the PII masker (ADR-015); it is not the model's raw thinking. Anything that needs personal data (for example, the consent wording plus the visitor's name for a consent record, or the edited quote text) goes to **`audit_pii`** `(id, tenant_id, contact_id, salt, data)`. The entry carries `pii_ref` and `pii_commitment = SHA-256(salt ‖ canonical(data))`.
3. **Deletion keeps the chain whole.** Deleting a contact deletes its `audit_pii` rows, including the random salt. The entries and their hashes are untouched, so the chain still verifies. The commitment can no longer be checked or brute-forced, because the salt is gone. The deletion itself is logged as a PII-free entry.
4. **Append-only enforcement:** the application roles have `INSERT` and `SELECT` only; a trigger rejects `UPDATE`/`DELETE`; `seq` is assigned under a per-tenant row lock on `audit_heads(tenant_id, seq, hash)`, which serialises appends per tenant. Appends happen in the same transaction as the action they record.
5. **External anchoring:** every 15 minutes the scheduler writes each tenant's current head `(tenant_id, seq, hash)` to an **S3 bucket with Object Lock in compliance mode** in ap-southeast-1, with retention equal to the audit retention. That means even a database administrator cannot rewrite a whole chain undetected.
6. **Verification tool:** a CLI and an Owner/Admin "Verify audit chain" action recompute the chain over a range and compare with the anchors, reporting the first broken `seq`.
7. **Retention (D7):** entries older than the retention point are removed by a purge job that first writes a *checkpoint* entry carrying the hash of the last purged entry, so the remaining chain still verifies from the checkpoint.
8. **Viewer and export (GOV-02):** indexed by `(tenant_id, ts)`, `(tenant_id, subject_refs)` (GIN); exports stream from the reader instance to S3 as CSV/JSON and are delivered via a presigned link. Thirty days at A1 volumes (about 5,000 conversations × ~15 entries) is about 75,000 rows, well within one minute.

**Options considered**
- **Per-tenant hash chain + separate PII store + Object Lock anchors (chosen)** — meets D7 literally; per-tenant chains make tenant export, deletion and verification independent. Con: serialised appends per tenant, which is fine at MVP volume (tens of entries per second per tenant at most).
- **Crypto-shredding (per-contact keys inside entries)** — considered in D7 and not chosen there; it also complicates verification and key management.
- **Amazon QLDB** — managed ledger. Lost: AWS has ended QLDB (end of support July 2025), and it is a second store outside RLS.
- **Single global chain** — simplest. Lost: one tenant's deletion or export would touch everyone's chain, and appends would serialise platform-wide.

**Consequences**
Developers cannot write free text into audit payloads. The typed builders and a CI test that scans payload schemas for string fields without a `masked` or `id` type enforce this. The S3 anchor bucket's compliance-mode retention cannot be shortened, even by the root account, so its retention period must match the signed-off D7 policy (see OI-5).
