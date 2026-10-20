# Acceptance Report: FEAT-003 — PII masking at the edge

> Verdict: **Design defect** · Date: 2026-10-20
> Standard: technical-design.md §6 (AC-1..AC-10) @ `eb1ac7e` · Sources: SRS.md v0.4 (GOV-04, NFR-01, NFR-05, NFR-12), use-cases.md v0.4 (UC-20 step 4), ADR-015 decision 1 and consequences, ADR-007, ADR-011
> Repo state audited: `efee620` on `claude/feat-003-pii-masking-ymm32o` (clean tree), plus this audit's two test corrections (`3264c91`, `595c541`)

## Verdict summary

The code does what technical-design §3–§5 says, and every criterion in §6 passes as written. All suites are green in this run, the two tests I corrected included. The verdict is still **design defect**, because the separator rules in design §3.1 leave a gap. They accept only an ASCII space or hyphen between digit groups, and the full-width fold covers U+FF01–U+FF5E but not the full-width space U+3000. So a card number typed with a Chinese IME in full-width mode (`４２４２　４２４２　４２４２　４２４２`), pasted with no-break spaces, or typed with double spaces or tabs is stored and sent to the model in clear. I confirmed this on the live local stack. That breaks GOV-04's acceptance clause ("NRIC/card numbers never appear unmasked in the database or the LLM payload"), and it's out of step with the design's own decision to support full-width input. The fix is small: amend design §3.1/§5.1 (separator class and fold), then a short implementation pass with new corpus cases, then re-verification. No RTM Test ref is written.

## Standard re-derived (Phase 2)

- **GOV-04** (Must): "PII handling: detect and mask NRIC/FIN, card numbers and bank accounts in visitor messages before storage and before sending to the LLM; mask other PII in logs." Acceptance: "NRIC/card numbers never appear unmasked in the database or the LLM payload (verified by tests)."
  - NRIC/FIN → AC-1; cards → AC-2; bank accounts → AC-3; no damage to ordinary text → AC-4; "before storage" / "never unmasked in the database" → AC-5; "before sending to the LLM" / "the LLM payload" → AC-6; "mask other PII in logs" → AC-7; audit IDs (FEAT-002 M1) → AC-8. Every clause has a criterion.
- **UC-20 step 4** ("the system masks NRIC, card and bank numbers in the message") → AC-5, AC-9. **SCR-WGT-002** (p) → AC-9; ui-design.md adds no state or component, and the manifest is unchanged (correct for a no-UI-change feature).
- **NFR-01 / NFR-05** → AC-10 (bounded time, no catastrophic backtracking). **NFR-12** → the existing 70% line threshold on `src/pii-mask.ts` (unchanged in this branch; measured 100%).
- **ADR-015 decision 1** ("with separators"; corpus "EN/ZH, spacing variants"): encoded in §3.1, which narrows "separators" to one ASCII space or hyphen and "full-width" to U+FF01–U+FF5E. **This is where the standard falls short of its source** (finding DD-1). The rest of the criteria are faithful.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | GOV-04 NRIC/FIN | `platform/src/pii-corpus.json` `nric-*` (19 cases: S/T/F/G/M, lower case, spaced, hyphen, full-width, Chinese context, bad letter, 6/8 digits, inside word, trailing digit) via `pii-mask.test.ts`; `checksums` (every prefix incl. M offset) | faithful to the AC as written; mutation: bank pass off → 9 corpus tests red (masker suite is live) | green (platform 132/132) |
| AC-2 | GOV-04 cards | corpus `card-*` (plain, spaced, hyphen, Amex 4-6-5, 13, 19, qty after, number before, Chinese context, Luhn fail, too long); seeded random set (no Luhn-valid 16-digit run left) | faithful to the AC; **the AC's separator set is the defect (DD-1)** | green |
| AC-3 | GOV-04 bank accounts | corpus `bank-*` (DBS, after-keyword, UOB, POSB, 12 digits, 转账/户口, 银行账号 after, no keyword, `+65` phone, far keyword, keyword inside word, card beats bank) | faithful | green |
| AC-4 | GOV-04 ordinary text; idempotence | corpus `neg-*` (16 bakery messages: S$ prices, phones, dates, postal, quantities, order no., Chinese, PayNow, SKU, UEN, hours, 1800 hotline, empty); idempotence over every case and 2000 random inputs | faithful | green |
| AC-5 | GOV-04 "never unmasked in the database" | `apps/api/test/widget-pii.int.test.ts` (widget route → masked 201 body, retry 200 same body, `messages` row, text scan of `messages`, `conversations`, `outbox`, `audit_entries`, `audit_pii` and every published event for 5 raw forms, upper-cased) | faithful; mutation (implementer's, re-checked by reasoning: the scan is on raw row text) | green (api 12/12); also observed live (below) |
| AC-6 | GOV-04 "… or the LLM payload" | `agent/test/turn.int.test.ts` "sends the model and the embedder only masked visitor text" (records at gateway and provider); `llm-gateway/src/mask.test.ts` (generate, stream, query/document embed, system/assistant untouched, caller object not mutated) | **was incomplete → corrected** (bank number missing); mutation: gateway backstop off → `mask.test.ts` red; bank pass off → corrected agent test red | green (agent 11/11, llm-gateway 15/15) |
| AC-7 | GOV-04 "mask other PII in logs" | `platform/src/logger.test.ts` (message + format arg; `{ err }` message and stack; `prompt`/`content`/`messages`/`texts` redacted); `maskLogText` unit tests | faithful for the `{ err }` form; the bare `log.error(err)` form is not covered and leaks `msg` (minor M4, latent); mutation: `logMethod` mask off → logger test red | green |
| AC-8 | GOV-04 + GOV-01; FEAT-002 M1 | `governance/src/payload.test.ts` rejections and `auditCode` construction | **was partial → corrected** (added card as subject ID, NRIC as related ID, card inside a payload code, NRIC inside an actor ID); mutation: `findPii` check off → 7 rejections red | green (governance 70/70 unit, 19/19 integration; existing callers pass in every integration suite) |
| AC-9 | UC-20 step 4, SCR-WGT-002 | `e2e/tests/pii-mask.e2e.ts` (bubble shows `My IC is [NRIC ••••567D], …`, an agent reply arrives, panel never contains `S1234567D`) | faithful; "not shown in the log" has no automated check, verified directly | green (chromium 5/5); dev log 0 hits |
| AC-10 | NFR-01, NFR-05 | `pii-mask.test.ts` "performance" (5 adversarial 4000-char inputs, best of 5 < 20 ms) | faithful for `piiMask`; my own adversarial set below | green; worst probe 5.5 ms |

## Corrected tests

1. **AC-6** (`3264c91`, `packages/agent/test/turn.int.test.ts`). AC-6 asks that the turn on the AC-5 message (NRIC, card **and bank number**) sends the provider none of the raw values and the masked tokens. The test's message had no bank number. It now includes `DBS acct 123-456789-0`, checks for `123-456789-0` and `1234567890`, and asserts that `[BANK ••••7890]` reaches both the gateway and the provider. It passes against the unchanged code, and goes red with bank masking disabled.
2. **AC-8** (`595c541`, `packages/governance/src/payload.test.ts`). AC-8 names both values (a lower-case NRIC, a card number) for each of actorId, subject ID, related ID and payload code, and says "contains". The test covered six of the eight pairs, all as whole values. I added the missing pairs plus two "contains" cases (`order.4242424242424242`, `staff:s1234567d`). It passes against the unchanged code, and control values of the same shape without PII are still accepted (checked with a throwaway test, since deleted).

## Independent execution

Every run below was made by this audit, with turbo `--force` so no cached result was replayed. Unit, lint and typecheck ran at `efee620`. Integration and coverage also ran at `efee620`, and I re-ran the agent integration suite after the corrections (both corrected files are test-only).

| Check | Command | Result |
| :- | :- | :- |
| Format | `pnpm format:check` | pass (also after the corrections) |
| Lint + boundaries | `pnpm turbo run lint --force`; `pnpm lint` | 24/24; depcruise: no violations (205 modules, 444 deps) |
| Typecheck | `pnpm turbo run typecheck --force` | 26/26 |
| Unit | `pnpm turbo run test --force` | 21/21 tasks (platform 132, governance 70, agent 131, llm-gateway 15, widget 6, …); after correction governance 74 (`payload.test.ts` 39/39) |
| Integration | `pnpm turbo run test:integration --force --concurrency=1` (Testcontainers) | 14/14 tasks: db 40, platform 4, governance 19, inbox 5, kb 9, agent 11, api 12; agent 11/11 again after the AC-6 correction |
| Coverage gate | `pnpm turbo run test:coverage --force --concurrency=1` | 15/15; `src/pii-mask.ts` 100% lines / 100% branches, `logger.ts` 100% lines (threshold 70% lines; coverage config unchanged in the branch) |
| Build / size | `pnpm turbo run build --force`; `pnpm size` | 9/9; loader 1.75 kB gz (≤ 14), panel 9.34 kB (≤ 35), initial 1.75 kB (≤ 30) |
| Eval | `pnpm eval --fast` | 52 cases; groundedness 8/8, prices 44/44; exit 0 |
| E2E | `E2E_REUSE_SERVERS=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=… pnpm test:e2e --project=chromium` | 5/5 (facts, pii-mask, skeleton ×3) |

- **Mutation checks** (temporary edits, each restored, `git status` clean afterwards): gateway backstop off → `mask.test.ts` red; `logMethod` masking off → `logger.test.ts` red; `findPii` check removed from `isCode` → 7 `payload.test.ts` rejections red; bank pass off → 9 corpus cases red and the corrected AC-6 test red.
- **Migrations:** no schema change in this feature; every integration suite builds a fresh database through `startTestDatabase`.
- **Flakiness:** none observed. The AC-10 timing test takes the best of five runs (T8). That's a reasonable way to stop CI scheduler noise causing failures, and the bound stays at 20 ms.
- **Caveat (cold start):** as the caller instructed, E2E ran against a `pnpm dev` that another session had started (05:05 UTC). The last commit (05:10) changed only a test and docs, and the roles run under `tsx watch`, so the running servers serve the audited code. Even so, this departs from the skill's cold-start rule, and I'm recording it.

## Direct verification

- **Masker probes** (scratch `/tmp/claude-0/probe/p.ts`, run with `node --experimental-strip-types`, 70+ inputs):
  - Masked correctly: `s1234567d`, `S 1234 567 D`, `S-1234567-D`, `ｓ１２３４５６７ｄ`, `IC:S1234567D.`, `NRIC#S1234567D`, `S1234567D的`, all five prefixes, `S1234567D/S9876543C`, `5555555555554444`, `3782-822463-10005`, `qty 3 4242 4242 4242 4242 cvv 123` (card only), `４２４２４２４２４２４２４２４２`, `账号:1234567890`, `我的户口号码是1234567890`, `A/C 123-456-789`, `my account number: 0123456789`.
  - Left unchanged, correctly: `S$55.00`, `can deliver to 520123 tmr? call 91234567`, `我要订两个榴莲蛋糕，明天下午三点取，电话 9123 4567`, `Block 123 Ang Mo Kio Ave 3 #05-1234 S560123`, `Order ID 20261020123456`, UEN `201912345K`, GST `M90371234X`, `invoice 1234567890123 pls`, `paynow 91234567`, `account 1234567`.
  - **Left unmasked, incorrectly** (DD-1): `４２４２　４２４２　４２４２　４２４２` (U+3000), `4242␣4242␣4242␣4242` with U+00A0, `4242  4242  4242  4242` (double space), tab-separated, en-dash-separated, `S  1234567D`, `S␣1234567D` with U+00A0. Also (M1, M2): `UOB 1234567890 2024-10-20`, `DBS acct 123456789012 2 pcs`, `4242 4242 4242 4242pls`, `S1234567DS9876543C`.
- **Live stack:** I fetched a widget token for `wk_dev_bakery`, created a conversation and posted three messages to `POST /widget/v1/conversations/:id/messages` on the running api.
  - `IC s-1234567-d, card 5555 5555 5555 4444, POSB savings 123-45678-9` came back and was stored as `IC [NRIC ••••567D], card [CARD ••••4444], POSB savings [BANK ••••6789]`.
  - The full-width/U+3000 and the U+00A0 card numbers were **stored raw** in `messages.body` and got agent replies, so they also went to the (fake) model unmasked.
  - A scan of `messages` found no raw `S1234567D`, `S-1234567-D`, `5555 5555 5555 4444` or `123-45678-9`.
  - `/tmp/claude-0/dev.log` (all roles' output, 341 lines) has 0 occurrences of any of those raw values.
- **AC-10 / NFR-05 timing** (scratch `/tmp/claude-0/probe/perf.ts`, best of 5, this container):
  - `piiMask` on 17 adversarial 4000-char inputs (single digits with spaces or hyphens, a run ending in a letter, near-NRICs, separator-split NRICs, 444 valid NRICs, cards, keywords, full-width, Chinese keywords): max 5.46 ms. `1 ` × 32 000 + `x` takes 47.8 ms, which grows linearly.
  - `maskLogText` is **quadratic** in `EMAIL_RE`: 4000 chars of `a` or digits take about 17 ms, 16 000 take 267 ms, and 64 000 take 4.8 s (M3). Environment caveat: one shared container; the numbers are indicative.
- **Logger** (scratch `/tmp/claude-0/probe/log.ts`):
  - Masked: `{ err }` message and stack, `err.cause` (folded into the message by pino), and child loggers.
  - **Not masked:** `log.error(new Error('dup S1234567D'))` writes `"msg":"dup S1234567D"` (M4). Non-redacted object fields (`{ note: 'S1234567D' }`) and `%o` arguments are also left alone, which design D7 intends (M5).
  - Every current caller in `apps/*` and `packages/*` logs `{ err }`, so none of them leaks today.
- **Contracts:** the `@kaki/platform/pii-mask` subpath export, the `findPii`/`piiMask`/`maskLogText` signatures, the gateway's per-role and per-purpose rule, `assertAuditEntry`'s rejection and the logger hooks all match §3.1–§3.4. `Message.body` has no max length, so tokens longer than their matches can't fail response parsing.
- **Screens:** SCR-WGT-002 shows the stored body, observed in E2E; no new styles; manifest unchanged, as ui-design.md says.
- **Pending environment:** none. NFR-01's end-to-end turn latency isn't affected measurably (5 ms or less per message).

## Findings

### Rework
None. The code implements the design as written.

### Design defect
- **DD-1 — Separator and whitespace set lets card and NRIC numbers through unmasked (GOV-04 acceptance; ADR-015 "with separators", "spacing variants").**
  - *What the source requires:* "NRIC/card numbers never appear unmasked in the database or the LLM payload".
  - *What the design says:* technical-design.md:49 folds only U+FF01–U+FF5E, so the full-width space U+3000 is not folded. technical-design.md:53–55 accept only "one optional space or hyphen" (NRIC) and "single spaces or hyphens" (card/bank runs) between groups.
  - *Code that follows the design:* `packages/platform/src/pii-mask.ts:21-23` (`fold`), `:27` (`NRIC_RE`, `[ -]?`), `:66` (`RUN_RE`, `[ -]`).
  - *Observed:* `４２４２　４２４２　４２４２　４２４２` and `4242 4242 4242 4242` are stored raw through the live widget route and reach the model. Double-space, tab and en-dash separated cards are missed too, and so are NRICs with a double space or NBSP.
  - *Why it matters:* the design itself supports full-width input (AC-1), and an IME in full-width mode produces U+3000 along with full-width digits.
  - *Suggested amendment, for detailed-design to decide:* fold U+3000 to a space and treat U+00A0/U+202F/U+2007 and tabs as spaces before matching. Allow a short run of whitespace (for example 1–2) and the dashes U+2010–U+2015/U+2212 as separators. Add these to the corpus (both positive and negative cases, so that `9123  4567`-style phones and dates still pass). Re-check AC-4 and AC-10.

### Minor
- **M1 — A bank number followed by another number in the same run isn't masked.** Examples: `UOB 1234567890 2024-10-20` and `DBS acct 123456789012 2 pcs`. The run is longer than 12 digits, so the bank rule (`pii-mask.ts:144-150`, design §3.1 bank row) skips it. Cards already handle this case with windows (D9). Recommend folding window logic for bank runs into the DD-1 amendment (bank windows aligned to group boundaries, next to a keyword).
- **M2 — Identifiers glued to letters aren't masked.** Examples: `4242 4242 4242 4242pls` (the whole card stays raw), and `S1234567DS9876543C` (two NRICs run together). This comes from the `[A-Za-z0-9]` lookarounds (`pii-mask.ts:27`, `:66`; design §3.1). For NRICs it's a deliberate boundary (AC-1 `XS1234567D`). For a Luhn-valid 15/16-digit card followed by a letter, the amendment should consider masking.
- **M3 — `maskLogText` is quadratic.** `EMAIL_RE` (`pii-mask.ts:172`) takes 17 ms at 4000 chars, 267 ms at 16 000 and 4.8 s at 64 000. design §5.1:91 says "Every regex is linear". `logMethod` (`logger.ts:41`) and the `err` serializer run it on every string and stack. I found no attacker-controlled long string that reaches a log message today (Zod errors are answered with 400 and not logged). Recommend a bounded local-part quantifier or a length cap before matching.
- **M4 — The bare `log.error(err)` form leaks `msg`.** pino copies `err.message` into `msg` after the `logMethod` hook has run, so `log.error(new Error('… S1234567D'))` writes the raw value (`logger.ts:41-48`). No current caller uses this form; `logger.test.ts:26` tests only `{ err }`. Recommend masking `Error` arguments in the hook and adding the case to AC-7's test.
- **M5 — Object fields not in the redaction list, and `%o`/`%j` arguments, aren't scrubbed.** This is by design (D7, IDs-only rule) and noted for completeness.
- **M6 — Two tests asserted less than their criteria** (AC-6 bank value, AC-8 field/value matrix). Both are corrected (above).
- **M7 — The T8 evidence mislabels the size figures.** `tasks.md:22` says "loader 9.34 kB"; the loader is 1.75 kB and 9.34 kB is the lazy panel.
- **M8 — Unrelated churn.** `packages/platform/package.json:6` rewrites `§` as `§` in the description. It's cosmetic; revert it during the rework pass.
- **M9 — AC-9's "the raw number is not shown in the log" has no automated check.** I verified it directly (dev log, 0 hits). A spec-level log assertion is optional.

## RTM

Not written. The verdict is design defect. GOV-04's Test ref stays `_TBD_` until re-verification after the DD-1 amendment and its implementation.

## Routing

DD-1 goes to detailed-design's amendment path for FEAT-003 (technical-design §3.1 and §5.1, plus new AC-1/AC-2/AC-3 corpus variants). I recommend handling M1–M4 and M8 in the same pass. Then feature-implementation, then a fresh acceptance run, which will add a new dated verdict section to this report.
