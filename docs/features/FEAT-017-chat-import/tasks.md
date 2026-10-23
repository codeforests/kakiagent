# Tasks: FEAT-017 — Chat-history import (WhatsApp, Telegram) to suggested FAQs, with redaction

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: developer-done · Last updated: 2026-10-23

- [x] T1 — Schema: `kb_sources` kind `chat`, failures `chat_format`/`business_not_found`, file types `json`/`zip` with `kb_sources_chat_type_ck`, the widened `kb_sources_file_ck`, `chat` with `kb_sources_chat_ck` (drizzle schema + `0025`); RLS suite case for chat sources and parts (design §4; AC-8 schema half)
      Done when: `pnpm db:setup` applies 0025 on a database at 0024; `drizzle-kit generate` reports no drift; the RLS suite passes with the chat case.
- [x] T2 — Contracts and gateway: §3.1 shapes, `CHAT_EXTENSIONS`/`UPLOAD_EXTENSIONS`, the chat body with `businessNames`, `FileLocation` unit `chat`; logical model `mine` in `LogicalModel` and both registries (design §3.1, §5.7)
      Done when: typecheck passes across the workspace with the new enum values handled (dashboard records included); gateway unit tests pass with `mine` routed to Haiku.
- [x] T3 — Chat readers: `whatsapp.ts`, `telegram.ts`, `zip.ts` (design §5.3 steps 2–3)
      Done when: unit tests pass for Android and iOS line forms, d/m and m/d, 12- and 24-hour clocks, U+200E marks, multi-line messages, system and media lines dropped, the message limit keeping the latest; Telegram single and full exports, text parts, service messages skipped; `_chat.txt` picked from a zip with media, no text entry → `chat_format`.
- [x] T4 — Redaction and grouping: `redact.ts`, `exchanges.ts` (business detection, exchanges, parts) (design §5.3 steps 4–6; D3, D4, D7, D9; AC-3 logic)
      Done when: unit tests pass for every redaction rule with counts, name-word redaction, business matching (normalised, contains, Telegram `from_id`), the 48-hour rule, part size and limit.
- [x] T5 — Mining: `mine.ts` (`MINING_SYSTEM`, schema, `parseMining`), `fake-mine.ts`, `minePart` in `extractSource` for chat sources (design §5.4; D8; AC-4)
      Done when: unit tests pass for every check of §5.4 with drop counts, the 20-pair cap, and the fake's output.
- [x] T6 — Pipeline: `sniffType` for chat, `scanFile` without copy for chat, `parseChatSource` (store, delete, audit), the job's parse branch, promote with `source 'chat'` and never approved, retry keeping parts, delete and purge, `countFileSources` (design §5.2, §5.3 step 7, §5.5, §5.6; D2, D5, D6; AC-2, AC-3, AC-5, AC-6, AC-7 pipeline half)
      Done when: kb integration tests with the in-memory file store pass: each fixture runs to `ready` with `needs_review` FAQs, no fixture PII in any stored row, the object deleted and audited; `chat_format` and `business_not_found` delete the object and aren't retryable; model failure then retry ends `ready` from kept parts; a crash after delete resumes; approving a suggestion puts it in `visitor_facts`.
- [x] T7 — Fixtures: `generate.ts` gains the §5.8 files; committed (design §5.8)
      Done when: the generator regenerates every file and the committed files match what T3–T6 tests expect.
- [x] T8 — Worker wiring: `CHAT_MESSAGE_LIMIT`, `CHAT_PART_LIMIT` config and `.env.example`, the fake provider routing `mine`, logs (design §5.7)
      Done when: ingest-worker typecheck and unit tests pass; the worker starts against the local stack.
      Note: this session had no Docker, so the worker wasn't started against the stack; typecheck, lint and the worker's unit tests (including the committed chat fixtures) pass, and CI's E2E job starts it.
- [x] T9 — API: the chat body of `POST /kb/sources`, `toSource` with `chat` (no `businessNames`), extension lists (design §3.2; AC-1, AC-6, AC-8)
      Done when: api integration tests pass for every designed success and error, including tenant B's 404 on tenant A's source.
- [x] T10 — Dashboard: chat exports on SCR-APP-007, chat rows on SCR-APP-023, SCR-APP-026 at `/knowledge/sources/:id` for a chat (reading, suggestions, empty, failed), chat provenance on SCR-APP-028 (ui-design.md)
      Done when: `pnpm --filter @kaki/dashboard build` passes and every state in ui-design.md renders against the running stack.
      Note: build, typecheck and lint pass; with no Docker in this session the states weren't rendered against the stack, so T11's E2E spec in CI is the render check.
- [x] T11 — E2E: `e2e/tests/chats.e2e.ts`: upload `whatsapp-android.txt`, redaction notice, suggestions, approve, edit and approve, discard, export-deleted note, axe on SCR-APP-026 (AC-9; UC-11)
      Done when: the spec passes in Chromium against the local stack, or (per Ken's rule) is left to CI with the reason recorded.
      Note: written, linted and typechecked; this session has no Docker for the local stack, so the spec runs first in CI's E2E job (Ken's rule: CI runs the full suite).
- [x] T12 — Verify: every AC in design §6 demonstrated; format, lint, boundaries, typecheck and this feature's unit and integration tests green; scaffold notes updated (design §6)
      Done when: the evidence for each AC is recorded at the end of this file.

## Verification evidence (T12, 2026-10-23)

Run in a session without Docker: integration tests used a local Postgres 16 + pgvector (`KAKI_TEST_DATABASE_URL`) and the in-memory file store; the E2E spec runs in CI.

- **AC-1:** `apps/api/test/chats.int.test.ts` (6 passed): 201 `queued` at `scan` named "Chat export", the audit without file or business names, one job, `.pdf` as chat 400, missing/empty `businessNames` 400, the file limit, `agent` 403.
- **AC-2:** `packages/kb/test/chats.int.test.ts` "checks a chat export for malware…" (EICAR `chat.txt` → `malware` with no part stored, an encrypted zip → `encrypted`, every export scanned, nothing copied to `sources`, `file_key` null) and the AC-6 test (PDF as `.txt` → `unsupported_type`); `sniff` unit tests.
- **AC-3:** `packages/kb/test/chats.int.test.ts` reads all four fixtures and asserts no fixture PII or file name in any stored row, the parts' tokens, the counts, the object deleted, `exportDeletedAt` and `kb_source.export_deleted`; `readers`, `redact` and `exchanges` unit tests (218 kb unit tests pass).
- **AC-4:** `mine.test.ts` (every `parseMining` drop reason counted, the 20-pair cap, `MINING_SYSTEM`); `router.test.ts` routes `mine` to Haiku with purpose `extract` (37 gateway tests pass).
- **AC-5:** `packages/kb/test/chats.int.test.ts`: `ready` with `needs_review` FAQs, `source 'chat'`, provenance and `location { unit: 'chat' }`, none in `visitor_facts`; approving puts one in `visitor_facts`, rejecting removes it.
- **AC-6:** `packages/kb/test/chats.int.test.ts` (`not-a-chat.*` → `chat_format`, unknown names → `business_not_found`, export deleted) and `apps/api/test/chats.int.test.ts` (retry 409 `not_retryable`).
- **AC-7:** `packages/kb/test/chats.int.test.ts`: model failure → `extraction_unavailable`, retry from kept parts → `ready`; stale job no-op; resume after delete; delete purges parts and FAQs.
- **AC-8:** `packages/db/test/rls.int.test.ts` chat case (98 passed); `apps/api/test/chats.int.test.ts` tenant B 404 and empty scoped review.
- **AC-9:** `e2e/tests/chats.e2e.ts` written, linted and typechecked; runs in CI's E2E job (no Docker here).
- **Checks:** `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser: no violations), `pnpm typecheck` pass; dashboard build passes; kb integration (chats 7, plus files and sheets, all passed). `apps/api/test/uploads.int.test.ts` "the S3 presigner" needs Docker or `KAKI_TEST_S3_ENDPOINT` and was not run here (FEAT-015's test; CI runs it).
- **Recorded:** `apps/ingest-worker/fixtures/files/` added to `.prettierignore`, because the generated JSON fixtures are compared byte for byte with their generator.
