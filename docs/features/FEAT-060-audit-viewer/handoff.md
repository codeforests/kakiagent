# Handoff: FEAT-060 — Audit log viewer, chain verification and export
Branch: feat/FEAT-060-audit-viewer · PR: none · Updated: 2026-11-14 by design
Stage done: design
Next: build (backend, T1–T5) — kickoff: "Build FEAT-060 (backend) on branch feat/FEAT-060-audit-viewer. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- No migration: `app_dashboard` already selects `audit_entries` and `audit_pii` (0005). Everything reads through `withTenant(dashboardDb, …)`.
- Decisions taken in design (technical-design §7): D1 export is a direct download (not ADR-014 §8's S3 presigned link; same as leads FEAT-050 D1), cap 100,000; D3 verify always checks the whole chain; D4 session advisory lock (409) + 30 s cooldown read from the latest `audit.verified` entry (429); D5 `audit_pii.data` is never selected, shown or exported.
- New event codes: `audit.verified` (own transaction after the read) and `audit.exported` (same transaction as the export, after the snapshot bound so it isn't in the file).
- `governance` may not import `leads`: copy the `csvCell` formula-injection rule.
- The API gets an `AnchorSource` in `Deps.auditAnchors` (config `AUDIT_ANCHOR_BUCKET`); tests pass a fake list or a throwing one.
- Tamper tests disable the `audit_entries_immutable` trigger as the test superuser, in the test only. The 75k perf seed builds a valid chain in JS (`entryHash`) and bulk-inserts as superuser, setting `audit_heads`.
- UI session: T6–T9 after `## Build session 2 (UI)`; route `/settings/audit`, Settings row "Audit log" already exists without `to` in `pages/settings.tsx`.

## Left to CI or later
- E2E `audit-log.e2e.ts` and axe run in the verify stage's GitHub CI (no Docker here).
- Terraform `validate`/`test` if the session has no terraform binary.

## Pending for Ken
- None blocking. FYI: D1 (direct-download export) is a deviation from ADR-014 §8, listed for the next architecture amendment (§8); tenant-facing alert on a broken chain is a possible follow-up. Both in pending-actions.
