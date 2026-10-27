# Handoff: FEAT-058 — Privacy notice and template, consent wording, data-processing documents
Branch: feat/FEAT-058-privacy-documents · PR: https://github.com/codeforests/kakiagent/pull/35 · Updated: 2026-10-27 by verify
Stage done: verify (accepted; local CI green at cbea038)
Next: Ken's local CI on this branch (lockfile), then squash-merge on Ken's go; then design FEAT-034 — kickoff: "Design FEAT-034. Branch feat/FEAT-034-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Report: `acceptance-report.md`. One test strengthened (api hosted page asserts business name and purpose, AC-2).
- FEAT-034 uses `privacyReadiness` (`@kaki/governance`) for the pre-live form (UX-R4); FEAT-035 for ONB-09; FEAT-049 stores `purposeWordingId` / `noticeWordingId` from `visitorPrivacy()`.
- Observations (not blocking): concurrent same-kind saves at one version give 500 on the seq unique index instead of 409; OCR (self-hosted, ADR-019) isn't mentioned on the page or PDFs.

## Left to CI or later
- E2E `e2e/tests/privacy.e2e.ts` (5 tests, axe) and real-stack renders: Ken's local CI, due before merge (lockfile).
- `governance anchors.int.test.ts`, `api uploads.int.test.ts` S3 cases need Docker; not run here.

## Pending for Ken
- Local CI run on this branch and its summary; then merge go-ahead.
- Legal review of the notice template, consent question and DPA before pilot (in pending-actions.md).
