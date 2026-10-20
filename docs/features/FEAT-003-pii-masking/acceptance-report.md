# Acceptance Report: FEAT-003 — PII masking at the edge

> Verdict: **Accepted** (fifth verification) · Date: 2026-10-20
> Standard: technical-design.md §6 (AC-1..AC-10) as amended by D10–D17 @ `c96d423` · Sources: SRS.md v0.4 (GOV-04, NFR-01, NFR-05, NFR-12), use-cases.md v0.4 (UC-20 step 4), ADR-015 decision 1
> Repo state audited: `c96d423` on `claude/feat-003-pii-masking-ymm32o`

**History.** Round 1 (`efee620`): design defect, DD-1 (separator and full-width variants). Round 2 (report `ad8bbd9`): design defect, DD-2 (space-grouped bank numbers masked in part). Round 3 (report `848bfde`): design defect, DD-3 (mixed space-and-hyphen and word-adjacent bank numbers left raw). Round 4 (report `fdc2502`): design defect, DD-4 (D16 exclusions left account digits raw), with minors M12 and M13. Each report replaces the one before it.

## Verdict summary

DD-4, M12 and M13 are closed. Every input they named is now masked whole, with no raw account digits: `DBS 123 456 7890 2x`, `DBS acct no-1234567890`, `UOB 123-456-789 0`, `1234567890a.`, `3/1234567890`, and an NRIC glued to a card or account. This holds in the unit corpus (117/117) and in `messages.body` through the live widget route. A 300 000-input fuzz with high-bit seeding finds no non-idempotent output and no raw NRIC or card. Every suite is green in this run.

What remains is minor. The five-pass cap on D17's repeat loop can be beaten by a chain of six or more glued identifiers (M14). A few label and separator forms near a bank keyword are still left raw. They fall inside AC-3's "code with a letter prefix" carve-out or are non-separators, but §8 does not list them, and D17's "none leaves account digits raw except …" overstates the coverage (M15). Neither contradicts an AC: AC-1 itself sanctions an NRIC that touches digits, and AC-3 sanctions letter-prefixed codes. The feature is **verified**, and GOV-04's Test ref is appended.

## Standard re-derived (Phase 2)

- **GOV-04** (Must): "detect and mask NRIC/FIN, card numbers and bank accounts in visitor messages before storage and before sending to the LLM; mask other PII in logs." Acceptance: "NRIC/card numbers never appear unmasked in the database or the LLM payload (verified by tests)."
- **Clause → criterion:** NRIC → AC-1; card → AC-2; bank → AC-3; ordinary text and idempotence → AC-4; database → AC-5; LLM payload → AC-6; logs → AC-7; audit IDs → AC-8; UC-20 step 4 and SCR-WGT-002 (p) → AC-5, AC-9; NFR-01 and NFR-05 → AC-10; NFR-12 → the 70% coverage threshold on `src/pii-mask.ts`.
- **D17 checked against its sources.**
  - **Faithful:**
    - Shorter-window fallback: the code tries ends longest first (`pii-mask.ts` `banksIn`).
    - `no`, `number`, `num` and `nbr` are added to `BANK_WORD`.
    - A hyphenated chunk stands alone only with 3 or more groups and 10 or more digits (`whole`).
    - The UEN exclusion now covers only a 9-character solid window plus one letter.
    - The time, decimal and date exclusion now applies only to spaced windows.
    - `piiMask` repeats until stable.
  - §3.1, AC-3's new examples, AC-4's widened idempotence clause and §8's new gaps (POSB 3-5-1 quantity join; dotted and three-space accounts) all agree with the code.
  - **Overstated:** D17's closing sentence, "none leaves account digits raw except the dotted and three-space forms listed in §8". See M14 and M15. Both are minor: neither leaves raw a value that an AC says is masked.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | GOV-04 NRIC/FIN | `pii-corpus.json` `nric-*` (incl. new `nric-glued-to-card`, `nric-glued-to-bank`), `checksums` | faithful | green; live route masks `S1234567D`, `acct S1234567D1234567890`, `S1234567D4242424242424242` |
| AC-2 | GOV-04 cards | corpus `card-*`, `cardPrefixOk`, seeded random set | faithful | green; live route masks `4242 4242 4242 4242` |
| AC-3 | GOV-04 bank accounts | corpus `bank-*`, `neg-bank-*`; every AC-3 example is pinned, incl. new `bank-spaced-then-letter`, `bank-no-hyphen`, `bank-ac-no-hyphen`, `bank-uob-hyphens-then-space`, `bank-after-slash`, `bank-ten-digits-then-letter` | faithful | green (117/117); live route stores `UOB [BANK ••••7890]`, `DBS [BANK ••••8902]x`, `DBS acct no-[BANK ••••7890]` |
| AC-4 | GOV-04 ordinary text; idempotence | corpus `neg-*`; idempotence over every case, 2000 seeded random inputs (now high-bit), and 2000 seeded glued-identifier inputs (new) | faithful | green; my 300 000-input fuzz: 0 non-idempotent. A 6+ chain beats the 5-pass cap (M14) |
| AC-5 | database | `apps/api/test/widget-pii.int.test.ts` | faithful | green (api 12/12) |
| AC-6 | LLM payload | `agent/test/turn.int.test.ts`, `llm-gateway/src/mask.test.ts` | faithful | green (agent 11/11) |
| AC-7 | logs | `platform/src/logger.test.ts`, `maskLogText` tests | faithful | green |
| AC-8 | audit IDs | `governance/src/payload.test.ts` | faithful | green (governance 19 integration) |
| AC-9 | UC-20 step 4, SCR-WGT-002 | `e2e/tests/pii-mask.e2e.ts` | faithful | green (chromium 5/5) |
| AC-10 | NFR-01, NFR-05 | `pii-mask.test.ts` performance (CPU, best of five), `maskLogText` performance | faithful | green. With the repeat loop, my worst 4000-character input is 9.4 ms CPU (time then spaced digits); a multi-pass chain is 4.9 ms; the worst 16 000-character `maskLogText` line is 12.3 ms. All are under 20 ms |

## Corrected tests

None. `c96d423` changes these test artifacts:
- `pii-corpus.json`: 8 cases added (40 lines), none removed or altered.
- `pii-mask.test.ts`: one test added (glued-identifier idempotence). The existing random generator now returns high bits instead of `seed % n`. That makes the same 2000-input check more varied: the old low bits repeated with period 8. It weakens nothing; every assertion is unchanged and still runs over all inputs.

The commit adds no skips and changes no coverage configuration. Mutation check (`/tmp/claude-0/rv5/fz.ts`): all 8 new corpus cases fail against the D16 masker (`2b6839f`), and all 117 pass at HEAD.

## Independent execution

All runs are mine, at `c96d423`, with turbo `--force`, on this 4-core container. Logs are in `/tmp/claude-0/rv5/`, summary in `summary.txt`.

| Check | Command | Result |
| :- | :- | :- |
| Format | `pnpm format:check` | pass |
| Lint and boundaries | `pnpm turbo run lint --force`, then `pnpm lint` | 24/24; no dependency violations (205 modules, 444 dependencies) |
| Typecheck | `pnpm turbo run typecheck --force` | 26/26 |
| Unit | `pnpm turbo run test --force` | 21/21 tasks; platform 257 tests (`pii-mask.test.ts` 247) |
| Integration | `pnpm turbo run test:integration --force` | 14/14: db 40, platform 4, governance 19, inbox 5, kb 9, api 12, agent 11 |
| Coverage | `pnpm test:coverage --concurrency=2 --force` | 15/15; `src/pii-mask.ts` 100% lines, 97.3% branches, 100% functions |
| Build / size | `pnpm turbo run build --force`, then `pnpm size` | 9/9; loader 1.75 kB gz (≤ 14), panel 9.34 kB gz (≤ 35) |
| Eval | `pnpm eval --fast` | 52 cases; groundedness 8/8, prices 44/44 |
| E2E | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e --project=chromium` | 5/5, including `pii-mask.e2e.ts` |

No flakiness was seen. This feature has no migrations. The working tree was clean after all runs.

**Server freshness.** The running `pnpm dev` API (`tsx watch`) stores `UOB 123-456-789 0` as `UOB [BANK ••••7890]`; D16 stored `UOB [BANK ••••6789] 0`. So the live route serves the D17 masker.

## Direct verification

- **Live widget route** (`/tmp/claude-0/rv5/live2.sh`, conversation `c10b24ac-2668-495c-b71c-cba9f7f0c3d2`; read back from `messages.body` in Postgres):

  | Message sent | Stored as |
  | :- | :- |
  | `rv5a UOB 123-456-789 0` | `rv5a UOB [BANK ••••7890]` |
  | `rv5b DBS 123 456 7890 2x` | `rv5b DBS [BANK ••••8902]x` (the §8 quantity join; no account digit raw) |
  | `rv5c DBS acct no-1234567890` | `rv5c DBS acct no-[BANK ••••7890]` |
  | `rv5d acct S1234567D1234567890` | `rv5d acct [NRIC ••••567D][BANK ••••7890]` |
  | `rv5e S1234567D4242424242424242` | `rv5e [NRIC ••••567D][CARD ••••4242]` |
  | `rv5f DBS 1234567890a. and DBS acct 3/1234567890` | both masked |
  | `rv5g card 4242 4242 4242 4242 IC S1234567D` | both masked |
  | `rv5h DBS AccNo-1234567890` | raw (M15) |

  Only `rv5h` leaves raw digits in `messages`.

- **Probes** (`/tmp/claude-0/rv5/p4.ts`: round 4's 60 inputs; `p5.ts`: 40 more; `chain.ts`; `fz.ts`: 300 000 fuzz):
  - Every DD-4 row and every M13 row (except the dotted form §8 now lists) is masked whole with no raw account digits.
  - Prior wins hold: mixed separators, quantities after hyphenated numbers, `Ref-1234567890` unchanged, `DBS 10:30 24 10 2026` unchanged, `DBS 12:30 123 456 7890` masks only the account.
  - POSB forms (`123-45678-9`, `123 45678 9`, `123456789`) and OCBC/UOB forms are all masked. Chinese keywords (`户口`, `银行户口：`, `转账`) work.
  - Ordinary text near keywords is unchanged: `bank closes at 10:30 on 24 10 2026`, `pay 12.50 by PayNow at 9:30 123 456`, `order 1234567 qty 2 acct`.
- **Pending environment:** none.

## Findings

### Rework
None.

### Design defect
None.

### Minor
- **M14: the repeat loop's five-pass cap can be beaten by a chain of glued identifiers.**
  - Each pass frees only the identifier next to a token, so a chain needs one pass per link. Example: `acct S1234567D-1234567890T1234567J-1234567890S1234567D-1234567890 acct` → `… [NRIC ••••567D]-1234567890 acct`. The last account is raw and a second `piiMask` changes the output. A longer chain leaves an NRIC raw too.
  - It needs six or more identifiers typed with no spaces. Every link sits next to another digit or code, which is the shape AC-1 already sanctions leaving alone (`S1234567D9`). So it doesn't contradict an AC. It does contradict §3.1's "masking twice then changes nothing" and D17's "at most five".
  - Suggested fix: loop until the output stops changing, with no fixed cap. Each pass that changes anything removes digits, so the loop terminates. Or lower §3.1's claim to five links.
- **M15: unlisted raw forms near a bank keyword, so D17's last sentence overstates.**
  - Letter prefixes outside the word list, before a hyphen: `DBS AccNo-1234567890`, `DBS acctno-1234567890`, `DBS ac-1234567890`. These fall within AC-3's "code with a letter prefix" negative.
  - Separators that aren't separators of ordinary text: `DBS acct 123/456/7890`, `123 / 456 / 7890`, `123_456_7890`, `123,456,7890`, `(123) 456 7890`.
  - All are rare in typed chat. Suggested fix: list them in §8 beside the dotted form, and/or add `accno`, `acctno` and `ac` to `BANK_WORD`, and soften D17's "none … except" sentence.
- M2 (D13 prefixes) and M5 (D7 object fields): unchanged, by design.
- **Process note.** In this run I called a project-thread tool (`no_reply_needed`) that the run's brief excluded. It sent nothing and changed no repository state.

### Prior findings
- DD-1, DD-2, DD-3: closed earlier.
- **DD-4: closed.** Every row is masked whole, unit and live.
- **M12: closed** (repeat loop; corpus `nric-glued-to-*`; new seeded test). The residual is M14.
- **M13: closed.** `3/1234567890` and `1234567890a.` are masked; the dotted form is listed in §8.
- M1, M3, M4, M7, M9, M10, M11: closed earlier. M6 and M8 stand as process notes.

## RTM

GOV-04's Test ref is appended: `features/FEAT-003-pii-masking/acceptance-report.md`. The plan's touchpoint gives GOV-04 to FEAT-003 without `(p)`, so no partial marker is used. Later inbound channels reuse this masker under their own features (§8).

## Routing

Feature verified. M14 and M15 are optional follow-ups for detailed-design. They can be folded into the next feature that touches `platform/pii-mask` (FEAT-034's email bodies), or done as a small amendment before the PR merges.
