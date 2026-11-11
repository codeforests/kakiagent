# Acceptance report: FEAT-039 — Contact identity, verified merge and undo

> Verified: 2026-11-10 (verify stage, fresh session) · Branch `feat/FEAT-039-contact-identity` · PR #63 · Design: [technical-design.md](technical-design.md) §6

## Verdict summary

**Accepted.** All eight acceptance criteria hold against their sources (CHN-08; LED-09 partial, D6; UC-26 4a). The feature's unit and integration suites pass in this run; the E2E spec and screen renders run in GitHub CI (see CI). CHN-08's "verified phone" clause has no source yet (no SMS or WhatsApp channel; design §8), so CHN-08 is partial.

## Audit standard

Re-derived from SRS CHN-08 ("a single contact record across channels, merged by verified email, phone or Telegram ID; staff can merge manually"; "No automatic merge on unverified data. A manual merge can be undone and is recorded in the audit log"), LED-09 (duplicate leads; here only the case of two merged contacts, D6) and UC-26 exception 4a (staff merge contacts manually). Every FR in the `> Implements:` line has a criterion. AC-1 and D1 are a faithful (stricter) reading of "no automatic merge on unverified data": typed lead-form details never join contacts. Verified phone is uncovered because nothing can verify a phone yet; recorded as partial, not a defect.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | CHN-08 no merge on unverified; LED-09 | leads `leads.int` "typed details another contact holds…", "a returning visitor…", "concurrent submits…"; channels `contacts.int` "a typed value never resolves a contact"; api `leads-widget.int` | Yes: new contact, other contact's leads and consents unchanged, withdrawal touches only the new one; same browser still updates its lead | Pass |
| AC-2 | CHN-08 verified email / Telegram ID; D2–D3 | channels `contacts.int` (verified From, unverified mailbox, Telegram ID, concurrency); `email/receive.ts` maps DMARC `PASS` only; agent-worker `email-receive.int`, api `telegram-hook.int` | Yes | Pass |
| AC-3 | CHN-08 verified merge; D5 | channels `contacts.int` "attachVerified merges the other holder into the older contact…" | Yes: older survivor, rows moved, one `contact.merged` `automatic: true`, undo works | Pass |
| AC-4 | CHN-08 manual merge; UC-26 4a | api `contacts.int` (detail, search, preview, merge, 404 cross-tenant, 401); channels `contact-merge.int` search; E2E `contact-merge.e2e` | Yes. 403 path: every role holds `contacts.merge` (identity test), so only 401/404 are reachable | Pass (E2E in CI) |
| AC-5 | CHN-08 undo + audit; D7; ADR-014 | channels `contact-merge.int` (undo equals the pre-merge snapshot except rows created after; `contact.unmerged` payload IDs only; `already_undone`, `survivor_merged`); db `rls.int` unmerge once; api 409 `already_undone` | Yes | Pass |
| AC-6 | LED-09 p; D6 | channels `contact-merge.int` (one open lead, the other `superseded_by` it; restored on undo); leads `leads.int` superseded out of list and export | Yes | Pass |
| AC-7 | ADR-005 | db `rls.int` FEAT-039 block (tenant B reads/adds/merges nothing of A; app roles can't re-key consents or set merge columns; definer functions refuse other-tenant IDs) | Yes | Pass |
| AC-8 | SCR-APP-016, -015, -033 | api `contacts.int` sidebar marks + `duplicates: 1`; dashboard `contacts.test.ts`; E2E `contact-merge.e2e` (axe desktop and 375×5000) | Yes | E2E in CI |

## Changed existing tests (reviewed, not weakened)

- leads `leads.int` "returning visitor" and concurrent cases, `pipeline.int` two cases, api `leads-widget.int` contact-form case: "same person" now means the same browser (`visitor_id`) or conversation, not the same typed email. This is D1 (Ken, 2026-11-10; design §8), and the new expectations are as strict as the old.
- db `seed.int`: contact count +1 (the D10 duplicate pair) and new identity assertions.
- No `.skip`, `.only` or deleted cases in the diff.

## Corrected tests

- db `seed.int` (D10 duplicate pair): the name order came from the database collation; now sorted in the test (`4a32c25`). The assertion still checks both contacts share the email.

## Independent execution

Run in this session at `770b2cb` (plus docs only):
- `pnpm format:check`, `pnpm lint` (incl. check-rtm), `pnpm typecheck`: PASS. `pnpm test`: 155 files, 1810 tests PASS.
- Integration via `scripts/test-env.sh`: db 231, channels 53, leads 30, agent-worker 23 PASS; api 42/43 files PASS, `uploads.int` needs Docker (LocalStack), runs in CI.
- Coverage: `@kaki/channels`, `@kaki/leads`, `@kaki/db` `test:coverage` PASS (thresholds held).

## Direct verification

- Migration `0055` applies on a fresh database in every integration run; backfill case in `rls.int` passes.
- Audit payloads inspected in `contact-merge.int`: IDs and counts only (ADR-014). No outbox jobs needed (no side effects beyond audit).
- Module boundaries: leads imports `@kaki/channels/contacts` only (dependency-cruiser in `pnpm lint` passes).

## Findings

- Minor, no action: merge history rows say "automatically (verified details)" instead of naming the identifier kind (handoff deviation; `ContactMergeEntry` has no kind).
- CHN-08 verified phone waits for a phone-verifying channel.

## RTM

Test ref appended 2026-11-10: CHN-08 (partial: verified phone has no source yet), LED-09 (partial: duplicate leads of merged contacts). `node scripts/check-rtm.mjs FEAT-039 --stage verify`: `RTM check passed (FEAT-039).`

## CI

- Run 123 at `1e1dcd3`: every job green, including `contact-merge.e2e` on Chromium, Firefox and WebKit, except db `seed.int`: it ordered names with SQL `order by`, which CI's en_US collation sorts differently. Corrected in `4a32c25` (names sorted in JS; the same assertion).
- Run 124 at `4a32c25`: all jobs green.
