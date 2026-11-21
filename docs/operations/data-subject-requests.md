# Data-subject requests: what happens to each store

Operations note for GOV-05 ("Documented"), UC-31 and FEAT-061. Owners and Admins work requests at **Settings → Privacy and data → Data requests** (SCR-APP-048, SCR-APP-049). The store list below is generated from the same registry the code uses (`packages/governance/src/dsr/stores.ts`, `DSR_STORES`); a unit test fails if a tenant-scoped table is missing from it.

## Timeline

- A request is due **30 days** after the date it was received (Singapore dates). Owners and Admins get one `dsr_due_soon` alert **7 days** before the due date (or at once, if it is logged later than that). The alert can't be muted: it is a legal deadline (D8). The scheduler checks hourly (`DSR_DUE_SWEEP_MS`).
- A customer who asks the assistant to delete or send their data opens a request from the chat and the conversation is escalated to the team (D6).
- Search works on an open request as a preview; export, correction and deletion need the requester's identity verified first, with a method and a note (D7, D9).

## Deletion

Deletion runs as one database transaction through `dsr_erase()` (D1): either everything selected is gone or nothing is. Export and deletion need the staff member to have signed in again within 10 minutes (AUTH-03).

| Store | On deletion |
|---|---|
| Contacts (and contacts merged into them), their identities, merge history, Telegram chat links, handoff links | Deleted |
| Consent records, leads | Deleted |
| Every conversation of the contact, whole, with its messages, memory, escalations, takeover rows, reply suggestions, approval drafts and their link nonces, email headers and thread subjects, delivery rows (D2) | Deleted |
| Conversations that only *mention* the identifier, KB facts and staged facts that mention it | Deleted only when ticked (they start unticked, D10) |
| Corrections raised from the deleted conversations and their coaching replays | Deleted (D16) |
| Page-tracking events and tracking choices of those conversations' visitors | Deleted |
| Audit personal data (`audit_pii`) | Erased; the IDs-only audit chain still verifies, checked right after the deletion (D11) |
| Email attachment files in S3 | Deleted by a follow-up job within minutes; the request shows "Files: pending" until then |
| The request itself | Kept as proof of compliance, with the requester's details masked (`m•••@example.com`, `+65 ••••4567`, initials) (D3) |
| Audit entries, usage rows, notifications, outbox rows | Kept: they hold IDs only, no personal data (ADR-014) |

## Backups

Deleted data stays in database snapshots until they age out: **35 days** (RDS backup retention, `BACKUP_RETENTION_DAYS`). The completed request shows the date backups clear by. Backups are not edited; GOV-05 allows deletion "within the backup retention window" (D12). If a backup from inside that window is ever restored, the deletions completed since the snapshot must be applied again before the restored database serves traffic: list them from the closed requests (each keeps its completed date and counts). The restore runbook comes with the MD restore drill.

## Outside the system

Leads already exported as CSV or sent to a webhook, and emails already delivered to staff inboxes, are outside the system. The business must delete those copies itself; say so in the reply to the requester.

## Correction and access

- Correction changes the contact's name, email and phone and the lead's free-text fields. A changed email or phone replaces the typed identity; identities the channel verified stay. Messages are never edited (D4).
- Access exports a JSON file with the contact, identities, consents, leads, conversations and messages, attachment names and approvals. Attachment files are listed, not bundled; audit personal data is left out because it only copies values already in the file (D5).
