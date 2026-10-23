# Acceptance Report: FEAT-017 — Chat-history import (WhatsApp, Telegram) to suggested FAQs, with redaction

> Verdict: **Accepted, with AC-9 observed in CI** (first verification; KB-04 gets its Test ref) · Date: 2026-10-23
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-9) · Sources: SRS v0.4 (KB-04; KB-11, KB-12, KB-16 in the parts this feature extends to chats; NFR-11, NFR-17, NFR-19), use-cases v0.4 (UC-11 1–4, 2a; UC-03 6), ADR-005, ADR-007, ADR-010, ADR-015, ADR-018
> Repo state audited: `ad08112`

## Verdict summary

FEAT-017 is accepted. AC-1 to AC-8 each have a test that asserts what the criterion says, and each was observed green in this run.

AC-9 is the browser path (`e2e/tests/chats.e2e.ts`). This session has no Docker, so there is no local stack. Under the owner's rule (feature threads run only the feature's tests; CI runs the full suite), that spec is first observed in the PR's E2E job. If it fails there, the verdict becomes **rework** and the fix goes on the PR before merge.

The audit found one gap. AC-2 (malware scan, encrypted zip, never copied to `sources`) had no test that exercised it for a chat export. A test was added in `ad08112` ("checks a chat export for malware…"). It asserts the criterion: EICAR gives `malware` with no part stored, an encrypted zip gives `encrypted`, every export is scanned, the `sources` bucket stays empty and `file_key` is null.

Three mutation checks turned the relevant tests red, and each mutation was reverted:

| Mutation | Result |
|---|---|
| Phone numbers no longer redacted | Integration test failed (1 of 7) |
| The `redacted_content` check removed from `parseMining` | Unit tests failed (2) |
| The export no longer deleted after the parse | Integration tests failed (5) |

There are no rework or design-defect findings.

This ran in the same session as the implementation. The standard was re-derived from KB-04, UC-11 and design §6, not from tasks.md.

## Audit standard

KB-04 (M) states: "Chat-history import (WhatsApp `.txt` export, Telegram JSON export). Mines question-and-answer pairs from the business's replies." Its acceptance clauses map to criteria as follows:

| KB-04 clause | Criteria |
|---|---|
| Both formats are accepted | AC-1, AC-3 (the `.zip` form is the iOS WhatsApp export) |
| Pairs are mined from the business's replies | AC-4 |
| Pairs land in Suggested FAQs, never live without review | AC-5 |
| Visitor personal data is redacted before storage | AC-3 |
| The export is deleted once mining finishes | AC-3, AC-7 |

AC-3 holds the deletion criterion more strictly than KB-04 requires: the export is deleted when the parse finishes, before mining. That is stronger than the requirement, so the criterion is faithful.

UC-11 paths are all represented:

| UC-11 path | Criteria |
|---|---|
| Steps 1–2 | AC-1, AC-2, AC-3 |
| 2a (not a chat, or no messages from the business) | AC-6 |
| Steps 3–4 (review) | AC-5, AC-9 |

Other sources:

| Source | Criteria |
|---|---|
| KB-12 / NFR-17 (retry) | AC-7 |
| ADR-005 (isolation) | AC-8 |
| ADR-007 (models only through the gateway, Haiku for `mine`) | AC-4 |
| NFR-19 (accessibility) | AC-9 axe check |

## Audit table

| AC | Test | Asserts the criterion | Observed |
|---|---|---|---|
| AC-1 | `apps/api/test/chats.int.test.ts` (tests 1–3, 6) | Yes: 201 `queued` at `scan`, the name, an audit without the file or business names, one job, refusals, the file limit, `agent` 403 | 6/6 green |
| AC-2 | `packages/kb/test/chats.int.test.ts` (AC-2 test, added by this audit) and the AC-6 test (PDF named `.txt`); `sniff.test.ts` | Yes | Green |
| AC-3 | `packages/kb/test/chats.int.test.ts` (Android, iOS zip, Telegram full), `chat-fixtures.test.ts` (Telegram single), `readers`, `redact` and `exchanges` unit tests | Yes. The PII sweep covers every stored table, the audit and the outbox | Green; mutation 1 caught |
| AC-4 | `mine.test.ts`, `router.test.ts` | Yes: every drop reason, the cap, `mine` → Haiku | Green; mutation 2 caught |
| AC-5 | `packages/kb/test/chats.int.test.ts` (test 1) | Yes: `needs_review`, `source 'chat'`, provenance, absent from `visitor_facts` until approved, and rejecting removes it | Green |
| AC-6 | kb AC-6 test; api `business_not_found` test | Yes, including 409 `not_retryable` | Green |
| AC-7 | kb retry, resume and delete tests | Yes | Green; mutation 3 caught |
| AC-8 | `packages/db/test/rls.int.test.ts` chat case; api tenant B test | Yes | 98/98 and 6/6 green |
| AC-9 | `e2e/tests/chats.e2e.ts` | Yes: upload, notice, privacy card counts and the export-deleted line, no fixture PII on the page, approve, edit and approve, reject (the review card's word for "discard"), all reviewed, and axe | **CI** (no Docker here) |

## Test-diff review

The feature's test diff (11 files, +1,442 lines) adds tests. It removes two lines, both in `apps/api/test/uploads.int.test.ts`:

- `menu.zip` is no longer in the refused list.
- The `unsupported_type` message was updated.

Both follow from AC-1: uploads now accept `.zip` and `.json` for chat exports. A `.zip` named as a file source is still refused by the source's sniff. No test was skipped, `.only`'d or loosened.

## Direct checks

- **Audit (GOV-04):** the kb integration test reads `audit_entries` for `kb_source.parsed` and `kb_source.export_deleted`. Neither payload contains PII (the PII sweep includes `audit_entries`).
- **Data minimisation (NFR-11):** the API's `Source.chat` carries counts only, and `businessNames` is stripped (api test 4).
- **Screens:**
  - The dashboard build, typecheck and lint pass.
  - SCR-APP-026's states (reading, suggestions, all reviewed, empty, failed, delete confirm) were checked against ui-design.md in code. They were not rendered against a stack here; AC-9 renders the main path in CI.

## Not run here

These were left to CI under the owner's rule:

- The whole-repo unit, integration and E2E suites.
- `apps/api/test/uploads.int.test.ts` "the S3 presigner", which needs Docker or `KAKI_TEST_S3_ENDPOINT` and belongs to FEAT-015.

Checks run here and observed green:

- format, lint (including dependency-cruiser) and typecheck across the workspace.
- kb unit (218), gateway (37), ingest-worker (17) and contracts.
- kb integration (chats 7, files, sheets).
- api chats (6).
- db RLS (98).

## Pending environment

Mining quality with the real `mine` model (Haiku through Bedrock `au.`) is only measured by the AGT-14 mining subset at the M1.5 real-model gate. The fake miner proves the pipeline, not the model's judgement.
