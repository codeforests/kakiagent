# Acceptance report: FEAT-046 — Conversation search (verified)

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-11-03 by an independent verify session · Branch `feat/FEAT-046-conversation-search` · PR #52

## Verdict summary

**Accepted** (2026-11-03). Every criterion AC-1..AC-7 has a test that asserts what it says (one AC-6 assertion was too weak and is corrected below), all local checks are green at `d08dca6` (the only red is the LocalStack-only `uploads.int`, unrelated), no existing test was weakened, and build note B1 holds against ADR-005 (Direct verification). INB-11 is accepted **partial**: message text (which finds emails and phones typed in chat) now, contact name/email/phone fields with FEAT-049 (D1, Ken 2026-11-03). GitHub CI: see CI.

## Audit standard

Re-derived from SRS v0.4 INB-11 ("Conversation search by contact name, email, phone or message text, within the tenant"; fit criterion "Results in ≤ 2 seconds for 12 months of data at A1 volumes"), UC-23 (trace only), SCR-APP-014, GOV-04, NFR-09, NFR-19, ADR-005, ADR-014, ADR-015, and technical-design §6 AC-1..AC-7 with D1–D8 and B1. Every INB-11 clause maps to an AC except "contact name" and the contact-field half of email/phone, which have no `contacts` table yet (D1, recorded in §8 and pending-actions); hence partial, not a defect.

## Audit table

| AC | Source | Test(s) | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | INB-11 message text | inbox `search.int` substring + case-insensitive in visitor/agent/staff; latest match with ranges; closed included; 7 rows over 3 pages in keyset order, no duplicates; api `search.int` 200 with marked excerpt for owner and agent roles, two pages by cursor; inbox unit `excerptOf` | Yes | Pass |
| AC-2 | INB-11 email, phone; D1, D6 | inbox `search.int` email whole and `@EXAMPLE.COM`; phone in 4 spellings → same 3 conversations; NRIC query → masked token; unit `searchPatterns` (5 phone spellings → same variants, NRIC masked) | Yes | Pass |
| AC-3 | INB-11 within the tenant; ADR-005 | inbox `search.int` A↔B both ways on 4 needles; api `search.int` tenant B session; strict body (extra `tenantId` → 400); `rls.int` for `inbox_search_hits` (tenant A/B/none, other zones denied, role NOLOGIN, column grants); E2E second tenant finds nothing | Yes | Pass |
| AC-4 | INB-11 fit criterion | inbox `search-volume.int` (60k conversations / 480k messages A, 100k B; worst of 3 ≤ 2,000 ms; A never sees B) | Yes | Pass (re-run here: rare email 21 ms, email part 4, phone ×3 3–4, 美玲 830, common word 252) |
| AC-5 | GOV-04, ADR-014 | api `search.int` log capture at debug: URL present (capture works), query, email and its parts absent; E2E POST body checked and no text in any URL; T5 stubbed check: storage empty | Yes | Pass |
| AC-6 | input rules | contracts `search.test` (1 and 101 code points, extra key); api 400s and `bad_cursor`; inbox `QueryTooShortError`, `50%` vs `500`, `it_5` (would hit "it 50%" as a wildcard), **`a\b` corrected** | Yes, after correction | Pass |
| AC-7 | SCR-APP-014, NFR-09, NFR-19 | dashboard unit `lib/search.test` (7); E2E `inbox-search.e2e` (mark, open at match with `bubble--match`, Escape, no results, 375 Back keeps results, `scrollWidth` ≤ 375, top bar focus, axe at 1280 and 375 tall) | Yes | Pass in CI (see CI) |

## Changed existing tests (reviewed, not weakened)

`packages/db/test/rls.int.test.ts` (+68, new cases only), `apps/api/test/support.ts` (optional `logger` for the capture). No test deleted, skipped or loosened (`git diff origin/main...HEAD` over `*.test.ts`, `*.int.test.ts`, `e2e/`).

## Corrected tests

- **AC-6, `packages/inbox/test/search.int.test.ts` "matches %, _ and \ literally"** (commit `d08dca6`): it expected `a\b` to find nothing, but no fixture could match an unescaped `\b` (which means `b`), so it passed with backslash escaping removed. Added fixtures "folder a\b" and "a drab colour"; it now expects only the literal one. Checked by mutation: with `\` dropped from `escapeLike` the corrected test fails; restored, 10/10 pass.

## Independent execution

All run fresh in this session through `scripts/test-env.sh scripts/check-summary.sh`:

- Feature: `@kaki/contracts test` 51, `@kaki/inbox test` 29, `@kaki/dashboard test` 205, `@kaki/inbox test:integration` 91 (incl. volume test), `@kaki/db test:integration` 190: all PASS.
- Full: `pnpm format:check` PASS, `pnpm lint` PASS (ESLint, dependency-cruiser, RTM), `pnpm typecheck` PASS, `pnpm test` PASS (124 files, 1,497 tests), `@kaki/db test:coverage` PASS (190), `@kaki/inbox test:coverage` PASS (120), `@kaki/api test:coverage` 35/36 files: the one failure is `uploads.int` (LocalStack needs a container runtime, none in cloud sessions; unrelated, runs in CI).
- Corrected test: `search.int` 10/10 PASS.

## Direct verification

- **B1 against ADR-005.** `inbox_search_hits(text[])` is SECURITY DEFINER, owned by NOLOGIN `kaki_inbox_search` (no BYPASSRLS), `search_path` pinned, EXECUTE revoked from PUBLIC and granted to `app_dashboard` only. The role reads seven `messages` columns under a policy scoped `TO kaki_inbox_search`; the function filters `tenant_id = app_current_tenant()`, which is NULL when unset, so no tenant context returns nothing (covered by `rls.int`). `searchConversations` joins it to `conversations` under RLS and filters both on the tenant explicitly. Same pattern as 0045 and earlier definer reads; ADR-005's "app roles don't own tables, no BYPASSRLS, explicit tenant filter" holds. The plan (re-run) uses `Bitmap Index Scan on messages_search_trgm_idx` with both index columns for the rare and common terms.
- Patterns are bound parameters; `ILIKE`'s default escape is `\`, matching `escapeLike`.
- ADR-015: the query goes through `piiMask` first, so an NRIC typed in the box matches the stored token and is never compared raw.
- Tokens only in the new CSS (the 2 px match outline is the ui-design's stated width; colours are `var(--…)`). ui-design states spot-checked in code: `type="search"`, `aria-describedby` help, results `role="region"` "Search results" with `aria-busy`, `mark.search-hit`, "Showing N" vs "N match", Try again, reduced-motion scroll.

## Findings

- F1 (fixed here, test artifact): AC-6 backslash assertion was vacuous; corrected above.
- Note: `query_too_short` can't be reached over HTTP (Zod already collapses whitespace and masking only lengthens); kept as a guard and covered at the inbox layer. Not a defect.
- Carried: INB-11 contact fields → FEAT-049 (D1, in pending-actions); a match older than the loaded 100 messages opens at the bottom (§8).

## RTM

Test ref appended 2026-11-03: INB-11 (partial: message text; contact name, email and phone fields with FEAT-049, D1). `node scripts/check-rtm.mjs FEAT-046 --stage verify`: `RTM check passed (FEAT-046).`

## CI

CI_LINE
