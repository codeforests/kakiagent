# Acceptance Report: FEAT-022 — Grounded, verified answer from a hand-entered fact

> Current verdict: **Design defect** (re-verification 1, at `d9befc0`; see the last section) · Date: 2026-10-19
> Initial verdict: Rework, at `44bc8c2` (kept below as recorded)
> Standard: technical-design.md §6 (AC-1..AC-16) and §5 (verifier spec) @ `44bc8c2` · Sources: SRS.md v0.4 (AGT-01, AGT-02, AGT-06, AGT-11, AGT-16, CHN-02, KB-07, KB-15, NFR-01, NFR-04, NFR-10), use-cases.md v0.4 (UC-20, UC-13)
> Repo state audited: `44bc8c2` on `claude/project-thread-91q4ac` (clean tree)

## Verdict summary

The feature is well built and nearly every criterion holds: every suite I ran myself is green, the RLS and grant isolation (AC-6, AC-7) is tested properly, and the E2E journey (AC-16) passes. The one blocking finding is in the deterministic verifier, the component that carries AGT-02 ("zero invented prices; no unverified price … is ever displayed"). It lets model-typed prices through to the visitor in forms that technical-design §5 says it must block. The clearest case: design §5 lists `for` as a price word, the code leaves it out, and "The fudge cake goes for 50." was released to the visitor with outcome `answered`. The AC-3 values all hold as written, but AGT-02 fails when checked directly. The feature goes back to feature-implementation for findings R1–R4. Nothing was appended to the RTM.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | AGT-02; UC-20 6 | `render-verify.test.ts` "renders a price slot…"; `compose.test.ts` "releases verified sentences…"; eval `prices` subset (17 cases) | faithful | green; eval prices 17/17. Real-model check pending (M1.5) |
| AC-2 | AGT-02, CHN-02; UC-20 6a | `compose.test.ts` "blocks a literal price, regenerates…" and "escalates after two failed attempts…"; `turn.int.test.ts` "blocks a literal wrong price twice, escalates, and audits the guardrail" | faithful (see minor M1 on "stored outcome") | green |
| AC-3 | AGT-02 | `render-verify.test.ts` "verifier (AC-3)" (20 blocked forms, slot pass, D3 visitor quantity) | faithful to the AC's listed values; the AC does not cover the design's full pattern list (M2) | green, **but direct verification of AGT-02 and design §5 fails: R1–R4** |
| AC-4 | AGT-01 | `turn.int.test.ts` "answers from approved facts only…" (exact `fact_ids`); eval `groundedness` subset + `cites` scorer | faithful | green; groundedness 8/8; live dev DB: the last 3 agent messages' `fact_ids` ⊆ that tenant's approved facts. Real-model check pending (M1.5) |
| AC-5 | AGT-01; UC-20 5a | `compose.test.ts` "says it will check when no facts were retrieved"; `facts.int.test.ts` (kb) "returns nothing for an unrelated question"; eval `ground-no-fact` | faithful | green |
| AC-6 | AGT-16, GOV-03 | `rls.int.test.ts` "facts and the visitor views" (9 cases: permission denied on 4 base tables, every excluded status, expired, GST-unknown per registration, cross-tenant with a hand-written `where tenant_id`, no context, stale chunk version) | faithful | green (db 23/23) |
| AC-7 | AGT-16 | `turn.int.test.ts` "answers from approved facts only…" (`needs_review` S$70 and tenant B S$99 facts seeded as best matches) | faithful | green |
| AC-8 | AGT-11 | `turn.int.test.ts` "answers from approved facts only…", "discloses only on the first reply…", kill-switch case (disclosure on the system fallback); `facts.e2e.ts` `.disc` row | faithful | green; live dev DB: disclosure set on first replies |
| AC-9 | KB-07; UC-13 3 | `turn.int.test.ts` "uses an edited price on the very next turn, and drops a disabled fact"; kb `facts.int.test.ts` "never returns a disabled fact, and returns an edited one at once" | faithful (the disabled case in turn.int checks only `fact_ids`; the kb test checks retrieval directly) | green |
| AC-10 | KB-15, NFR-10; UC-20 6b | `render-verify.test.ts` "quotes an exclusive price GST-inclusive…", "formats SGD…"; `rls.int.test.ts` GST-unknown case; eval `prices-gst-exclusive` | faithful | green |
| AC-11 | KB-07; UC-13 1–3 | `apps/api/test/facts.int.test.ts` (11 cases: 201 + version/chunk/audit rows, 4× 400, 409 version_conflict, 409 invalid_state, 403 agent, 401, 404 cross-tenant, filters) | faithful (minor M3) | green (api 11/11) |
| AC-12 | NFR-01 | worker log line `turn complete {outcome, firstSegmentMs, totalMs}` | faithful (not gated) | observed in `/tmp/claude-0/stack/dev.log` on my E2E run: firstSegmentMs 4–5, totalMs 7–8 (fake provider, local). Real latency pending (MD) |
| AC-13 | NFR-04; UC-20 5d | `turn.int.test.ts` "stores the fallback as the reply when the model call fails" (system author, `inReplyTo`, `agent.fallback_sent`, redelivery returns null); `compose.test.ts` provider-error case | faithful | green |
| AC-14 | ADR-013 d3; UC-20 5e | `turn.int.test.ts` kill-switch (0 model calls, fallback), human status (null, 0 calls), "stops between segments when the kill switch is pressed mid-reply"; `compose.test.ts` gate case | faithful | green |
| AC-15 | AGT-14 | `pnpm eval --fast` (25 cases, adversarial recordings: literal prices, wrong ref, other-tenant ref, injection echo, visitor amount, %, number words, Chinese amount, bare number, pre-GST) | faithful to the AC as written. The `prices-from-facts` scorer only matches `S$` amounts, so it cannot see the R1–R4 leaks | green: prices 17/17, groundedness 8/8. Real-model run pending (M1.5) |
| AC-16 | UC-20 main, UC-13, J2 | `e2e/tests/facts.e2e.ts` | faithful (minor M4) | green, Chromium |

## Corrected tests

None. The tests that exist assert what their criteria say. The verifier gap is a code defect against design §5 and AGT-02, not a weak test. The failing evidence is recorded below and not committed as tests, so the branch stays green. The tests belong to the rework.

## Independent execution

All runs were made by this audit at `44bc8c2`, with turbo `--force` so no cached result was replayed:

| Check | Command | Result |
| :- | :- | :- |
| Format | `pnpm format:check` | pass |
| Lint + boundaries | `pnpm lint`; `pnpm turbo run lint --force` | 24/24 tasks; depcruise: no violations (183 modules) |
| Typecheck | `pnpm turbo run typecheck --force` | 26/26 |
| Unit | `pnpm turbo run test --force` | 21/21 tasks (agent 46, llm-gateway 12, platform 7, widget 6, realtime 2, identity 2, channels 2, design-tokens) |
| Integration | `KAKI_TEST_DATABASE_URL=… pnpm turbo run test:integration --force --concurrency=1` | db 23, agent 10, api 11, kb 9, inbox 5, platform 4, governance 1: all pass |
| Coverage gate | same env, `pnpm turbo run test:coverage --force --concurrency=1` | 15/15 tasks; thresholds met (agent 98.39% lines, kb 98.48%, inbox 78.94%) |
| Build | `pnpm turbo run build --force` | 9/9 |
| Size | `pnpm size` | loader 1.75 kB gz (limit 14 kB); panel 9.34 kB gz (limit 35 kB); initial 1.75 kB (limit 30 kB) |
| Eval | `pnpm eval --fast` | 25 cases; groundedness 8/8 (≥0.95), prices 17/17 (=1.0); exit 0 |
| E2E | `cd e2e && E2E_REUSE_SERVERS=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npx playwright test --project=chromium` | 4/4 pass (facts AC-16 4.5 s; skeleton 3) |

- **Migrations on a fresh store:** every integration suite creates a fresh database and runs the real setup (roles, 0000–0003, RLS, seeds) through `startTestDatabase`. All passed. The migrator is forward-only, so there is no down migration (design §4).
- **Environment caveats:** there is no Docker in this container. Integration tests ran against a local Postgres 16 + pgvector through `KAKI_TEST_DATABASE_URL`, and E2E reused the `pnpm dev` servers already running (tsx watch and vite serving the working tree, which is clean at HEAD) with ElasticMQ standing in for SQS. This departs from the skill's cold-start rule, at the coordinator's direction. CI runs the compose stack.
- **Flakiness:** none observed.
- **Test-diff review (`c8be4cc..44bc8c2`):** no `.skip`, `.only` or `.todo` added. No coverage threshold, scope or exclusion changed, and no `vitest.config.*` was touched. Two pre-existing tests changed, both with a declared rationale:
  - The FEAT-001 "stores nothing when the model call fails" test was replaced by the AC-13 fallback test, per design D6. Accepted: the requirement (NFR-04) drives it, and it is recorded in the design.
  - `skeleton.e2e.ts` no longer matches the echo text. It matches the agent reply by author and checks that the inbox row count grows. Accepted: the echo is gone by design, and the test still crosses every role and checks the live inbox.
  - `api.test.ts` and `identity.test.ts` only gained fields and assertions.

## Direct verification

- **AGT-02 / design §5 verifier, probed directly** (scratch scripts outside the repo: `verifySegment` with visitor text "how much ah", then `composeReply` with the fake provider scripted to return the same output on both attempts):

  | Model output | Verifier | `composeReply` outcome, published segments |
  | :- | :- | :- |
  | `The fudge cake goes for 50.` | pass | `answered`, `["The fudge cake goes for 50."]` |
  | `Price: 50.` | pass | `answered`, `["Price: 50."]` |
  | `It is around 50 Singapore dollars.` | pass | `answered`, published as is |
  | `It is S$  50.` (two spaces) | pass | `answered`, published as is |
  | `It costs fifty-five.` | pass | `answered`, published as is |
  | `It is USD 50.`, `It is €50.`, `It is ５０元.`, `It is S＄50.` | pass | (not run through compose) |
  | Controls: `S$ 50`, `$55`, `55 SGD`, `We charge 55.`, `Costs 55 lah.`, `fifty dollars`, `2-3 days`, `12 October`, `3 pm`, `10 percent`, `refunds`, `Delivered by Friday` | block | — |

  Each passing case is a model-typed price shown to the visitor as an approved answer, which breaks AGT-02's "zero invented prices". The eval cannot catch them because `prices-from-facts` matches only `S$<amount>`.
- **AGT-01 / AGT-11 side effects in the live dev database:** the three most recent agent messages have `fact_ids` that are a subset of that tenant's approved facts, and the first replies carry a non-empty `disclosure`.
- **AGT-06 (p):** the `tool.lookup_kb` audit entry is asserted in `turn.int.test.ts`.
- **NFR-01:** indicative only (fake provider, local machine): firstSegmentMs 4–5 ms, totalMs 7–8 ms.
- **Contracts:** the routes and error codes match §3.2. The `segment` SSE frame has no `id:` line (`sse.test.ts`). `factIds` is not on the wire (D9).
- **Screens:** SCR-WGT-002 has the typing indicator, the 30 s slow notice (`SLOW_REPLY_MS`), the disclosure row and segment replacement. Widget CSS uses only `--kaki-*` colour variables. In the dashboard, the CSS added for SCR-APP-027/028 uses token variables for colours. The E2E axe scans found no serious or critical issues.
- **Pending environment:**
  - AC-1, AC-4 and AC-15 on the real model (M1.5).
  - NFR-01 real latency (MD).
  - Retrieval-quality tuning on Cohere (MD, design §8).

## Findings

### Rework (blocking)

Each finding is a model-typed price that the verifier passes to the visitor. Evidence is in the table above, and each needs a failing unit test added to `render-verify.test.ts` (and ideally an eval recording) before the fix.

- **R1 — Price word `for` missing.** Design §5 lists the price words "price, cost, costs, priced, only, just, at, for". `packages/agent/src/verify.ts`'s `price_number` pattern has `prices?|priced|costs?|charges?|fees?|only|just|at`, with no `for`. "The fudge cake goes for 50." is released with outcome `answered`.
- **R2 — Price word followed by punctuation.** "Price: 50." and "Price - 55." pass because the pattern needs whitespace straight after the price word. This is the design's "bare numbers after price words" in the most common label form.
- **R3 — Words between the number and the currency word.** "50 Singapore dollars" and "50 sing dollars" pass. `NUM\s?(dollars|…)` allows nothing between them, although design §5 names `dollars` as a currency marker.
- **R4 — Whitespace after `S$` / `$`.** "S$  50" (two or more spaces) passes because `\s?` allows only one.

### Design defect

None blocking. For detailed-design to consider at its next amendment (M2 below):
- Foreign currency codes and symbols (`USD 50`, `€50`, `£50`, `RM50`).
- Full-width digits and `＄` (`５０元`, `S＄50`).
- Number words after a price word (`costs fifty-five`).

The visitor is in Singapore, and a mixed-script model reply is plausible.

### Minor (non-blocking)

- **M1.** AC-2 says "the stored message has outcome `escalated`", but §4 adds no outcome column to `messages`. The outcome is on the turn result and in the `guardrail.escalated` audit entry, which is what the test checks. The AC wording should be fixed at the next design revision.
- **M2.** AC-3 lists only part of §5's pattern catalogue, so a green AC-3 did not protect the rest. The rework should add the R1–R4 forms, and ideally one case per §5 pattern family. The eval's `prices-from-facts` scorer should also flag any bare amount, not only `S$`.
- **M3.** `facts.int.test.ts` (api) checks `?status=disabled` with `every(...)`, which also passes on an empty list. It relies on an earlier test's disabled fact. It would be stronger to assert a known disabled ID is present and an approved one absent.
- **M4.** `facts.e2e.ts` creates new facts on every run against the persistent dev database, so the bakery now holds three "Eggless chocolate cake" and four "Pandan chiffon cake" approved facts, and replies repeat sentences ("…is S$55.00. …is S$55.00."). The assertion still holds, but the run is not isolated.

## RTM

Not written. Verdict: rework. The Test ref append for AGT-01, AGT-02, AGT-06, AGT-11, AGT-16, CHN-02, KB-07, KB-15, NFR-01, NFR-04 and NFR-10 waits for an accepted re-verification. That append will carry `(partial)` on every row, because each is a partial touchpoint or still has real-model or environment checks pending.

---

## Re-verification 1 — 2026-10-19 · Verdict: **Design defect** (with two rework findings)

> Repo state audited: `d9befc0` (rework for R1–R4) · Standard: technical-design.md §6, and §5 as amended in `d9befc0`, re-derived against ADR-008 decision 2 and AGT-02

### Summary

R1–R4 are fixed, and so are the earlier gaps (other currencies, full-width forms, price-word number words). Every suite is green again.

Probing further turned up model-typed prices that still reach the visitor as `answered`. They fall into two classes:
- **The standard itself is too narrow.** Amended §5 lists the exact gap words allowed between a price word and its number, and it only looks *after* price words. ADR-008 decision 2 says "bare numbers next to price or stock words", and AGT-02 says "zero invented prices".
- **The pipeline verifies one segment at a time, while the segmenter can cut a protected value across two segments.** The clearest case is "S$\n50", which goes out as `["S$", "50"]`.

A code patch against today's §5 cannot close either class, so the verdict is **design defect**. It routes to detailed-design's amendment path for the §5 verifier and segmenter rules. Two smaller code findings (R5, R6) go back to implementation alongside it. The RTM is not written.

### What changed, and the test diff

- `verify.ts` gained:
  - currency codes and signs, with any spacing;
  - an optional "Singapore" before the currency word;
  - NFKC normalisation;
  - `for` and a `PRICE_GAP` (`:`, `-`, `=`, dashes, and the words is/are/of/about/around/roughly/approximately/only/just) after price words, with a `QUANTITY` exception ("for 2 to 3 people");
  - price-word number words.
  
  A number after a price word no longer counts as a visitor quantity.
- `render-verify.test.ts` gained 11 blocked forms, 1 pass form and 1 D3 case. Nothing was removed or loosened.
- The eval set gained 6 recordings (25 → 31 fast cases). No case was removed (the JSON diff has no `-` lines).
- The eval scorer's `AMOUNT_RE` now matches any currency, and the text is NFKC-normalised first. This is stricter.
- §5 of technical-design.md was amended in place. The change is declared in tasks.md "Implementation notes", and it is the standard this run audits against.

### Independent execution (at `d9befc0`)

| Check | Result |
| :- | :- |
| `pnpm format:check` | pass |
| `pnpm turbo run lint --force` + `pnpm boundaries` | 24/24; no dependency violations |
| `pnpm turbo run typecheck --force` | 26/26 |
| `pnpm turbo run test --force` | 21/21 (agent 57 unit tests) |
| `pnpm turbo run test:coverage --force --concurrency=1` (unit + integration, `KAKI_TEST_DATABASE_URL`) | 15/15; agent 98.43% lines, kb 98.48% |
| `pnpm eval --fast` | 31 cases; prices 23/23, groundedness 8/8; exit 0 |
| E2E (Chromium, `E2E_REUSE_SERVERS=true`) | 4/4 |

### Direct verification of the verifier

**R1–R4 and the earlier gaps are now blocked.** That covers:
- "goes for 50", "for 50", "Price: 50", "Price - 55", "Price — 50", "Price=50", "Price: fifty";
- "50 Singapore dollars", "50 sing dollars", "S$  50", "$   50";
- "USD 50", "€50", "£50", "RM50", "RM 50", "50 ringgit", "５０元", "S＄50";
- "costs fifty-five", "price is fifty five", "costs only 50", "costs roughly 50".

**Still released to the visitor.** Each row below was run through `composeReply` with the fake provider scripted to return the same output on both attempts. The outcome was `answered` every time:

| Model output | Published segments | Class |
| :- | :- | :- |
| `S$\n50` | `["S$", "50"]` (the widget shows "S$ 50") | DD2 |
| `Price (S$):\n50` | `["Price (S$):", "50"]` | DD2 |
| `Chocolate fudge cake\nPrice: \n50` | `["Chocolate fudge cake", "Price:", "50"]` | DD2 |
| `It costs approx. 50.` | `["It costs approx.", "50."]` (the abbreviation's full stop ends the segment) | DD2 / DD1 |
| `Prices start from 50.` | `["Prices start from 50."]` | DD1 |
| `The price would be about 50.` | released whole | DD1 |
| `It is 55 each.` | released whole | DD1 |
| `It is [[f:…price]]0.` | `["It is S$55.000."]` | R5 |
| `It is 50$.` | released whole | R6 |
| `It is [[f:…price]], or 50 for members.` | `["It is S$55.00, or 50 for members."]` | DD1 |

`verifySegment` alone also passes these:
- **After a price word:** "costs ~50", "costs approx 50", "costs abt 50", "costs ard 50", "costs like 50", "costs below 50", "costs up to 50", "costs from 50", "Priced from 50", "costs < 50", "Price range 50 to 60", "Price range: 50 to 60", "costs between 50 and 60", "costs, um, 50", "The cost would be 50", "The price will be 50", "The fee would be 50", "Pricing: 50", "Price list: cake 50", "Prices are from 50 onwards".
- **Price word after the number:** "55 each", "55 per kg".
- **Currency sign after the amount:** "50 S$", "50$".
- **Bare amounts with no price word:** "The cake is 55.", "That will be 55.", "Members pay 50.", "It is 55.00.", "Usually 60.", "Around 50 lah.", "Was 60, now S$55.00".

**False positives.** These block a harmless reply, which leads to a regeneration or escalation; it fails safe. Probed:
- "Thanks for 2 orders!", "A table for 4." (`for N` not followed by a listed quantity noun);
- "Only 2 flavours left." (`only N`);
- "It costs maybe 50." is reported as a `date` because the month pattern matches "may" in "maybe". It is blocked for the wrong reason, and the same pattern will also block e.g. "maybe 3 of them".

The other 26 ordinary sentences probed passed, including "good for 2 to 3 people", "for 10 guests", "for 8 pax" and "for 1 kg or 2 kg".

### Findings

**Design defect (blocking), routed to detailed-design's amendment path for technical-design §5:**
- **DD1 — The price-word rule is an enumerated list, narrower than its sources.** ADR-008 decision 2 requires catching "bare numbers next to price or stock words" (either side) and "currency amounts in any form". AGT-02 requires "zero invented prices". Amended §5 encodes only "after price words … after `:`, `-` or is/about/around", so every gap word not on the list gets through:
  - approx, ~, abt, ard, like, from, below, up to, between, "would be", "will be", "start from";
  - a price word *after* the number ("each", "per kg");
  - currency-adjacent bare amounts.
  
  The amendment should replace the gap list with a proximity rule. One option: any number in the same clause within a few tokens after price, cost, fee, charge, priced, pricing, "for", or before each, per <unit>, or "/-", unless it is followed by a quantity noun. It should also decide explicitly how far bare amounts with no price word ("It is 55.00.", "Members pay 50.") are in scope. Two decimals is a cheap, strong signal.
- **DD2 — Verification is per segment, but a protected value can be split across segments.** The segmenter cuts at line breaks, at `.` + whitespace (abbreviations such as "approx.") and at 160 characters. The verifier sees each part alone, so "S$" | "50" and "Price:" | "50" both pass. ADR-008 decision 4's segmenter and decision 2's verifier have to be specified together. Options:
  - verify each segment with the released prefix's tail as context;
  - or never end a segment directly after a currency sign, a price word or a trailing `:`.

**Rework (code, within the design as written):**
- **R5 — A digit glued to a slot rendering forms a new price.** `[[f:…price]]0` renders "S$55.000" and passes. Masking spans with the empty string makes the trailing "0" look like a lone digit. A digit or decimal point touching a protected span should fail (or the mask should be a non-digit sentinel that the patterns treat as part of the amount).
- **R6 — Currency sign after the amount.** "50$" and "50 S$" pass. §5 now says "currency (`S$`, `$`, … any spacing)", but only the sign-first order is matched.

**Minor:**
- **M5.** The month pattern matches "maybe" → false `date` violation (`MONTH` = `may[a-z]*`). Constrain it to month spellings.
- **M6.** "Thanks for 2 orders", "A table for 4" and "Only 2 flavours left" are blocked. These are tolerable while the verifier fails safe, but the eval should track naturalness at M1.5.
- M1–M4 from the first run still stand.

### RTM

Not written. Verdict: design defect. When a later re-verification is accepted, Test ref `features/FEAT-022-grounded-verified-answer/acceptance-report.md (partial)` goes on AGT-01, AGT-02, AGT-06, AGT-11, AGT-16, CHN-02, KB-07, KB-15, NFR-01, NFR-04 and NFR-10. All are partial: they are partial touchpoints, and the real-model checks for AC-1, AC-4, AC-15 and AC-12 latency are still pending.
