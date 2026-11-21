# Handoff: FEAT-061 — Data-subject requests: find, export, correct, delete across stores
Branch: feat/FEAT-061-data-subject-requests · PR: https://github.com/codeforests/kakiagent/pull/77 · Updated: 2026-11-21 by verify
Stage done: verify (accepted)
Next: design FEAT-059 (M5 order) — kickoff: "Design FEAT-059. Branch feat/FEAT-059-<slug> (create it from main). Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage design."

## What the next stage needs
- Report: `acceptance-report.md` (all 11 ACs pass). Verify fixed one defect: the phone-width request cards' link `aria-label` dropped visible text (axe `label-content-name-mismatch`, run 145). The cards now take their name from their content (`f6f1b7e`).
- Every new tenant-scoped table must be classified in `governance/src/dsr/stores.ts` (`DSR_STORES`); its unit test fails otherwise. A store holding a contact's data also needs a delete in `dsr_erase()` (migration) and a count in `DSR_COUNT_STORES`.
- FEAT-059 (audit checkpoints): `dsr.*` audit entries carry codes and counts only; `audit_pii` for erased contacts is gone, and the chain still verifies (`dsr-erase.int`).

## Left to CI or later
- Telegram spec intermittent 429 on "Check again" (run 146, Chromium and WebKit; report Findings 5). This is pre-existing (run 135) and not this feature's: the `channel_degraded` alert retrying to the revoked bot keeps the health check recent. A fix belongs with the Telegram channel code (FEAT-037 area): the alert retries should not refresh `health_checked_at`, or the spec should wait for deliveries to finish.

## Pending for Ken
- None blocking. Review log rows 3–17 (design and build) plus the merge row on 2026-11-28.

## Token use (verify; /mnt/project-files missing, so noted here)
- About 70 tool calls. New context was roughly 110k beyond the start: the diff review (migration ~12k, erase/API/dispatch ~8k), CI job logs (~35k, the largest cost: full job logs come back even with `tail_lines`), and checks run through check-summary (~3k).
- Compared with FEAT-060's verify (~6k on format reads), CI logs dominate here. Fetching only failed-job logs would save the most.
