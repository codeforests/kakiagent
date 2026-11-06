# Handoff: FEAT-050 — Leads list, pipeline, scoring and CSV export
Branch: feat/FEAT-050-leads-pipeline · PR: draft (see the branch's PR) · Updated: 2026-11-06 by build (UI)
Stage done: build (T1–T9 of 9), status developer-done
Next: verify — kickoff: "Verify FEAT-050 on branch feat/FEAT-050-leads-pipeline. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Screens: `/leads` (`pages/leads.tsx`), `/leads/:leadId` (`pages/lead.tsx`), parts in `pages/leads-parts.tsx`; `ScoreChip` sits in `conversation-parts.tsx` (inbox sidebar shows it plus "Open lead"); Qualification card in `leads-settings-parts.tsx` (`#qualification`). Helpers and unit tests in `lib/leads.ts` / `lib/leads.test.ts`.
- `api.saveLeadSettings` now parses `LeadSettingsSaved`; the toast reads "Lead settings saved. {n} open leads rescored." when `rescored > 0`. FEAT-049's `leads-settings.e2e` filters toasts with `hasText: 'Lead settings saved'`, so it still matches.
- Deviations from ui-design, both small:
  - Export dialog title: the tab count when there's no score filter. With a score filter the list counts don't apply (they ignore score), so it shows the loaded row count once the list is complete, else "Export these leads?". The toast's n comes from the downloaded CSV's rows.
  - 409 `open_lead_exists`: the server doesn't name the other lead, so the alert has no "Open their lead" link (the design allows this).
- The Lead page's Details card adds an "Offers" row (LED-08 flag on the lead) and puts captures/first captured/updated in one caption line.
- E2E `leads.e2e.ts` restores the bakery's leads (status, version, score columns) and `lead_settings.qualification` in `afterEach` via the owner connection. Keyword test adds "bread" (Siti Cold 1 → Warm 3), as the backend handoff advised.
- Export with re-auth uses `ageReauth` + the emailed link, as `rules.e2e.ts` does; the download comes from a blob URL (`page.waitForEvent('download')`).

## Left to CI or later
- `leads.e2e.ts` and axe at 1280 and 375×5000 run only in GitHub CI (no Docker here). A stubbed-API Chromium run covered the screens' main paths (tasks.md evidence).
- `apps/api` `uploads.int` needs LocalStack (backend handoff).

## Pending for Ken
- None.
