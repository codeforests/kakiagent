# Acceptance Report: FEAT-003 — PII masking at the edge

> Verdict: **Design defect** (re-verification) · Date: 2026-10-20
> Standard: technical-design.md §6 (AC-1..AC-10) as amended by D10–D14 @ `29dc915` · Sources: SRS.md v0.4 (GOV-04, NFR-01, NFR-05, NFR-12), use-cases.md v0.4 (UC-20 step 4), ADR-015 decision 1 and consequences, ADR-007, ADR-011
> Repo state audited: `29dc915` on `claude/feat-003-pii-masking-ymm32o` (includes the merge of main `9147ad2`, the D13 card-prefix commit `ad38d56` and the D14 timing commit), plus this audit's corpus correction `d249e1e`

**History.** First verification (2026-10-20, at `efee620`): **design defect**. DD-1: ideographic, no-break and double spaces, tabs and dashes let card and NRIC numbers through unmasked. There were also minors M1–M9. The design was amended (D10–D12, revised AC-1/2/3/7/10), the code reworked (`df909e0`, T9), and CI follow-ups added D13 (`ad38d56`, T10) and D14 (`29dc915`, T11). This section replaces the first report; its findings are summarised under "Prior findings" below.

## Verdict summary

DD-1 is closed. Every separator and full-width variant the first verification found is now masked: in the unit corpus, through the live widget route on a freshly started stack, and in the database and logs. The bare `log.error(err)` leak (M4) and the quadratic email pattern (M3) are fixed, and every suite is green in this run.

The verdict is still **design defect**, because amendment D12 introduced a regression of its own (DD-2). The rule is "the window with the fewest chunks wins". Under it, a bank account written with spaces in the usual Singapore groupings is masked only in part. DBS 3-6-1, UOB 3-3-3-1 and OCBC 3-6-3 each leave the last group raw and put the wrong four digits in the token: `DBS 123 456789 0` becomes `DBS [BANK ••••6789] 0`. Before the rework, all three were masked whole. AC-3 says such a number "becomes `[BANK ••••<last 4>]`", and D12 claims that space-grouped numbers still match whole. The code does exactly what D12 specifies, so the fix belongs to detailed-design. It is a small change to the bank-window preference, and it doesn't touch the binding NRIC/card clause, which holds. No RTM Test ref is written.

## Standard re-derived (Phase 2)

- **GOV-04** (Must): "PII handling: detect and mask NRIC/FIN, card numbers and bank accounts in visitor messages before storage and before sending to the LLM; mask other PII in logs." Acceptance: "NRIC/card numbers never appear unmasked in the database or the LLM payload (verified by tests)."
- Each clause has a criterion:
  - NRIC/FIN → AC-1; cards → AC-2; bank accounts → AC-3; ordinary text → AC-4.
  - Database → AC-5; LLM payload → AC-6; logs → AC-7; audit IDs (FEAT-002 M1) → AC-8.
  - UC-20 step 4 → AC-5 and AC-9, with SCR-WGT-002 (p) → AC-9.
  - NFR-01 and NFR-05 → AC-10; NFR-12 → the 70% line threshold on `src/pii-mask.ts` (unchanged).
- **Amendments audited against their sources:**
  - D10 (fold U+3000, U+00A0, U+202F, U+2007, tab, U+2010–U+2015, U+2212; 1–2 spaces or a spaced hyphen as a separator) is faithful to ADR-015's "with separators" and "spacing variants". It closes DD-1 for every character it lists.
  - D11 (identifiers may touch letters) is faithful.
  - D13 (cards start with 2–6, and 13-digit cards with 4) is a sound narrowing. Every network a Singapore visitor pays with is covered: Visa, Mastercard 2/5, Amex, JCB 35, UnionPay 62, Discover/Diners. It rests on AC-4 (a Luhn-valid `Date.now()` timestamp is not a card).
  - D14 (AC-10 measured in CPU time, best of five) keeps the criterion's purpose. CPU time is never less than the masker's own compute, so catastrophic backtracking would still fail. NFR-01's latency budget is unaffected (about 2 ms of compute).
  - **D12 is where the standard falls short** (DD-2, below). AC-3's wording ("a 9-to-12-digit number … becomes `[BANK ••••<last 4>]`") and D12's own claim ("Space-grouped numbers … still match") can't both be met under D12's preference rule.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | GOV-04 NRIC/FIN | `platform/src/pii-corpus.json` `nric-*` (all five prefixes, lower case, spaced, double space, NBSP, U+3000, hyphen, full-width, Chinese context, glued before/after, glued pair; negatives: bad letter, 6/8 digits, trailing digit, `neg-spaced-word`), `checksums` | **was incomplete → corrected** (no NRIC with a dash, which AC-1 names): `nric-dash` added | green; live route masks `S  1234567  D`, `S　9876543　C`, `S1234567DS9876543C` |
| AC-2 | GOV-04 cards | corpus `card-*` (plain, groups, hyphen, en dash, spaced hyphen, U+3000 full-width, NBSP, double space, tab, glued before/after, Amex, 13, 19, qty after, number before, Chinese; negatives Luhn fail, too long, `neg-timestamp`, `neg-luhn-order-id`, `neg-13-not-visa`); `cardPrefixOk` unit test; seeded random check | **was incomplete → corrected** (U+202F, U+2007 and U+2212 are folded kinds AC-2 names but no case pinned them): `card-narrow-nbsp`, `card-figure-space`, `card-minus-sign` added; mutation: prefix check off → 3 D13 negatives red | green; live route masks all DD-1 forms and leaves a `Date.now()` timestamp alone |
| AC-3 | GOV-04 bank accounts | corpus `bank-*` (DBS, after keyword, UOB, POSB, 12 digits, 户口/转账, 银行账号 after, en dash, then date, then qty, hyphenated then number, space groups `1234 5678 90`; negatives no keyword, `+65` phone, far keyword, keyword inside word) | faithful for the cases it holds; **the AC itself fails for space-grouped 3-6-1 / 3-3-3-1 / 3-6-3 numbers under D12 (DD-2)**; no failing test committed, the cases are listed under DD-2 for the amendment | green on the corpus; `DBS 123 456789 0` → `DBS [BANK ••••6789] 0` (live route and unit) |
| AC-4 | GOV-04 ordinary text; idempotence | corpus `neg-*` (now 21, incl. `neg-two-spaces-numbers`, `neg-zh-spaces`, `neg-dash-range`, `neg-spaced-word`, the D13 negatives); idempotence over every case and 2000 seeded random inputs (alphabet now includes U+3000, NBSP, en dash, tab) | faithful; the random check's narrowing to issued-prefix 16-digit cards follows D13 (declared, sound) | green |
| AC-5 | GOV-04 "never unmasked in the database" | `apps/api/test/widget-pii.int.test.ts` (unchanged since the first verification) | faithful | green (api 12/12); live scan clean (below) |
| AC-6 | GOV-04 "… or the LLM payload" | `agent/test/turn.int.test.ts` (as corrected in `3264c91`), `llm-gateway/src/mask.test.ts` | faithful | green (agent 11/11, llm-gateway 15/15) |
| AC-7 | GOV-04 "mask other PII in logs" | `platform/src/logger.test.ts` (message + format arg; `{ err }` message and stack; bare `log.error(err)` now covered; redacted fields); `maskLogText` unit tests | faithful | green; my logger probes (`err.cause`, `log.warn(err, fmt, email)`, child loggers) leak nothing beyond the D7 by-design cases (M5) |
| AC-8 | GOV-04 + GOV-01 | `governance/src/payload.test.ts` (as corrected in `595c541`) | faithful | green (governance 74 unit, 19 integration) |
| AC-9 | UC-20 step 4, SCR-WGT-002 | `e2e/tests/pii-mask.e2e.ts` | faithful; "not shown in the log" checked directly | green (chromium 5/5 on a stack I started); dev log 0 raw hits |
| AC-10 | NFR-01, NFR-05 | `pii-mask.test.ts` "performance (AC-10)" (5 adversarial 4000-char inputs, best-of-five CPU time < 20 ms) and "maskLogText performance" (3 × 16 000-char inputs, best-of-three CPU time) | faithful to the amended AC (D14); the log test uses best of three where AC-10 says best of five, a stricter reading, fine | green; my wall-time probes: worst 4000-char input 3.3 ms, worst 16 000-char log line 5.6 ms |

## Corrected tests

1. **AC-1, AC-2** (`d249e1e`, `packages/platform/src/pii-corpus.json`). AC-1 names "a hyphen or dash" between NRIC groups. AC-2 names "one or two spaces of any of the folded kinds" and "hyphens or dashes". The corpus had no NRIC with a dash, and no card with U+202F, U+2007 or U+2212. I removed U+202F, U+2007 and U+2212 from `fold` as a temporary mutation, and every test stayed green.
   - Added `nric-dash` (en dash and minus sign), `card-narrow-nbsp`, `card-figure-space` and `card-minus-sign`.
   - All four pass against the unchanged code. With that mutation, all four go red.
   - The file now has 86 cases.

The two corrections from the first verification (`3264c91` AC-6, `595c541` AC-8) are still in place and green.

## Independent execution

All runs below are mine, at `29dc915` + `d249e1e`, with turbo `--force` (0 cached), on this 4-core container.

| Check | Command | Result |
| :- | :- | :- |
| Format | `pnpm format:check` | pass |
| Lint + boundaries | `pnpm turbo run lint --force`; `pnpm lint` | 24/24; dependency-cruiser no violations |
| Typecheck | `pnpm turbo run typecheck --force` | 26/26 |
| Unit | `pnpm turbo run test --force` | 21/21 tasks (platform 193, governance 74, agent 131, llm-gateway 15, widget 6, …) |
| Integration | `pnpm turbo run test:integration --force --concurrency=1` (Testcontainers) | 14/14 tasks: db 40, platform 4, governance 19, kb 9, inbox 5, api 12, agent 11 |
| Coverage gate | `pnpm test:coverage --concurrency=2 --force` (as CI) | 15/15; `src/pii-mask.ts` 100% lines, 97.5% branches; `logger.ts` 100% lines (threshold 70% lines; coverage config unchanged on the branch) |
| Build / size | `pnpm turbo run build --force`; `pnpm size` | 9/9; loader 1.75 kB gz (≤ 14), panel 9.34 kB (≤ 35), initial 1.75 kB (≤ 30) |
| Eval | `pnpm eval --fast` | 52 cases; groundedness 8/8, prices 44/44; exit 0 |
| E2E | `E2E_REUSE_SERVERS=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=… pnpm test:e2e --project=chromium`, against a `pnpm dev` **I started at `ad38d56`** (the later commits are test- and doc-only); run twice, the second time at `d249e1e` | 5/5 both times (facts, pii-mask, skeleton ×3; the skeleton spec sends a `Date.now()` timestamp, so D13 is exercised) |

I ran the suites three times as the coordinator's commits landed: at `9147ad2`, at `ad38d56` (stopped before coverage when D14 arrived), and at `29dc915` + `d249e1e`. Every completed run was green, and I saw no flakiness.

**Stale servers (process finding).** The `pnpm dev` that was already running (started 05:05, roles respawned 05:25) did not reload `packages/platform/src/pii-mask.ts` after it changed at 05:34 or at `ad38d56`. `tsx watch` didn't pick up the change; even touching the file didn't trigger a restart. With D13 in place, sending the 81 non-empty corpus cases through its widget route gave 3 mismatches: the three D13 negatives were masked as cards. So E2E runs against that server would not have tested the HEAD masker. I stopped it with SIGTERM to its turbo process and started my own `pnpm dev`. On the fresh server, all 81 cases match exactly, and E2E above ran against it. That server is still running; a copy of its output is in `/tmp/claude-0/rv/dev-server.out`. The earlier "E2E chromium 5/5" claims in T9–T11 may have run against stale code, which is one more reason they're exhibits, not evidence.

**Mutation checks** (temporary edits to `pii-mask.ts`, each restored from a copy, with `git status` clean afterwards):
- dropping U+202F, U+2007 and U+2212 from the fold → the 4 new corpus cases go red;
- removing `cardPrefixOk` from the window filter → `neg-timestamp`, `neg-luhn-order-id` and `neg-13-not-visa` go red.

The first verification's mutation checks (gateway backstop, `logMethod`, audit `isCode`, bank pass) cover code this rework didn't change.

**Anti-fake-green review** (`git diff origin/main..HEAD` on test files): nothing was deleted except the stub's pass-through test (intended), and no `.skip`, `.only` or `.todo` was added. The wall-time → CPU-time change (D14) is declared and amends AC-10 first. The random-input card check's narrowing (D13) is declared and follows the design. Two corpus negatives became positives under D11, which D11 also declares. No coverage configuration changed.

**Migrations:** none in this feature. Every integration suite builds a fresh database.

## Direct verification

- **Live widget route** (scripts `/tmp/claude-0/rv/live.sh` and `/tmp/claude-0/rv/livecorpus.py`, against my fresh server):
  - **DD-1 is closed on the live route.** Every one of these came back and was stored as `[CARD ••••4242]`: `４２４２　４２４２　４２４２　４２４２`, NBSP, U+202F, double space, tab and en dash separators.
  - NRICs with a double space or U+3000, and `S1234567DS9876543C`, came back masked.
  - Glued `…4242pls` and `UOB 1234567890 2024-10-20` were masked.
  - `Do you have pandan cake? 1792474873370` was unchanged; a 13-digit Visa and an Amex 4-6-5 were masked.
  - Ordinary text (`2  cakes  and  3  tarts, call 9123 4567, open 10–6`) was unchanged.
  - Agent replies arrived.
  - **Table scans:** after the probes, a scan of `messages` (the probe conversation, separators stripped), `outbox`, `conversations`, `audit_entries` and `audit_pii` for the raw values found 0 rows. The dev server's output (539 lines) has 0 raw hits.
- **Unit-level probes** (`/tmp/claude-0/probe/p.ts` from the first round, plus new `/tmp/claude-0/rv/p2.ts`, `p3.ts` and `cmp.ts`, which compares against the pre-rework masker):
  - Every DD-1, M1 and M2 input listed in the first report now gives the expected output.
  - Remaining misses and over-masking are recorded as DD-2 and M-findings below.
- **D13:** JCB `3530…`, UnionPay `62…`, Mir `2200…`, Mastercard `2221…`, Maestro `67…`, Diners `36…` (14 digits) and Visa-13 are masked. UATP `1…`, `9…` and `7…` prefixes and a 13-digit `5…` are not (by design).
- **Singlish and Chinese false-positive sweep:** 33 ordinary bakery messages. Examples: `订 2 个蛋糕，10月24号 3点 取，电话 9123　4567`, `要 3　盒 凤梨酥 和 2　个 蛋糕`, `Order 1234 5678 9012 3456 7 ok?`, `pls call 9123-4567 or 8123 - 4567`, `S1234567 is my order no.`, `pandan 2x, kaya 3x, total S$45.60 PayNow 9123 4567`. 24 are unchanged. The 9 that change all sit next to a bank keyword: UEN after `PayNow` (`[BANK ••••2345]K`), `PayNow, ref 20261020 1234`, a promo code after `bank`, `savings 10 20 30 40 50`, `current 1 2 … 12`, `my acct got 1 2 … 9 points`, two phone numbers after "bank transfer", and `GF-123-456-789`/`INV-2026-10-0001` before "bank". This is over-masking of the D4 kind, which the design accepts (M3 below).
- **ReDoS / NFR-05** (`/tmp/claude-0/probe/perf.ts`, `/tmp/claude-0/rv/redos.ts`, `/tmp/claude-0/rv/ph.ts`; best of 5, wall time on a shared container, indicative only):
  - **`piiMask` on 32 adversarial 4000-character inputs:** max 3.3 ms. The inputs: digit/space, digit/double-space, digit/spaced-hyphen, mixed separators, U+3000, NBSP, tab, en dash, near-NRICs, double-spaced NRIC shapes, glued NRIC chains, valid cards, keyword-per-chunk, Chinese keywords between digits, and email-ish strings.
  - Longer inputs grow linearly: `1 ` × 32 000 takes 15.7 ms.
  - **`maskLogText` on 16 000 characters:** max 5.6 ms. The email pattern is now linear: 64 000 characters take 1 ms, where the first round measured 4.8 s.
  - One quadratic path is left, the phone replacement (M4): 40 ms at 64 000 characters of phone numbers, 4.4 s at 256 000.
- **Logger** (`/tmp/claude-0/rv/log.ts`): the bare `log.error(err)`, `log.warn(err, fmt, email)`, `err.cause` and child-logger forms all come out masked. Unredacted object fields and `%o` arguments still pass through; D7 intends this (M5 from the first round).
- **Contracts:** `findPii`/`piiMask`/`maskLogText` and the new exported `cardPrefixOk` live on `@kaki/platform/pii-mask`. Gateway, governance and logger contracts are unchanged from the first verification. No HTTP shape changed.
- **Screens:** SCR-WGT-002 shows the stored body (E2E); no new styles; manifest unchanged.
- **Pending environment:** none.

## Findings

### Rework
None. The code implements the amended design as written.

### Design defect
- **DD-2 — D12's "fewest chunks first" rule masks space-grouped Singapore bank numbers only in part, which is a regression (GOV-04 "mask … bank accounts"; AC-3; D5).**
  - **What the sources require:** AC-3 (technical-design.md:121) says "a 9-to-12-digit number with a keyword within 40 characters … becomes `[BANK ••••<last 4>]`". D12 (technical-design.md:142) adds "Space-grouped numbers … still match as a three-chunk window". D5 says the token shows the number's last four digits.
  - **What the design says:** technical-design.md:55 (bank row) and D12 choose the window with "fewest chunks first, then earliest". A space-grouped number whose first chunks already reach 9 digits is therefore cut at the first window that reaches 9 digits.
  - **Code that follows the design:** `packages/platform/src/pii-mask.ts:233` (`windows.sort((a, b) => a.n - b.n || a.start - b.start)`).
  - **Observed** (unit, and stored through the live widget route):

    | Input | Output now | Output before the rework |
    | :- | :- | :- |
    | `DBS 123 456789 0` | `DBS [BANK ••••6789] 0` | whole number masked |
    | `UOB 123 456 789 0` | `UOB [BANK ••••6789] 0` | whole number masked |
    | `OCBC 501 234567 001` | `OCBC [BANK ••••4567] 001` | whole number masked |
    | `DBS acct 123 456 789 012` | `DBS acct [BANK ••••6789] 012` | whole number masked |

    `POSB 123 45678 9` and `1234 5678 90` are still masked whole, because their first two chunks hold fewer than 9 digits.
  - **Effect:** 1–3 digits of the account are stored in clear, and the token names the wrong last four, so staff can't tell which account was meant (D5's purpose). The account can't be rebuilt from what is stored, and the binding NRIC/card clause is not affected.
  - **Suggested amendment, for detailed-design to decide:** take the earliest start first, then the longest window of 12 digits or fewer, and never join a hyphen-joined chunk with another chunk, because a hyphenated bank number is complete in itself. I tried this rule on a scratch copy of the masker (`/tmp/claude-0/rv/proto.ts`; production code untouched). It passes all 86 corpus cases, including `bank-then-date`, `bank-then-qty`, `bank-hyphenated-then-number` and `bank-spaced-groups`, and masks the four inputs above whole. Add those four as corpus positives.

### Minor
- **M1 — Whitespace and dash characters not yet folded.** Each of the following leaves a card or NRIC unmasked:
  - three or more spaces;
  - a line break (`\n`, `\r\n`);
  - U+2009 thin space and U+2002/U+2003 en/em spaces;
  - U+200B zero-width space and U+00AD soft hyphen;
  - U+FE63 small hyphen-minus;
  - `.` or `/` as a group separator.

  Ordinary keyboards rarely produce these in the widget, but email bodies (FEAT-034+, which reuse this masker per §8) will wrap lines, and copy-paste can bring in zero-width characters. Recommend folding the whole Unicode `Zs` class plus `\n`, `\r`, U+200B and U+00AD to a space when the email channel lands (design §5.1 `fold`; `pii-mask.ts:26-30`). Not blocking for the widget path.
- **M2 — D13 leaves non-2–6 prefixes unmasked.** UATP (1), some fleet and private-label cards (7, 8) and some domestic schemes (9) fall outside the rule. The design states this and accepts it (`pii-mask.ts:150`). Noted so the corpus records it if a pilot tenant takes such cards.
- **M3 — New over-masking from D11 and D12, next to bank keywords.** Examples: `PayNow to UEN 201912345K` → `[BANK ••••2345]K`; `my bank promo code 123456789A`; `savings 10 20 30 40 50`; two phone numbers before "bank transfer"; `GF-123-456-789 bank`. D4 accepts over-masking, but a UEN after "PayNow" is a common Singapore payment phrase. Consider making a run glued to a trailing letter ineligible as a bank number, as for NRICs.
- **M4 — The phone replacement in `maskLogText` is quadratic.** `replaceOnFolded` (`pii-mask.ts:302-306`) re-slices the whole string for every match. It is well inside AC-10 at 16 000 characters (3 ms), but takes 40 ms at 64 000 and 4.4 s at 256 000 characters of phone numbers. Build the output in one pass, as `piiMask` does.
- **M5 — Object fields not in the redaction list, and `%o`/`%j` arguments, aren't scrubbed.** Unchanged from the first round; D7 intends this.
- **M6 — Two corpus gaps against AC-1/AC-2's named variants.** Corrected (above).
- **M7 — The T9 evidence miscounts the corpus.** `tasks.md:25` says "80 in all"; the commit had 79 cases (57 + 22).
- **M8 — Process: the reused `pnpm dev` served a stale masker.** It didn't reload after `pii-mask.ts` changed (see Independent execution). Future verifications and implementation E2E evidence should start servers cold.

### Prior findings (first verification)
- DD-1: closed.
- M1 (bank followed by a date or quantity): closed by D12, which caused DD-2.
- M2 (identifiers glued to letters): closed by D11.
- M3 (quadratic email pattern): closed.
- M4 (bare `log.error(err)`): closed and tested.
- M5: by design.
- M6 (tests corrected): stands.
- M7 (size labels in T8): fixed.
- M8 (`package.json` churn): fixed; the file's description no longer differs from main.
- M9 (no automated log check for AC-9): unchanged, and verified directly again.

## RTM

Not written. The verdict is design defect, so GOV-04's Test ref stays `_TBD_`.

## Routing

DD-2 goes to detailed-design's amendment path for FEAT-003: D12, the bank row in §3.1, and four AC-3 corpus positives. I recommend handling M1 (at least `\n` and `Zs`), M3 and M4 in the same pass. Then feature-implementation, then a fresh acceptance run on a cold-started stack.
