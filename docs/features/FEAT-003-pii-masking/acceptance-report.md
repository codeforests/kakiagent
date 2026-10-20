# Acceptance Report: FEAT-003 — PII masking at the edge

> Verdict: **Design defect** (fourth verification) · Date: 2026-10-20
> Standard: technical-design.md §6 (AC-1..AC-10) as amended by D10–D16 @ `2b6839f` · Sources: SRS.md v0.4 (GOV-04, NFR-01, NFR-05, NFR-12), use-cases.md v0.4 (UC-20 step 4), ADR-015 decision 1
> Repo state audited: `2b6839f` on `claude/feat-003-pii-masking-ymm32o`

**History.** Round 1 (`efee620`): design defect, DD-1 (separator and full-width variants). Round 2 (`29dc915`, report `ad8bbd9`): design defect, DD-2 (space-grouped bank numbers masked in part). Round 3 (`ce5bbe8`, report `848bfde`): design defect, DD-3 (mixed space-and-hyphen and word-adjacent bank numbers left raw). Each report replaces the one before it.

## Verdict summary

DD-3 is closed. Every number it named (`DBS 123 456789-0`, `POSB 123-45678 9`, `DBS 123-456789 0`, `UOB 123-456 789-0`, `OCBC 501-234567 001`, `DBS acct1234567890`, `1234567890pls`) is masked whole with the right last four, in the unit corpus and in `messages.body` through the live widget route. M9 and M10 are closed by §8's new text, and M11 by the time-and-date exclusion. Every suite is green in this run, and NRIC and card masking are intact.

The verdict is still **design defect**. D16's three new rules each leave some keyword-adjacent account numbers fully or partly raw, and §8 does not list any of these cases (DD-4):
- a letter glued to a short number typed after a space-grouped account (`DBS 123 456 7890 2x`) leaves the whole account raw;
- `acct no-1234567890` is treated as a code prefix and left raw;
- the UOB 3-3-3-1 format with hyphens then a space (`UOB 123-456-789 0`) leaves its last digit raw and gives the wrong last four.

The code does what D16 specifies, so the fix belongs to detailed-design. It is small: a three-change prototype passes all 109 corpus cases and closes every DD-4 row (see below). No RTM Test ref is written.

## Standard re-derived (Phase 2)

- **GOV-04** (Must): "detect and mask NRIC/FIN, card numbers and bank accounts in visitor messages before storage and before sending to the LLM; mask other PII in logs." Acceptance: "NRIC/card numbers never appear unmasked in the database or the LLM payload (verified by tests)."
- **How clauses map to criteria.** NRIC → AC-1; card → AC-2; bank → AC-3; ordinary text and idempotence → AC-4; database → AC-5; LLM payload → AC-6; logs → AC-7; audit IDs → AC-8; UC-20 step 4 and SCR-WGT-002 (p) → AC-5 and AC-9; NFR-01 and NFR-05 → AC-10; NFR-12 → the coverage threshold.
- **D16 checked against its sources:**
  - **Faithful:**
    - "A chunk stands alone only when it has 9 or more digits and is solid or in three or more hyphenated groups." This closes the DD-3 mixed-separator rows and keeps `123-456789-0 5` correct.
    - Dropping D15's broad "glued to a letter" exclusion. This closes the word-adjacent rows.
    - §3.1's bank row now agrees with D16's wording (DD-3's wording mismatch is gone).
    - The new §8 text states the quantity-join cost (M10) and the `1234567890K` UEN gap accurately.
  - **Short of AC-3's general clause** ("a 9-to-12-digit number with a keyword within 40 characters … becomes `[BANK ••••<last 4>]`") and of D16's own principle ("when the rule is unsure, it masks"). See DD-4 for all three:
    - the single-letter exclusion is applied to the longest window, and nothing tries a shorter one;
    - the non-bank-word-and-hyphen exclusion catches the common label `no`;
    - a 9-digit three-group chunk stands alone even when it is the first three groups of UOB's 3-3-3-1 format, which D16 itself names.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | GOV-04 NRIC/FIN | `pii-corpus.json` `nric-*`, `checksums` | faithful | green; live route masks `S1234567D` |
| AC-2 | GOV-04 cards | corpus `card-*`, `cardPrefixOk`, seeded random set | faithful | green; live route masks `4242 4242 4242 4242` |
| AC-3 | GOV-04 bank accounts | corpus `bank-*`, `neg-bank-*`. Every example AC-3 now names is pinned, including the seven new D16 cases and `neg-bank-time-date`. | faithful for its named examples; **the general clause fails for the DD-4 rows**. No failing test is committed; the cases are listed under DD-4 for the amendment | green on the corpus (109/109); `DBS 123 456 7890 2x`, `DBS acct no-1234567890` and `UOB 123-456-789 0` are stored raw or partly raw (live route and `messages` row) |
| AC-4 | GOV-04 ordinary text; idempotence | corpus `neg-*`; idempotence over every case and 2000 seeded random inputs | faithful as worded (corpus only) | green. A 300 000-input fuzz finds non-idempotent inputs outside the corpus (M12) |
| AC-5 | database | `apps/api/test/widget-pii.int.test.ts` | faithful | green (api 12/12) |
| AC-6 | LLM payload | `agent/test/turn.int.test.ts`, `llm-gateway/src/mask.test.ts` | faithful | green (agent 11/11) |
| AC-7 | logs | `platform/src/logger.test.ts`, `maskLogText` tests | faithful | green |
| AC-8 | audit IDs | `governance/src/payload.test.ts` | faithful | green (governance 19 integration) |
| AC-9 | UC-20 step 4, SCR-WGT-002 | `e2e/tests/pii-mask.e2e.ts` | faithful | green (chromium 5/5) |
| AC-10 | NFR-01, NFR-05 | `pii-mask.test.ts` performance (CPU time, best of five) and `maskLogText` performance | faithful | green. Worst 4000-character `piiMask` input in my probes: 5.1 ms CPU, including four new D16-targeted inputs at ≤ 2.2 ms. `maskLogText` on 256 000 characters: 68 ms (linear) |

## Corrected tests

None. `2b6839f` adds 10 corpus cases (50 lines added, none removed). It skips nothing, loosens no assertion and changes no test file or coverage configuration. I ran the mutation check myself: all 10 new cases fail against the D15 masker (`ce5bbe8`), and all 109 cases pass at HEAD (`/tmp/claude-0/rv4/m.ts`).

I did not commit the DD-4 cases as failing tests, because the design has not yet chosen their behaviour. They are listed below for the amendment.

## Independent execution

All runs are mine, at `2b6839f`, with turbo `--force` (0 cached), on this 4-core container. Logs are in `/tmp/claude-0/rv4/`.

| Check | Command | Result |
| :- | :- | :- |
| Format | `pnpm format:check` | pass |
| Lint and boundaries | `pnpm turbo run lint --force`, then `pnpm lint` | 24/24 tasks; no dependency violations (205 modules, 444 dependencies) |
| Typecheck | `pnpm turbo run typecheck --force` | 26/26 |
| Unit | `pnpm turbo run test --force` | 21/21 tasks; platform 240 tests (`pii-mask.test.ts` 230) |
| Integration | `pnpm turbo run test:integration --force` | 14/14: db 40, platform 4, governance 19, inbox 5, kb 9, api 12, agent 11 |
| Coverage | `pnpm test:coverage --concurrency=2 --force` | 15/15; `src/pii-mask.ts` 100% lines, 96.3% branches, 100% functions |
| Build / size | `pnpm turbo run build --force`, then `pnpm size` | 9/9; loader 1.75 kB, panel 9.34 kB, initial load 1.75 kB gz |
| Eval | `pnpm eval --fast` | 52 cases; groundedness 8/8, prices 44/44 |
| E2E | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e --project=chromium` | 5/5, including `pii-mask.e2e.ts` |

My first lint attempt failed because I passed `--force` through to depcruise, which rejects it. That was my invocation, not the repo; the re-run above is the CI form.

**Server freshness.** The running `pnpm dev` was started at 06:12:12, 45 s before the `2b6839f` commit timestamp, and its API runs under `tsx watch`. Its output matches HEAD on inputs where D15 and D16 differ: `DBS 123 456789-0` is stored as `DBS [BANK ••••7890]`, where D15 left it raw. So the live route serves the D16 masker.

**Anti-fake-green review.** `git diff 848bfde 2b6839f` touches only `pii-corpus.json` among test artifacts, and only with additions. No migrations are in this feature.

## Direct verification

- **Live widget route** (`/tmp/claude-0/rv4/live.sh`, conversation `b67c1451-…`; read back from `messages.body` in Postgres):

  | Message sent | Stored as |
  | :- | :- |
  | `rv4a DBS 123 456789-0` | `rv4a DBS [BANK ••••7890]` |
  | `rv4b POSB 123-45678 9 and DBS 123-456789 0` | both masked whole |
  | `rv4c DBS acct1234567890 / 1234567890pls DBS` | both masked |
  | `rv4d card 4242 4242 4242 4242 IC S1234567D` | both masked |
  | `rv4e DBS 123 456 7890 2x` | **raw, unchanged** |
  | `rv4f UOB 123-456-789 0` | `UOB [BANK ••••6789] 0`: **last digit raw, wrong last four** |
  | `rv4g DBS acct no-1234567890` | **raw, unchanged** |

- **Probes** (`/tmp/claude-0/rv4/p.ts`, about 60 inputs; `/tmp/claude-0/rv4/q.ts`, the idempotence fuzz):
  - **Mixed separators:** `OCBC 501 234567-001`, `UOB 123 456-789-0`, `DBS 123-45 6789-0` and `DBS 12-34 56-78 90` are masked whole.
  - **Hyphenated number then a quantity:** `123-456789-0 5` and `123-456789-0 2 pcs` keep the quantity out.
  - **Bank-word hyphen prefixes:** `account-`, `acc-`, `savings-`, `户口-` and `DBS-` are masked; `Ref-1234567890` is left alone.
  - **Card and NRIC interactions:** a card or NRIC next to a bank number in the same run gives both tokens.
  - **Times and dates:** `DBS 12:30 123 456 7890` masks the account and leaves the time; `24/10/2026 1234567890` masks the account.
- **Pending environment:** none.

## Findings

### Rework
None. The code implements D16 as D16 states it.

### Design defect
- **DD-4: D16's exclusions leave some keyword-adjacent bank numbers raw (GOV-04 "mask … bank accounts"; AC-3 general clause; D16's "when the rule is unsure, it masks").**
  - **What the sources require.** AC-3 (technical-design.md:121): "A 9-to-12-digit number with a keyword within 40 characters … also when a date or quantity follows it … becomes `[BANK ••••<last 4>]`."
  - **What the design says** (technical-design.md:55, :146): "other chunks join, from the earliest, into the longest window of 9–12 digits". The exclusions are "one letter right after it (the UEN shape), a non-bank word and a hyphen before it". A chunk "in three or more hyphenated groups" stands alone.
  - **Where the code follows it** (`packages/platform/src/pii-mask.ts`): `notAnAccount` (line 201), `whole` (line 252), and the single longest-window `take` (line 274). The window search never tries a shorter window.
  - **Observed** (unit; rows 1, 4 and 6 also through the live route and the `messages` row):

    | Input | Now (D16) | Why |
    | :- | :- | :- |
    | `DBS 123 456 7890 2x`, `DBS 1234 5678 90 2x`, `DBS 123 456789 0 2x more` | unchanged | The longest window `…7890 2` ends at a single letter, so it is a "UEN". No shorter window is tried, and later start chunks have fewer than 9 digits. |
    | `UOB 123 456 789 0 5k` | unchanged | as above |
    | `DBS 123 456 7890K` | unchanged | as above, and §8 doesn't cover it (§8 covers only `1234567890K`) |
    | `DBS acct no-1234567890`, `A/C No-1234567890 DBS` | unchanged | `no` is not in `BANK_WORD`, so `no-` is a "code prefix" |
    | `DBS a/c no-123-456789-0` | unchanged | as above |
    | `UOB 123-456-789 0` | `UOB [BANK ••••6789] 0` | `123-456-789` (9 digits, three groups) stands alone. This is DD-2's symptom on the UOB 3-3-3-1 format D16 names: the last digit is raw and the token's last four are wrong. |

  - **Effect.** In the first five rows the whole account number is stored and sent to the model in clear, next to its bank's name. NRIC and card masking are unaffected.
  - **Suggested amendment, for detailed-design to decide.** I tried three changes on a scratch copy (`/tmp/claude-0/rv4/proto.ts`; production code untouched). Together they pass all 109 corpus cases, including `bank-hyphenated-then-number`, `bank-solid-then-qty`, `neg-bank-uen`, `neg-bank-code`, `neg-bank-invoice` and `neg-bank-time-date`, and they mask every row above whole with the right last four:
    1. When the longest window is excluded, try the next shorter window of 9 or more digits from the same start, longest first. This is D16's "when unsure, it masks".
    2. Add the label words `no`, `number`, `num` and `nbr` to the bank words that may precede a hyphen.
    3. A hyphenated chunk stands alone only with three or more groups **and** 10 or more digits. A 9-digit one (`123-456-789`, or POSB `123-45678-9`) joins a following short chunk, which is the "masks more" cost §8 already accepts.

    Add the table's inputs as corpus positives, and update the §3.1 bank row and D16 to match.

### Minor
- **M12: idempotence fails outside the corpus, and the first pass stores an NRIC raw.**
  - A digit-adjacent NRIC is left alone under AC-1 (`S1234567D9`). When the adjacent digits are then masked as a card or bank number, the token's `[` releases it, so a second pass masks it:
    - `S1234567D4242424242424242` → `S1234567D[CARD ••••4242]` → `[NRIC ••••567D][CARD ••••4242]`;
    - `acct S1234567D1234567890` behaves the same way.
  - AC-4 is worded over corpus cases only, so it holds. But §3.1's claim "masking twice changes nothing" is false, and `messages` keeps the raw NRIC while the gateway's second mask hides it from the model.
  - The bank case is new in D16, which dropped the letter-before exclusion. The card case dates from D11.
  - The inputs are contrived (an NRIC typed directly against a card or account number), and AC-1 explicitly sanctions the first pass. I recommend handling it in the same amendment: mask to a fixed point, or re-check NRIC boundaries after masking. Otherwise correct §3.1's claim and list the case in §8.
- **M13: other exclusion edges D16 states but §8 doesn't list.**
  - A number after a digit and `:`, `.` or `/` (`DBS acct 3/1234567890`, `DBS 1.1234567890`) is left raw.
  - A single trailing letter before punctuation (`DBS 1234567890a.`) is left raw.
  - Dotted accounts (`DBS 123.456.7890`) are left raw, since D15 keeps `.` a separator of ordinary text.
  - All three are rare in typed chat. List them in §8 as accepted gaps.
- M2 (D13 prefixes) and M5 (D7 object fields) from earlier rounds: unchanged, by design.

### Prior findings
- DD-1, DD-2: closed in earlier rounds.
- DD-3: **closed** (every row re-probed, unit and live).
- M9 (glued numbers not listed as a gap): **closed**. They are now masked, and §8 lists the one remaining case (`1234567890K`).
- M10 (quantity joined after a space-grouped account): **closed**. §8 now states the hidden quantity and the off-by-one token.
- M11 (time and date tails over-masked): **closed**. `DBS 10:30 24 10 2026` is unchanged and pinned. The phone-without-`+` case is listed in §8.
- M1, M3, M4 and M7: closed earlier. M6 and M8 stand as process notes; the server was confirmed fresh this round.

## RTM

Not written. The verdict is design defect, so GOV-04's Test ref stays `_TBD_`.

## Routing

DD-4 goes to detailed-design's amendment path for FEAT-003. The amendment covers D16, the §3.1 bank row, AC-3's examples and §8's accepted gaps; fold M12 and M13 into it. Then comes feature-implementation (a new task with the DD-4 rows as corpus positives), then a fresh acceptance run.
