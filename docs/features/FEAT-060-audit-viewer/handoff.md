# Handoff: FEAT-060 — Audit log viewer, chain verification and export
Branch: feat/FEAT-060-audit-viewer · PR: none · Updated: 2026-11-14 by build (backend)
Stage done: build (T1–T5 of 9)
Next: build (UI, T6–T9) — kickoff: "Build FEAT-060 (UI) on branch feat/FEAT-060-audit-viewer. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (all `audit.read`, Owner/Admin; Agent 403 `forbidden`): `GET /api/v1/audit/entries?from&to&conversation&actorType&actor&group&before&limit` → `AuditPage` (`next` = pass as `before`); `GET /api/v1/audit/entries/:seq` → `AuditRow` or 404 `not_found`; `GET /api/v1/audit/filters` → `AuditFilters` (active members); `GET /api/v1/audit/verification` → `AuditLastVerified`; `POST /api/v1/audit/verify` → `AuditVerifyResult` (200 also when `ok: false`), 409 `verify_running`, 429 `verify_cooldown` with `retryAfterS` (and a `Retry-After` header); `POST /api/v1/audit/export` body `AuditExportBody` → blob, 403 `reauth_required`, 413 `AuditTooMany`, 400 `bad_request` on a bad query or body.
- Zod-free entry for the dashboard: `@kaki/contracts/audit` (`AUDIT_EVENT_GROUPS`, `AUDIT_GROUP_KEYS`, `auditGroupOf`, `AUDIT_ACTOR_TYPES`, `AUDIT_BREAK_REASONS`, `AUDIT_PAGE_MAX`, `AUDIT_EXPORT_MAX`). Zod shapes and types are in `@kaki/contracts` under "Dashboard API: audit log".
- Query rules the URL mapping must respect: `actor` only with `actorType` `user` or absent (else 400); `to` ≥ `from`; dates `YYYY-MM-DD` (SGT days, inclusive); `limit` ≤ 100; unknown keys refused (strict).
- `AuditRow.actorName` is null for non-user actors and former members (UI: "Former member" when `actorType` is `user`). `pii` is `none | kept | erased`; personal data itself never reaches the client (D5).
- `verifiedAt` in the verify result is the server's time; `AuditLastVerified.last.by` is the member's name (or null).
- New event codes for `EVENT_TEXT`: `audit.verified`, `audit.exported` (besides the existing `audit.pii_erased`).
- Stubbed-API Playwright check (T7): stub the six routes; the 403 `reauth_required` body shape is `ReauthRequired` (as leads export).

## Left to CI or later
- `terraform validate`/`test` (one new assert in `profiles.tftest.hcl`): the cloud session can't reach registry.terraform.io; `fmt -check` passes.
- `governance/test/anchors.int.test.ts` (FEAT-002) needs S3 and doesn't run in cloud sessions; every new suite passes here.
- E2E and axe (T8) in the verify stage's GitHub CI.

## Pending for Ken
- None blocking. FYI (from design): D1 direct-download export deviates from ADR-014 §8; tenant-facing alert on a broken chain is a possible follow-up. Both in pending-actions.
