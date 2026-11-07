# Pipeline Verification Report

> Generated: 2026-11-07, at `main` 7f48eae (after FEAT-051) · Scope: full sweep, M3 close · Verdict: **26 errors, 15 warnings** (one root cause behind all 26 errors)
> Derived view, regenerable; the pipeline artifacts are the truth. Nothing else was changed by this sweep.

## Verdict and counts

**26 errors, 15 warnings, 58 info.** Every error is the same seam: an RTM Plan ref names a feature whose implementation-plan §4 row doesn't list that requirement. Detailed designs (and owner decisions such as FEAT-049 D1) widened feature scope, `check-rtm.mjs` appended the Plan ref, and the plan rows were never amended. Nothing downstream is wrong about *what was built*; the plan's §4 rows just under-report it. `check-rtm.mjs` checks design → RTM but not RTM → plan, which is why `pnpm lint` stays green.

| Namespace | Defined | Cited (distinct) | Resolved | Unresolved |
|---|---|---|---|---|
| Requirements (FR) | 117 (1 removed: KB-10) | 137 incl. NFR | 137 | 0 |
| NFR | 20 | (above) | (above) | 0 |
| UC | 34 | 36 | 34 | 2 (UC-09, UC-17: the "free gap" note in use-cases.md, info) |
| SCR | 76 | 79 | 76 | 3 (SCR-APP-061, SCR-WGT-008, SCR-OPS-010: "next free" note, info) |
| ADR | 27 | 27 | 27 | 0 |
| FEAT | 74 (plan §4 incl. FEAT-074 fast-follow) | 75 | 74 | 1 (FEAT-075: "next free" note, info) |
| D (decisions) | 11 | — | — | not checked (decision IDs are cited in prose only) |

Other counts: 137 RTM rows ⇔ 137 SRS IDs (no missing or extra rows; priority and Removed status agree on every row). 48 manifest screens, every `source.spec` file and anchor resolves. 41 feature folders, all in the plan, all with technical-design.md, tasks.md and an **Accepted** acceptance report (FEAT-001 has no folder; it is the skeleton, `docs/scaffold-notes.md`). 44 hex colours in design.md's CSS block, all present in tokens.json.

Checks run: resolution, tombstones, coverage/orphans, RTM integrity, manifest and folders, testing conformance, value authority. Skipped: the defect ledger (`docs/defects.md` absent; maintenance routing has not been used); design-tool locators (all screens are code-native, so nothing to resolve over the network).

## Findings

### implementation-planning

- [ERROR ×26] RTM Plan ref names a feature whose plan §4 row doesn't list the requirement. Fix: amend each §4 row's FRs column with the requirement, marked `(p: …)` where the RTM Test ref is partial. Pairs:

  | Feature (plan §4 row) | Requirements to add |
  |---|---|
  | FEAT-007 | AUTH-02 |
  | FEAT-019 | KB-18 |
  | FEAT-035 | ONB-10, AGT-08, AGT-11 (also not in FEAT-035's technical-design "Implements:"; the verify stage credited them, so the design should list them too, see detailed-design) |
  | FEAT-043 | INB-01 |
  | FEAT-044 | AGT-04, AGT-09, CHN-13, INB-01 |
  | FEAT-045 | KB-18, AGT-02 |
  | FEAT-049 | INB-11, GOV-08 |
  | FEAT-050 | AUTH-03, LED-02, LED-04, LED-08 |
  | FEAT-051 | AGT-14, LED-05, LED-06, GOV-05 |
  | FEAT-054 | ONB-06, ONB-09, AUTH-03, GOV-01 |

  Suggested guard (scaffolding/tooling, owner's call): extend `scripts/check-rtm.mjs` so a Plan ref FEAT must list the requirement in its §4 row (or in the §7 NFR table), so this can't drift again.
- [WARNING] SCR-APP-023 (Sources) is in no §4 row's Screens column. FEAT-012 built it (manifest `feature: FEAT-012`, extended by FEAT-015/016/017). Add it to FEAT-012's row.
- [INFO] AGT-14 is in no §4 row's FRs column; it is a documented foundations exclusion (plan §4, "Placed in engineering foundations"). FEAT-051 now also appends to it (covered by the error above).
- [INFO ×51] A Test ref is marked `(partial)` for a feature whose plan row has no `(p)` for that requirement (or no entry at all). These follow from the same root cause and clear when the rows above are amended: ONB-04 (FEAT-012), ONB-06 (FEAT-054), ONB-09 (FEAT-054), ONB-10 (FEAT-034), AUTH-02 (FEAT-007), AUTH-03 (FEAT-006, FEAT-050), KB-05 (FEAT-012), KB-07 (FEAT-011), KB-12 (FEAT-012), KB-17 (FEAT-018), KB-18 (FEAT-018, FEAT-019, FEAT-045), AGT-01 (FEAT-022), AGT-02 (FEAT-022, FEAT-045), AGT-03 (FEAT-023), AGT-04 (FEAT-023, FEAT-044), AGT-07 (FEAT-025), AGT-08 (FEAT-024), AGT-09 (FEAT-023, FEAT-044), AGT-13 (FEAT-025), AGT-14 (FEAT-051), AGT-16 (FEAT-025), CHN-12 (FEAT-034), CHN-13 (FEAT-033), INB-01 (FEAT-042), INB-05 (FEAT-044), INB-11 (FEAT-046), LED-02 (FEAT-050), LED-04 (FEAT-050), LED-05 (FEAT-050), LED-06 (FEAT-051), LED-07 (FEAT-051), LED-08 (FEAT-049), GOV-01 (FEAT-002, FEAT-054), GOV-05 (FEAT-051), GOV-07 (FEAT-058), GOV-08 (FEAT-057), GOV-14 (FEAT-058), DSH-09 (FEAT-052), NFR-01 (FEAT-004, FEAT-022), NFR-04 (FEAT-022), NFR-10 (FEAT-022), NFR-11 (FEAT-004), NFR-18 (FEAT-052).

### acceptance-verification

- [WARNING ×11] Plan §7 assigns an NFR to a feature, the feature is accepted, but the NFR's Test ref has no entry for it. Plan §3 requires every NFR §7 assigns to a feature to have an AC, so each report should either be cited (partial) or say why not. `check-rtm.mjs` only follows "Implements:" IDs, so NFRs slip through. All are pre-M3 except FEAT-049:
  NFR-03 (FEAT-004) · NFR-04 (FEAT-049) · NFR-05 (FEAT-006, FEAT-034) · NFR-06 (FEAT-015) · NFR-10 (FEAT-009, FEAT-023) · NFR-11 (FEAT-034) · NFR-16 (FEAT-012, FEAT-015, FEAT-016).
- Verdicts: every Test ref cites an existing report, and every report's verdict is **Accepted** (FEAT-012 and FEAT-022 read "Accepted — real-model check pending", the M1.5 gate). No errors.

### detailed-design

- [WARNING] FEAT-035's technical-design "Implements:" omits ONB-10, AGT-08 and AGT-11, which its acceptance report verifies and the RTM credits to it (see the planning error).

### ui-design

- [WARNING] `features/FEAT-035-onboarding-wizard/ui-design.md` has a section for SCR-APP-036 (Channels), but the manifest entry (feature FEAT-034) doesn't reference it in `source` or `extended_by`.
- [WARNING] `features/FEAT-003-pii-masking/ui-design.md` has a section for SCR-WGT-002 (Chat panel), but the manifest entry (anchor) doesn't reference it.

### requirements-engineering · software-architecture · ux-foundations · project-scaffolding

- None. RTM rows and requirement columns match the SRS; ADR citations all resolve; design.md's CSS block ⊆ tokens.json; ux-foundations.md restates no hex values. Testing conformance holds: architecture §8.7's enforced 70% line coverage is in each core package's Vitest thresholds (`agent`, `kb`, `channels`, `inbox`, `approvals`, `governance` at 70; `platform` thresholds `src/pii-mask.ts` and `src/outbox.ts` at 70), and CI runs `pnpm test:coverage`.

## Dashboard

### Counts

- **Features:** 42 of 74 verified (FEAT-001 plus 41 accepted folders). M0, M1, M2 and M3 features are all accepted; M1.5 and MD wait on accounts.
- **M3 (13 features):** FEAT-007, 008, 042, 043, 052, 044, 045, 046, 049, 055, 056, 050, 051, all accepted and merged.
- **Requirements, by the Plan-ref ⨝ Test-ref rule** (strict: "fully" = every Plan-ref entry is a feature with a cited report and none is marked partial; any non-feature Plan ref such as "Foundations", "M6 verification" or "MD" keeps a row partial):

  | | Fully | Partially | Pending |
  |---|---|---|---|
  | Must FRs (99) | 36 | 41 | 22 |
  | Should FRs (16) | 0 | 4 | 12 |
  | Could FRs (1) | 0 | 0 | 1 |
  | NFRs (20) | 0 | 6 | 14 |

  The strict rule undercounts where a later report completed an earlier partial one (for example LED-05: FEAT-050 partial, FEAT-051 complete); reading those as complete gives 48 Must FRs fully verified.
- **Screens:** 48 of 76 inventory screens in the manifest.
- **Open defects:** no ledger. **Open escalations:** none blocking; owner decisions and later checks live in `pending-actions.md` (project files).

### Per-feature stage

All 41 feature folders: **verified** (acceptance-report.md Accepted, tasks.md complete). FEAT-001: verified (skeleton). Every other plan feature: **planned**. This agrees with `docs/build/STATE.md`'s merged list.

### Per-requirement lifecycle

Design: "yes" = a feature technical design is in the Design ref; "ADR only" = only architecture-level refs so far. Verification by the strict rule above.

| Req | Pri | Plan ref | Designed | Verified |
|---|---|---|---|---|
| ONB-01 | Must | FEAT-005 | yes | fully |
| ONB-02 | Must | FEAT-035 | yes | fully |
| ONB-03 | Must | FEAT-009 | yes | fully |
| ONB-04 | Must | FEAT-012 | yes | partially |
| ONB-05 | Must | FEAT-027 | yes | fully |
| ONB-06 | Should | FEAT-009, FEAT-054 | yes | partially |
| ONB-07 | Must | FEAT-032 | yes | fully |
| ONB-08 | Should | FEAT-035 | yes | partially |
| ONB-09 | Must | FEAT-035, FEAT-054 | yes | partially |
| ONB-10 | Must | FEAT-034, FEAT-035 | yes | partially |
| AUTH-01 | Must | FEAT-005 | yes | fully |
| AUTH-02 | Must | FEAT-005, FEAT-008, FEAT-007 | yes | partially |
| AUTH-03 | Must | FEAT-006, FEAT-054, FEAT-050 | yes | partially |
| AUTH-04 | Must | FEAT-007 | yes | fully |
| AUTH-05 | Must | FEAT-008 | yes | fully |
| AUTH-06 | Must | FEAT-010 | ADR only | pending |
| AUTH-07 | Must | FEAT-010 | ADR only | pending |
| AUTH-08 | Must | FEAT-005, FEAT-073 | yes | partially |
| KB-01 | Must | FEAT-012 | yes | fully |
| KB-02 | Must | FEAT-015 | yes | fully |
| KB-03 | Must | FEAT-016 | yes | fully |
| KB-04 | Must | FEAT-017 | yes | fully |
| KB-05 | Must | FEAT-011, FEAT-012 | yes | partially |
| KB-06 | Must | FEAT-014 | yes | fully |
| KB-07 | Must | FEAT-011, FEAT-022 | yes | partially |
| KB-08 | Should | FEAT-020 | ADR only | pending |
| KB-09 | Must | FEAT-019 | yes | fully |
| KB-10 | Could | — | — | removed |
| KB-11 | Must | FEAT-015 | yes | fully |
| KB-12 | Must | FEAT-012 | yes | partially |
| KB-13 | Must | FEAT-012 | yes | fully |
| KB-14 | Should | FEAT-021 | ADR only | pending |
| KB-15 | Must | FEAT-011, FEAT-022 | yes | partially |
| KB-16 | Must | FEAT-013 | yes | fully |
| KB-17 | Must | FEAT-014, FEAT-018 | yes | partially |
| KB-18 | Must | FEAT-018, FEAT-019, FEAT-045 | yes | partially |
| AGT-01 | Must | FEAT-022 | yes | partially |
| AGT-02 | Must | FEAT-022, FEAT-045 | yes | partially |
| AGT-03 | Must | FEAT-023 | yes | partially |
| AGT-04 | Must | FEAT-023, FEAT-044 | yes | partially |
| AGT-05 | Must | FEAT-029 | ADR only | pending |
| AGT-06 | Must | FEAT-022, FEAT-038, FEAT-044, FEAT-049, FEAT-055 | yes | partially |
| AGT-07 | Must | FEAT-025 | yes | partially |
| AGT-08 | Must | FEAT-024, FEAT-035 | yes | partially |
| AGT-09 | Must | FEAT-023, FEAT-044 | yes | partially |
| AGT-10 | Should | FEAT-030 | ADR only | pending |
| AGT-11 | Must | FEAT-022, FEAT-024, FEAT-035 | yes | partially |
| AGT-12 | Must | FEAT-026 | ADR only | pending |
| AGT-13 | Must | FEAT-025, FEAT-042 | yes | partially |
| AGT-14 | Must | FEAT-051, Foundations | yes | partially |
| AGT-15 | Should | FEAT-031 | ADR only | pending |
| AGT-16 | Must | FEAT-022, FEAT-025 | yes | partially |
| AGT-17 | Must | FEAT-027, FEAT-028 | yes | partially |
| CHN-01 | Must | FEAT-034 | yes | fully |
| CHN-02 | Must | FEAT-022, FEAT-032, FEAT-033 | yes | partially |
| CHN-03 | Must | FEAT-029 | ADR only | pending |
| CHN-04 | Must | FEAT-036 | ADR only | pending |
| CHN-05 | Must | FEAT-037 | ADR only | pending |
| CHN-06 | Should | FEAT-040 | ADR only | pending |
| CHN-07 | Must | FEAT-038 | ADR only | pending |
| CHN-08 | Must | FEAT-039 | ADR only | pending |
| CHN-09 | Should | FEAT-041 | ADR only | pending |
| CHN-10 | Must | FEAT-036 | ADR only | pending |
| CHN-11 | Must | FEAT-032 | yes | fully |
| CHN-12 | Must | FEAT-034 | yes | partially |
| CHN-13 | Must | FEAT-033, FEAT-044 | yes | partially |
| CHN-14 | Must | FEAT-032 | yes | fully |
| INB-01 | Must | FEAT-042, FEAT-043, FEAT-044 | yes | partially |
| INB-02 | Must | FEAT-043 | yes | fully |
| INB-03 | Must | FEAT-045 | yes | fully |
| INB-04 | Must | FEAT-042 | yes | fully |
| INB-05 | Must | FEAT-044 | yes | partially |
| INB-06 | Should | FEAT-048 | ADR only | pending |
| INB-07 | Should | FEAT-047 | ADR only | pending |
| INB-08 | Must | FEAT-042 | yes | fully |
| INB-09 | Must | FEAT-043 | yes | fully |
| INB-10 | Could | FEAT-047 | ADR only | pending |
| INB-11 | Must | FEAT-046, FEAT-049 | yes | partially |
| LED-01 | Must | FEAT-049 | yes | fully |
| LED-02 | Must | FEAT-049, FEAT-058, FEAT-050 | yes | partially |
| LED-03 | Must | FEAT-050 | yes | fully |
| LED-04 | Must | FEAT-048, FEAT-052, FEAT-037, FEAT-050 | yes | partially |
| LED-05 | Must | FEAT-050, FEAT-051 | yes | partially |
| LED-06 | Should | FEAT-053, FEAT-051 | yes | partially |
| LED-07 | Must | FEAT-051 | yes | partially |
| LED-08 | Should | FEAT-049, FEAT-050 | yes | partially |
| LED-09 | Must | FEAT-049 | yes | fully |
| APR-01 | Must | FEAT-054 | yes | fully |
| APR-02 | Must | FEAT-055 | yes | fully |
| APR-03 | Must | FEAT-056 | yes | fully |
| APR-04 | Must | FEAT-055 | yes | fully |
| APR-05 | Should | FEAT-066 | ADR only | pending |
| APR-06 | Must | FEAT-055 | yes | fully |
| GOV-01 | Must | FEAT-002, FEAT-054 | yes | partially |
| GOV-02 | Must | FEAT-060 | ADR only | pending |
| GOV-03 | Must | FEAT-001, Foundations | ADR only | pending |
| GOV-04 | Must | FEAT-003 | yes | fully |
| GOV-05 | Must | FEAT-061, FEAT-051 | yes | partially |
| GOV-06 | Must | FEAT-059 | ADR only | pending |
| GOV-07 | Must | FEAT-058, FEAT-073 | yes | partially |
| GOV-08 | Must | FEAT-057, FEAT-049 | yes | partially |
| GOV-09 | Should | FEAT-064 | ADR only | pending |
| GOV-10 | Must | FEAT-072 | ADR only | pending |
| GOV-11 | Must | FEAT-058 | yes | fully |
| GOV-12 | Must | FEAT-062 | ADR only | pending |
| GOV-13 | Must | FEAT-071 | ADR only | pending |
| GOV-14 | Must | FEAT-058 | yes | partially |
| DSH-01 | Must | FEAT-065 | ADR only | pending |
| DSH-02 | Must | FEAT-066 | ADR only | pending |
| DSH-03 | Must | FEAT-007 | yes | fully |
| DSH-04 | Must | FEAT-067, FEAT-070 | ADR only | pending |
| DSH-05 | Should | FEAT-068 | ADR only | pending |
| DSH-06 | Must | FEAT-063, FEAT-070 | ADR only | pending |
| DSH-07 | Must | FEAT-067 | ADR only | pending |
| DSH-08 | Must | FEAT-067 | ADR only | pending |
| DSH-09 | Must | FEAT-052 | yes | partially |
| DSH-10 | Should | FEAT-069 | ADR only | pending |
| NFR-01 | Must | FEAT-004, FEAT-022, Foundations (§7), M6 verification, MD | yes | partially |
| NFR-02 | Must | FEAT-001, Foundations (§7), M6 verification | ADR only | pending |
| NFR-03 | Must | FEAT-001, FEAT-004, Foundations (§7), M6 verification | ADR only | pending |
| NFR-04 | Must | FEAT-022, FEAT-049, Foundations (§7), M6 verification, MD | yes | partially |
| NFR-05 | Must | FEAT-001, FEAT-006, FEAT-034, FEAT-070, Foundations (§7), M6 verification | ADR only | pending |
| NFR-06 | Must | FEAT-001, FEAT-015, Foundations (§7), M6 verification, MD | ADR only | pending |
| NFR-07 | Must | Foundations (§7), M6 verification, MD | ADR only | pending |
| NFR-08 | Must | Foundations (§7), M6 verification, MD | ADR only | pending |
| NFR-09 | Must | FEAT-074, Foundations (§7), M6 verification, every UI feature (§3 gate) | ADR only | pending |
| NFR-10 | Must | FEAT-009, FEAT-022, FEAT-023, Foundations (§7), M6 verification | yes | partially |
| NFR-11 | Must | FEAT-004, FEAT-001, FEAT-034, Foundations (§7), M6 verification | yes | partially |
| NFR-12 | Must | FEAT-001, Foundations (§7), M6 verification | ADR only | pending |
| NFR-13 | Must | FEAT-004, Foundations (§7), M6 verification | yes | partially |
| NFR-14 | Must | FEAT-001, Foundations (§7), M6 verification | ADR only | pending |
| NFR-15 | Must | FEAT-001, Foundations (§7), M6 verification | ADR only | pending |
| NFR-16 | Must | FEAT-012, FEAT-015, FEAT-016, Foundations (§7), M6 verification | ADR only | pending |
| NFR-17 | Must | FEAT-001, Foundations (§7), M6 verification, every channel and ingestion feature (§3 gate) | ADR only | pending |
| NFR-18 | Must | FEAT-036, FEAT-052, Foundations (§7), M6 verification | yes | partially |
| NFR-19 | Must | Foundations (§7), M6 verification, every UI feature (§3 gate) | ADR only | pending |
| NFR-20 | Must | FEAT-069, FEAT-071, Foundations (§7), M6 verification | ADR only | pending |

## Skipped checks

- Defect ledger (check 8): `docs/defects.md` doesn't exist; 0 DEF rows.
- Design-tool locators: no screen uses a design tool (policy `code-native`), so none to resolve.
- Decision IDs (D1–D11): cited in prose across many documents; not diffed this run.

How this was computed: a read-only Python sweep over `docs/**` (archive excluded), `design-manifest.json`, `tokens.json`, the Vitest configs and `ci.yml`; regex extraction of IDs, set diffs, and heading-anchor resolution. Re-running it on the same commit gives the same report.
