# Acceptance Report: FEAT-003 — PII masking at the edge

> Verdict: **Design defect** (third verification) · Date: 2026-10-20
> Standard: technical-design.md §6 (AC-1..AC-10) as amended by D10–D15 @ `ce5bbe8` · Sources: SRS.md v0.4 (GOV-04, NFR-01, NFR-05, NFR-12), use-cases.md v0.4 (UC-20 step 4), ADR-015 decision 1
> Repo state audited: `ce5bbe8` on `claude/feat-003-pii-masking-ymm32o`

**History.**
- First verification (at `efee620`): **design defect**, DD-1 (separator and full-width variants let cards and NRICs through).
- Second verification (at `29dc915`, report `ad8bbd9`): **design defect**, DD-2 (D12 masked space-grouped bank numbers only in part), with minors M1, M3, M4 and M7.
- Each report replaces the one before it. Prior findings are summarised at the end.

## Verdict summary

DD-2 is closed. `DBS 123 456789 0`, `UOB 123 456 789 0`, `OCBC 501 234567 001` and `DBS acct 123 456 789 012` are now masked whole with the right last four, both in the unit corpus and through the live widget route. M1, M3, M4 and M7 are closed too, and every suite is green in this run.

The verdict is still **design defect**, because D15's new chunk rule introduces a regression of its own (DD-3). Some bank numbers that D12 masked are now stored completely raw:
- numbers typed with a mix of hyphens and spaces (`DBS 123 456789-0`, `UOB 123-456 789-0`, `POSB 123-45678 9`);
- numbers glued to the bank keyword or to a following word (`DBS acct1234567890`, `DBS 1234567890pls`).

AC-3's general clause says "a 9-to-12-digit number with a keyword within 40 characters … becomes `[BANK ••••<last 4>]`". The code does what D15 specifies, so the fix belongs to detailed-design. It is small: a prototype of it passes all 99 corpus cases (see below). The binding NRIC/card clause holds. No RTM Test ref is written.

## Standard re-derived (Phase 2)

- **GOV-04** (Must): "detect and mask NRIC/FIN, card numbers and bank accounts in visitor messages before storage and before sending to the LLM; mask other PII in logs." Acceptance: "NRIC/card numbers never appear unmasked in the database or the LLM payload (verified by tests)."
- **Clause to criterion:**
  - NRIC → AC-1, card → AC-2, bank → AC-3, ordinary text and idempotence → AC-4.
  - Database → AC-5, LLM payload → AC-6, logs → AC-7, audit IDs → AC-8.
  - UC-20 step 4 and SCR-WGT-002 (p) → AC-5 and AC-9.
  - NFR-01 and NFR-05 → AC-10; NFR-12 → coverage threshold.
- **D15 audited against its sources:**
  - The fold extension (every `Zs`, `\t\n\r`, U+200B, U+FE58, U+FE63, U+00AD) is faithful. It is one unit to one, so offsets hold. It closes M1.
  - "9+-digit chunks stand alone" is faithful. It closes DD-2 and keeps `1234567890 2 pcs` correct.
  - The declared cost (a 1–2-digit number after a space-grouped account is joined to it) is a sound "masks more" trade, though see M10.
  - **Two parts of D15 fall short of AC-3** (DD-3):
    - "one written with hyphens is a number on its own" is implemented, as D15's rationale states, for every hyphen-joined chunk, whatever its length;
    - "not glued to a letter" excludes far more than the UEN and code cases it targets.
  - D15 drops D11's "identifiers may touch letters" for bank numbers, and neither AC-3 nor §8 lists that as an accepted gap.
  - The design's two statements of the rule also differ. §3.1 says a hyphen-joined chunk "holding 9–12 digits" stands alone; D15 says any hyphen-joined chunk does. The code follows D15.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | GOV-04 NRIC/FIN | `pii-corpus.json` `nric-*` (now incl. `nric-small-hyphen`), `checksums` | faithful | green; live route masks `S1234567D`; thin-space and ZWSP forms masked (unit probe) |
| AC-2 | GOV-04 cards | corpus `card-*` (now incl. `card-line-breaks`, `card-thin-space`, `card-zero-width`), `cardPrefixOk`, seeded random set | faithful | green; live route masks `4242 4242 4242 4242` |
| AC-3 | GOV-04 bank accounts | corpus `bank-*` (every example AC-3 names is present: `bank-dbs`, `bank-zh`, `bank-after`, `bank-then-date`, `bank-solid-then-qty`, the four `bank-spaced-*`, `neg-bank-uen`, `neg-bank-code`, `bank-phone-cc`, `bank-no-keyword`) | faithful for its named examples; **the general clause fails for mixed-separator and glued numbers under D15 (DD-3)**. No failing test committed; the cases are listed under DD-3 for the amendment | green on the corpus; `DBS 123 456789-0` and `DBS acct1234567890` stored raw (live route + `messages` row) |
| AC-4 | GOV-04 ordinary text; idempotence | corpus `neg-*`, idempotence over every case and 2000 seeded random inputs | faithful | green; my ~90 extra probes are all idempotent |
| AC-5 | database | `apps/api/test/widget-pii.int.test.ts` | faithful | green (api 12/12) |
| AC-6 | LLM payload | `agent/test/turn.int.test.ts`, `llm-gateway/src/mask.test.ts` | faithful | green (agent 11/11) |
| AC-7 | logs | `platform/src/logger.test.ts`, `maskLogText` tests incl. new 128 000-char one-pass phone test | faithful | green; dev log has 0 raw hits for this run's probes |
| AC-8 | audit IDs | `governance/src/payload.test.ts` | faithful | green (governance 19 integration) |
| AC-9 | UC-20 step 4, SCR-WGT-002 | `e2e/tests/pii-mask.e2e.ts` | faithful | green (chromium 5/5) |
| AC-10 | NFR-01, NFR-05 | `pii-mask.test.ts` performance (CPU time, best of five) and `maskLogText` performance | faithful | green; my CPU-time probes: worst 4000-char input 5.4 ms (`bank\n` + `1\n`×), `maskLogText` 256 000 chars of phones 67 ms (linear; was 4.4 s) |

## Corrected tests

None. The corpus additions in `ce5bbe8` are additions only, with no deletions, skips or loosened assertions. Every example AC-3 names is pinned. I did not commit the DD-3 cases as failing tests, because they encode behaviour the design has yet to choose. They are listed below for the amendment.

## Independent execution

All runs are mine, at `ce5bbe8`, with turbo `--force` (0 cached), on this 4-core container. Logs are in `/tmp/claude-0/rv3/`.

| Check | Command | Result |
| :- | :- | :- |
| Format | `pnpm format:check` | pass |
| Lint + boundaries | `pnpm turbo run lint --force`; `pnpm lint` | 24/24; no dependency violations (205 modules) |
| Typecheck | `pnpm turbo run typecheck --force` | 26/26 |
| Unit | `pnpm turbo run test --force` | 21/21 tasks; platform 220 |
| Integration | `pnpm turbo run test:integration --force --concurrency=1` | 14/14: db 40, platform 4, governance 19, inbox 5, kb 9, api 12, agent 11 |
| Coverage | `pnpm test:coverage --concurrency=2 --force` | 15/15; `src/pii-mask.ts` 100% lines, 97.9% branches |
| Build / size | `pnpm turbo run build --force`; `pnpm size` | 9/9; loader 1.75 kB, panel 9.34 kB, initial 1.75 kB gz |
| Eval | `pnpm eval --fast` | 52 cases; groundedness 8/8, prices 44/44 |
| E2E | `E2E_REUSE_SERVERS=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e --project=chromium` against the `pnpm dev` started after `ce5bbe8` | 5/5 |

**Server freshness:** checked before relying on the running server. Through it, `DBS 123 456789 0` comes back as `DBS [BANK ••••7890]` (D15 behaviour; D12 gave `••••6789] 0`). The live route therefore serves the HEAD masker.

**Anti-fake-green review** (`git show ce5bbe8` on test files): there are 13 new corpus cases and one new timing test. Nothing was removed or skipped, and no coverage configuration changed. Migrations: none in this feature.

## Direct verification

- **Live widget route** (`/tmp/claude-0/rv3/live.sh`):

  | Message sent | Stored as |
  | :- | :- |
  | `DBS 123 456789 0` | `DBS [BANK ••••7890]` |
  | `UOB 123 456 789 0 and OCBC 501 234567 001` | both masked whole |
  | `card 4242 4242 4242 4242 IC S1234567D` | both masked |
  | `DBS 123 456789-0` | **unchanged, raw** in `messages.body` |
  | `DBS acct1234567890` | **unchanged, raw** in `messages.body` |

- **Regression comparison against the D12 masker** (`/tmp/claude-0/rv3/cmp.ts`, which compares D12 at `ad8bbd9` with D15 at HEAD; also `/tmp/claude-0/rv3/p.ts`, about 70 probes). See DD-3 for the leaks. The other probe results:
  - **Solid numbers followed by more numbers:** a solid or hyphenated number followed by a quantity, date, phone number or `24 10 2026` stays whole and correct.
  - **Card and NRIC interactions:** a card or NRIC next to a bank number in the same run gives both tokens correctly.
  - **UEN, invoice and promo codes:** `201912345K`, `INV-2026-10-0001`, `GF-123-456-789` and `123456789A` are now unchanged (M3 closed).
  - **Fold variants:** NBSP, `\n`, ZWSP, soft hyphen and full-width bank, card and NRIC forms are all masked.
- **AC-10 / NFR-05** (`/tmp/claude-0/rv3/t.ts`, CPU time, best of five, with other work running):
  - `piiMask` on 10 adversarial 4000-character inputs (spaced digits, newline-separated digits, ZWSP, mixed `123-4 ` runs, many banks, cards and banks interleaved, a keyword per chunk, NRIC chains, glued runs) takes at most 5.4 ms.
  - `maskLogText` takes at most 3 ms at 16 000 characters. With 256 000 characters of phone numbers it takes 67 ms, which is linear growth (M4 closed).
- **Pending environment:** none.

## Findings

### Rework
None. The code implements D15 as D15 states it.

### Design defect
- **DD-3: D15 stores some keyword-adjacent bank numbers completely raw, numbers D12 masked (GOV-04 "mask … bank accounts"; AC-3 general clause; D11).**
  - **What the sources require:** AC-3 (technical-design.md:121): "A 9-to-12-digit number with a keyword within 40 characters … becomes `[BANK ••••<last 4>]`". D10 makes "a hyphen with an optional space" and "one or two spaces" equally valid separators. D11 lets identifiers touch letters.
  - **What the design says:** D15 (technical-design.md:145): "a chunk of 9 or more digits, or one joined with hyphens, is now a number on its own", and a window "glued to a letter … is a UEN, invoice or promo code". The code follows this at `packages/platform/src/pii-mask.ts`: `banksIn` marks every hyphen-merged chunk `whole: true`, and `gluedToWord` rejects any adjacent letter.
  - **Observed** (unit; the first and fifth rows were also stored raw through the live route):

    | Input | D15 (now) | D12 (before) |
    | :- | :- | :- |
    | `DBS 123 456789-0` | unchanged | `DBS [BANK ••••7890]` |
    | `UOB 123-456 789-0` | unchanged | `UOB [BANK ••••7890]` |
    | `POSB 123-45678 9` | unchanged | `POSB [BANK ••••6789]` |
    | `acct 1234-5678 90` / `acct 1234 5678-90` | unchanged | masked whole |
    | `DBS acct1234567890` | unchanged | `DBS acct[BANK ••••7890]` |
    | `DBS 1234567890pls`, `my acct no is 1234567890ok` | unchanged | masked |
    | `DBS 123-456789 0`, `OCBC 501-234567 001` | `[BANK ••••6789] 0`, `[BANK ••••4567] 001` (DD-2's symptom: the last group raw, the wrong last four) | same |

  - **Effect:** the whole account number is stored and sent to the model in clear, for formats that are less common than the pure space or pure hyphen ones but plausible in typed chat. NRIC and card masking are unaffected.
  - **Suggested amendment, for detailed-design to decide.** I tried two changes on a scratch copy (`/tmp/claude-0/rv3/proto.ts`; production code untouched). Together they pass all 99 corpus cases, including `neg-bank-uen`, `neg-bank-code`, `neg-bank-invoice` and `bank-solid-then-qty`, and mask every row above whole except the last.
    1. A hyphen-joined chunk stands alone only when it holds 9 or more digits. A shorter one joins neighbouring chunks as a group, as §3.1's wording already suggests.
    2. "Glued to a letter" means only a single trailing letter (the UEN shape) or a letter-hyphen prefix (`GF-`, `INV-`). A window glued to a bank keyword (`acct1234567890`) or followed by a word (`…pls`) is still a bank number.

    The last row (`123-456789 0`, a complete 9-digit hyphenated number followed by one spaced digit) needs a decision: join a trailing 1–3-digit chunk while the total stays ≤ 12, or list it as an accepted gap in §8. Add the table's inputs as corpus positives, and reconcile the §3.1 bank row with D15's wording.

### Minor
- **M9: no accepted-gap note for glued bank numbers.** Whatever DD-3's amendment keeps excluded (for example `1234567890pls`) should be listed in §8 next to the D13 and over-masking gaps.
- **M10: D15's accepted cost also corrupts the token and the visitor's text.** `DBS 123 456 7890 2 pcs` becomes `DBS [BANK ••••8902] pcs`. D12 gave `[BANK ••••7890] 2 pcs`. The quantity disappears from the stored message, and the token names the wrong last four (D5's purpose). D15 says this "masks more, never less", which is true, but it doesn't mention the lost quantity or the wrong token. Worth stating in §8, or avoiding by preferring a window that ends at a 3–4-digit chunk.
- **M11: over-masking of times and dates next to keywords.** `DBS 10:30 24 10 2026` becomes `DBS 10:[BANK ••••2026]`, and `65 9123 4567 account` (no `+`) is masked as a bank number. This is the same class as §8's accepted over-masking; noted for the pilot review.
- M2 (D13 prefixes) and M5 (D7 object fields) from earlier rounds: unchanged, by design.

### Prior findings
- DD-1: closed (round 2).
- DD-2: **closed**.
- M1 (unfolded spaces and line breaks): **closed**.
- M3 (UEN and code over-masking): **closed**.
- M4 (quadratic phone replacement): **closed**.
- M7 (task count): **closed**. T9 now says 79, T12 says 99, and the corpus has 99.
- M6 and M8 (test corrections, stale server): stand as process notes. The server used in this round was confirmed fresh.

## RTM

Not written. The verdict is design defect, so GOV-04's Test ref stays `_TBD_`.

## Routing

DD-3 goes to detailed-design's amendment path for FEAT-003: D15, the §3.1 bank row, AC-3's examples and §8's accepted gaps. Fold M9 and M10 into the same amendment. After that comes feature-implementation, then a fresh acceptance run.
