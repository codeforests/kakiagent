# ADR-015: PII masking, the PII-bearing stores and data-subject deletion

**Status:** Proposed (awaiting product-owner sign-off)
**Date:** 2026-10-19
**Requirements addressed:** GOV-04, GOV-05, GOV-06, GOV-12, AUTH-07, LED-02, LED-05, LED-06, LED-07, LED-08, KB-04, CHN-03, CHN-08, CHN-09, D7, D8, NFR-05, NFR-07, NFR-08, UC-28, UC-30, UC-35, J6, J10

**Context**
GOV-04: NRIC/FIN, card numbers and bank account numbers must be masked in visitor messages before storage and before the LLM call, and other PII masked in logs. GOV-05: find a contact's data across conversations, leads, the KB and attachments, then export, correct or delete it, including vector chunks and attachments; primary storage immediately, backups within the retention window. GOV-06: tenant-configurable retention with an automatic purge. D8: tracking stays pseudonymous until LED-02 consent.

**Decision**
1. **Masking at the edge.** The first step after `normalise` (ADR-011), before anything is persisted or queued, runs the `pii-mask` package:
   - **NRIC/FIN** (`[STFGM]\d{7}[A-Z]` with checksum validation), **payment cards** (13–19 digits passing Luhn, with separators), **bank account numbers** (SG bank formats next to account/acct/户口/账号 keywords).
   - Matches are replaced with typed masked tokens such as `[NRIC ••••567A]` and `[CARD ••••4242]`. **The original value is not stored anywhere** (GOV-04 "never unmasked in the database").
   - The same masker runs on email bodies, on text OCR'd from attachments, and on chat-export imports (KB-04), plus a name/phone/email redactor for non-business participants.
2. **PII lives only in contact-keyed tables:** `contacts`, `contact_identities`, `conversations`/`messages`, `leads`, `consents`, `attachments` (S3 keys), `audit_pii` (ADR-014). Every one carries `tenant_id` and `contact_id`. Pseudonymous tracking events (CHN-03) carry only a first-party visitor ID until consent links the visitor to a contact (D8).
3. **Logs and traces carry IDs, never content.** The logger (pino) has a redaction list (email, phone, NRIC patterns, `text`, `body`, `prompt` fields). Prompts and completions are never logged; the conversation record in Postgres is the record.
4. **Data-subject requests (GOV-05)** are a `dsr_requests` workflow: `received → identity_verified (method recorded) → in_progress → completed`, with a due date of 30 calendar days and an alert at T−7.
   - **Find:** all rows by `contact_id` (and merged identities), plus a text search of KB facts and chunks for the contact's name, email and phone, shown for manual review.
   - **Export:** JSON/CSV bundle by contact.
   - **Correct:** edits on the contact and lead records, audit-logged.
   - **Delete:** one transaction deletes contact-keyed rows (cascade) and `audit_pii`, and enqueues S3 object deletions (attachment keys listed in the transaction, deleted by an idempotent job; a daily reconciler removes orphans). KB facts the owner chooses to delete are hard-deleted with their chunks. A PII-free audit entry records the deletion.
5. **Retention purge (GOV-06, UC-35)** is a daily job per tenant: conversations and attachments older than the tenant's setting (default 24 months), leads 24 months after last activity. It uses the same delete path and records the purge in the audit log.
6. **Backups:** Aurora automated backups and S3 versioning keep deleted data until it ages out (35 days; noncurrent S3 versions expire after 35 days). The DPA states this window; restores are only for disaster recovery, and after a restore the deletion journal (`deletion_log`, PII-free IDs) is replayed so deleted contacts stay deleted.
7. **Tenant deletion (AUTH-07):** after the 30-day grace period, a job drops all tenant rows (`DELETE … WHERE tenant_id` per table, chunks included), deletes the tenant's S3 prefixes and Valkey keys, and keeps a PII-free deletion record. For audit-chain retention, see OI-5 in architecture.md.

**Options considered**
- **Mask at the edge, PII only in contact-keyed tables (chosen)** — deletion is a key-scoped operation and cannot miss a table, because a schema test asserts that every table with a personal-data column has `contact_id`. Con: free-text KB content can still hold personal data, which is why KB is a "search and review" step in DSR handling.
- **Tokenisation vault for all PII** — strongest. Lost: every read of a name or email becomes a vault call; heavy for the MVP.
- **Crypto-shredding** — rejected in D7.

**Consequences**
The masker is a security-critical package with its own test corpus (EN/ZH, spacing variants) and is part of the AGT-14 CI gate. Deletion within backups is bounded but not immediate, and that is documented. Image attachments may contain identity numbers that text masking cannot see; see OI-3.
