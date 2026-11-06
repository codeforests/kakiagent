# Handoff: FEAT-050 — Leads list, pipeline, scoring and CSV export
Branch: feat/FEAT-050-leads-pipeline · PR: none · Updated: 2026-11-06 by build (backend)
Stage done: build (T1–T5 of 9)
Next: build (UI, T6–T9) — kickoff: "Build FEAT-050 (UI) on branch feat/FEAT-050-leads-pipeline. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the UI session needs
- Routes (apps/api/src/leads.ts): `GET /api/v1/leads?status&score&cursor&limit` → `LeadList`; `GET /api/v1/leads/:id` → `LeadDetail` (with `canManage`/`canExport`); `POST /api/v1/leads/:id/status` `{ status, version }` → `LeadRow`, 409 `LeadConflict409` (`stale` with `lead`, or `open_lead_exists`), 403 for Agents; `POST /api/v1/leads/export` `LeadExportBody` → CSV body (`text/csv`, `attachment; filename="leads-YYYY-MM-DD.csv"`), 403 `reauth_required` (wrap in `useReauthGuard().guard`), 413 `too_many`. Bad cursor → 400 `invalid_cursor`.
- Contracts: `LeadScore`, `ScoreReasonCode`, `ScoreReason`, `LeadScoring` (nullable), `Qualification` sit beside `LeadStatus`; the rest in "Dashboard API: leads" at the end. `LeadSummary.scoring` is in the inbox sidebar already. `PUT /settings/leads` answers `LeadSettingsSaved` (= settings + `rescored`); `LeadSettingsBody.qualification` is optional server-side, but the dashboard's `leadBodyOf` already sends `draft.qualification` (carried through from `leadDraftOf`); T8 only has to add the card, validation and the diff.
- Reason words: leads `REASON_TEXT` (export.ts) is the CSV's copy of the ui-design table; the dashboard's `reasonText` should match it word for word.
- F&B template keywords are `INDUSTRY_TEMPLATES.fnb.leadKeywords` (`wedding`, `corporate`, `event`, `婚礼`); a never-saved tenant's GET already returns them in `qualification`.
- Dev seed: Kaki Bakery has four contact-form leads: Rachel Tan hot 7 (new), Daniel Lim warm 4 (new, keyword already counted), Siti Rahman cold 1 (new, need "Do you sell bread loaves?"), Grace Wong warm 3 (won, never rescored); qualification = template keywords + `minBudget` 300. Second tenant: none. T9's "warm turns hot" can't happen with this seed (a keyword counts once and Daniel has no budget), so the E2E should add the keyword `bread` and assert Siti goes Cold → Warm (1 → 3), then remove it again in `afterEach`.
- Agents read leads with `inbox.read`; `leads.manage`/`leads.export` are Owner and Admin.

## Left to CI or later
- E2E (`leads.e2e.ts`) and screen renders in the verify stage's GitHub CI (no Docker here).
- `apps/api` `uploads.int` needs LocalStack, so it can't run here; all other api suites pass (395).

## Pending for Ken
- None.
