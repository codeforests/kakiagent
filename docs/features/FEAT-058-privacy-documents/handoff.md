# Handoff: FEAT-058 — Privacy notice and template, consent wording, data-processing documents
Branch: feat/FEAT-058-privacy-documents · PR: none · Updated: 2026-10-27 by build (backend)
Stage done: build (T1–T5 of 10)
Next: build (UI, T6–T10) — kickoff: "Build FEAT-058 (UI) on branch feat/FEAT-058-privacy-documents. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Routes (all `settings.manage`, Agent → 403): `GET /api/v1/settings/privacy`, `PUT …/privacy/notice` (`PrivacyNoticeBody`), `PUT …/privacy/purpose` (`PurposeStatementBody`), `GET …/privacy/documents/{data-flow,dpa}.pdf` (attachment). All return `PrivacySettingsResponse` (contracts, section "Dashboard API: privacy"). Public page `GET /privacy/:key` on the api.
- One `version` covers both forms: after saving the notice, the purpose form must use the version from that response (a stale one is 409).
- 409 body is `{ error: 'version_conflict' }` (same as other settings), not `conflict` as design §3 said.
- `purpose.wording` null = default shown, not saved; `readiness` flags drive the "You need a privacy notice…" alert. `notice.publicUrl` (template mode) is the hosted page link to show/open.
- `documents.updatedOn` is `YYYY-MM-DD`; format it for "Updated {d MMM yyyy}". `terms[].acceptedVersion` may be null.
- Empty optional template fields are stored as null; the API trims.
- E2E `afterEach`: `delete from privacy_settings` for the dev tenant (wording rows may stay; nothing points at them).
- Governance exports for later features: `privacyReadiness`, `visitorPrivacy`, `privacyNoticeUrl`, registry lists.

## Left to CI or later
- E2E `privacy.e2e.ts` and screen renders: Ken's local CI. The lockfile changed (pdf-lib in governance; pdfjs-dist as governance devDependency), so Ken's local CI is due before merge.
- `@kaki/governance` `anchors.int.test.ts` needs S3 (Testcontainers/LocalStack): not runnable in cloud sessions, unrelated to this feature.

## Pending for Ken
- None blocking. Legal review of the notice template, consent question and DPA before pilot (already in pending-actions.md).
