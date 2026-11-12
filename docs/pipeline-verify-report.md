# Pipeline Verification Report

> Generated: 2026-11-12, at `main` 80d6758 (after FEAT-029) · Scope: full sweep, M4 close · Verdict: **33 errors, 17 warnings** (two root causes)
> Derived view, regenerable with `python3 scripts/pipeline-verify.py` (new in this sweep; `--info` lists info findings, `--json F` dumps everything). The pipeline artifacts are the truth; nothing else was changed by this sweep.

## Verdict and counts

**33 errors, 17 warnings, 9 info.** Two causes explain every error and most warnings:

1. **The M3 fixes were never merged.** PR #60 ("Docs: fix the M3 pipeline-verify findings", 2026-11-08) is still open, and it now conflicts with `main` in `rtm.md`, `design-manifest.json` and `docs/build/STATE.md`. So 26 of the M3 errors and 13 of its warnings are still here, unchanged.
2. **M4 repeated the same drift.** Five requirements that M4's designs took on are in the RTM Plan refs (appended by `check-rtm.mjs --fix`) but not in the features' plan §4 rows: 7 new errors. `check-rtm.mjs` still checks design → RTM only, not RTM → plan, which is why `pnpm lint` stays green.

| Namespace | Defined | Cited (distinct) | Resolved | Unresolved |
|---|---|---|---|---|
| Requirements (FR + NFR) | 137 (1 removed: KB-10) | 137 | 137 | 0 |
| UC | 34 | 36 | 34 | 2 (UC-09, UC-17: the reserved-gap note in use-cases.md, info) |
| SCR | 76 | 79 | 76 | 3 (SCR-APP-061, SCR-WGT-008, SCR-OPS-010: "next free" notes, info) |
| ADR | 27 | 27 | 27 | 0 |
| FEAT | 74 | 75 | 74 | 1 (FEAT-075: "next free" note, info) |
| D (decisions) | 11 | — | — | not checked (cited in prose only) |

Other counts: 137 RTM rows ⇔ 137 SRS IDs, priorities agree. 53 of 76 inventory screens in the manifest; every `source`/`extended_by` locator's file and heading anchor resolves. 47 feature folders, all in plan §4, all with technical-design.md, tasks.md and an **Accepted** acceptance report (FEAT-001 has no folder; it is the skeleton). 44 hex colours in design.md's CSS block, all in tokens.json; ux-foundations.md restates none. `node scripts/check-rtm.mjs`: passed (47 features). Testing conformance: the 70% line threshold is in each core package's Vitest config (agent, approvals, channels, governance, inbox, kb, leads, platform).

Checks run: resolution, tombstones, coverage (RTM ⇔ plan §4 and §7), RTM integrity, feature folders and verdicts, manifest locators and ui-design sections, testing conformance, value authority. Skipped: the defect ledger (`docs/defects.md` absent); design-tool locators (all screens are code-native).

## Findings

### implementation-planning

- [ERROR ×7, new in M4] RTM Plan ref names an M4 feature whose plan §4 row doesn't list the requirement. Fix: add each to the row's FRs column, `(p: …)` where the RTM Test ref is partial.

  | Feature (plan §4 row) | Requirements to add |
  |---|---|
  | FEAT-036 | CHN-01 (p), CHN-12 (p) |
  | FEAT-037 | CHN-01 (p), CHN-12 (p), DSH-09 (p) |
  | FEAT-039 | LED-09 (p) |
  | FEAT-029 | INB-04 (p: page context in the intent block) |

- [ERROR ×26, carried from M3] The same seam for FEAT-007, 019, 035, 043, 044, 045, 049, 050, 051 and 054 (AUTH-02; KB-18; ONB-10, AGT-08, AGT-11; INB-01; AGT-04, AGT-09, CHN-13, INB-01; KB-18, AGT-02; INB-11, GOV-08; AUTH-03, LED-02, LED-04, LED-08; AGT-14, LED-05, LED-06, GOV-05; ONB-06, ONB-09, AUTH-03, GOV-01). PR #60 fixes all 26; it needs rebasing onto `main` (three conflicts) and merging.
- [INFO] NFR-17's Plan ref names FEAT-036 and FEAT-037; §7 assigns NFR-17 to "every channel and ingestion feature", so this is consistent.
- Suggested guard (tooling, owner's call), repeated from M3: have `check-rtm.mjs` require that a Plan ref feature lists the requirement in its §4 row (or the §7 NFR table), or have detailed design amend the §4 row when it widens scope. Without it this recurs every milestone.

### acceptance-verification

- [WARNING ×11, carried from M3] Plan §7 assigns an NFR to an accepted feature, but the NFR's Test ref has no entry for it: NFR-03 (FEAT-004) · NFR-04 (FEAT-049) · NFR-05 (FEAT-006, FEAT-034) · NFR-06 (FEAT-015) · NFR-10 (FEAT-009, FEAT-023) · NFR-11 (FEAT-034) · NFR-16 (FEAT-012, FEAT-015, FEAT-016). PR #60 appends 8 of them; NFR-03 and NFR-05 wait for M6 (k6, ASVS checklist).
- No M4 warnings: FEAT-036 and FEAT-037's NFR-17/NFR-18 Test refs are present (partial).

### detailed-design

- [WARNING ×3, carried from M3] FEAT-035's technical-design "Implements:" omits ONB-10, AGT-08, AGT-11, which its report verifies (PR #60 fixes it).
- [WARNING, newly detected] FEAT-050's "Implements:" (and "Also serves:") omits LED-02, which the RTM credits to its report (partial: consent records shown on the lead). Not in PR #60; add `LED-02 (p: consent records on the lead)` to the design's header, or drop the Test ref entry if the verifier didn't mean it.

### ui-design

- [WARNING ×2, carried from M3] The manifest entries for SCR-APP-036 (FEAT-034) and SCR-WGT-002 (anchor) don't list `features/FEAT-035-onboarding-wizard/ui-design.md` and `features/FEAT-003-pii-masking/ui-design.md` in `extended_by` (PR #60 fixes both). M4's ui-design sections (FEAT-036, 037, 038, 039, 026, 029) are all referenced.

### requirements-engineering · software-architecture · ux-foundations · project-scaffolding

- None. RTM rows and requirement columns match the SRS; ADR citations resolve; tokens agree; coverage thresholds hold.

## Dashboard

### Counts

- **Features:** 48 of 74 verified (FEAT-001 plus 47 accepted folders). M0 to M4 features are all accepted; M1.5 and MD wait on accounts.
- **M4 (6 features):** FEAT-036, 037, 039, 038, 026, 029, all accepted and merged (PRs #61 to #65, #67).
- **Requirements, by the Plan-ref ⨝ Test-ref rule** (strict: "fully" = every Plan-ref entry is a feature with a cited, non-partial report; a non-feature Plan ref such as "Foundations" or "M6 verification" keeps a row partial):

  | | Fully | Partially | Pending |
  |---|---|---|---|
  | Must FRs (99) | 37 (M3: 36) | 48 (41) | 14 (22) |
  | Should FRs (16) | 0 | 4 | 12 |
  | Could FRs (1) | 0 | 0 | 1 |
  | NFRs (20) | 0 | 7 (6) | 13 (14) |

  M4 moved 8 Must FRs out of pending (CHN-04, CHN-05, CHN-07, CHN-08, CHN-10, AGT-05, AGT-12, CHN-03) and made AGT-05, CHN-03, CHN-07 and CHN-10 fully verified. CHN-01, INB-04 and LED-09 went from fully to partially, because M4 appended partial Test refs for its share of them. The strict rule undercounts rows where a later report completed an earlier partial one.
- **Screens:** 53 of 76 inventory screens in the manifest (M3: 48).
- **Open defects:** no ledger. **Open escalations:** none blocking; owner decisions and later checks are in `pending-actions.md` (project files).

### Per-feature stage

All 47 feature folders: **verified** (acceptance report Accepted). FEAT-001: verified (skeleton). Every other plan feature: **planned**. This agrees with `docs/build/STATE.md`'s merged list.

### Per-requirement lifecycle

Designed: "yes" = a feature technical design is in the Design ref; "ADR only" = only architecture-level refs so far. Verified by the strict rule above.

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
| KB-10 | Could | _TBD_ | no | removed |
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
| AGT-05 | Must | FEAT-029 | yes | fully |
| AGT-06 | Must | FEAT-022, FEAT-038, FEAT-044, FEAT-049, FEAT-055 | yes | partially |
| AGT-07 | Must | FEAT-025 | yes | partially |
| AGT-08 | Must | FEAT-024, FEAT-035 | yes | partially |
| AGT-09 | Must | FEAT-023, FEAT-044 | yes | partially |
| AGT-10 | Should | FEAT-030 | ADR only | pending |
| AGT-11 | Must | FEAT-022, FEAT-024, FEAT-035 | yes | partially |
| AGT-12 | Must | FEAT-026 | yes | partially |
| AGT-13 | Must | FEAT-025, FEAT-042 | yes | partially |
| AGT-14 | Must | Foundations, FEAT-051 | yes | partially |
| AGT-15 | Should | FEAT-031 | ADR only | pending |
| AGT-16 | Must | FEAT-022, FEAT-025 | yes | partially |
| AGT-17 | Must | FEAT-027, FEAT-028 | yes | partially |
| CHN-01 | Must | FEAT-034, FEAT-036, FEAT-037 | yes | partially |
| CHN-02 | Must | FEAT-022, FEAT-032, FEAT-033 | yes | partially |
| CHN-03 | Must | FEAT-029 | yes | fully |
| CHN-04 | Must | FEAT-036 | yes | partially |
| CHN-05 | Must | FEAT-037 | yes | partially |
| CHN-06 | Should | FEAT-040 | ADR only | pending |
| CHN-07 | Must | FEAT-038 | yes | fully |
| CHN-08 | Must | FEAT-039 | yes | partially |
| CHN-09 | Should | FEAT-041 | ADR only | pending |
| CHN-10 | Must | FEAT-036 | yes | fully |
| CHN-11 | Must | FEAT-032 | yes | fully |
| CHN-12 | Must | FEAT-034, FEAT-036, FEAT-037 | yes | partially |
| CHN-13 | Must | FEAT-033, FEAT-044 | yes | partially |
| CHN-14 | Must | FEAT-032 | yes | fully |
| INB-01 | Must | FEAT-042, FEAT-043, FEAT-044 | yes | partially |
| INB-02 | Must | FEAT-043 | yes | fully |
| INB-03 | Must | FEAT-045 | yes | fully |
| INB-04 | Must | FEAT-042, FEAT-029 | yes | partially |
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
| LED-09 | Must | FEAT-049, FEAT-039 | yes | partially |
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
| DSH-09 | Must | FEAT-052, FEAT-037 | yes | partially |
| DSH-10 | Should | FEAT-069 | ADR only | pending |
| NFR-01 | Must | Foundations (§7), M6 verification, FEAT-004, FEAT-022, MD | yes | partially |
| NFR-02 | Must | Foundations (§7), M6 verification, FEAT-001 | ADR only | pending |
| NFR-03 | Must | Foundations (§7), M6 verification, FEAT-001, FEAT-004 | ADR only | pending |
| NFR-04 | Must | Foundations (§7), M6 verification, FEAT-022, FEAT-049, MD | yes | partially |
| NFR-05 | Must | Foundations (§7), M6 verification, FEAT-001, FEAT-006, FEAT-034, FEAT-070 | ADR only | pending |
| NFR-06 | Must | Foundations (§7), M6 verification, FEAT-001, FEAT-015, MD | ADR only | pending |
| NFR-07 | Must | Foundations (§7), M6 verification, MD | ADR only | pending |
| NFR-08 | Must | Foundations (§7), M6 verification, MD | ADR only | pending |
| NFR-09 | Must | FEAT-074, Foundations (§7), M6 verification, every UI feature (§3 gate) | ADR only | pending |
| NFR-10 | Must | Foundations (§7), M6 verification, FEAT-009, FEAT-022, FEAT-023 | yes | partially |
| NFR-11 | Must | FEAT-004, Foundations (§7), M6 verification, FEAT-001, FEAT-034 | yes | partially |
| NFR-12 | Must | Foundations (§7), M6 verification, FEAT-001 | ADR only | pending |
| NFR-13 | Must | FEAT-004, Foundations (§7), M6 verification | yes | partially |
| NFR-14 | Must | Foundations (§7), M6 verification, FEAT-001 | ADR only | pending |
| NFR-15 | Must | Foundations (§7), M6 verification, FEAT-001 | ADR only | pending |
| NFR-16 | Must | Foundations (§7), M6 verification, FEAT-012, FEAT-015, FEAT-016 | ADR only | pending |
| NFR-17 | Must | Foundations (§7), M6 verification, FEAT-001, every channel and ingestion feature (§3 gate), FEAT-036, FEAT-037 | yes | partially |
| NFR-18 | Must | Foundations (§7), M6 verification, FEAT-036, FEAT-052 | yes | partially |
| NFR-19 | Must | Foundations (§7), M6 verification, every UI feature (§3 gate) | ADR only | pending |
| NFR-20 | Must | Foundations (§7), M6 verification, FEAT-069, FEAT-071 | ADR only | pending |
