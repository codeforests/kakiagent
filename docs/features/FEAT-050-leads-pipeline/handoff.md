# Handoff: FEAT-050 — Leads list, pipeline, scoring and CSV export
Branch: feat/FEAT-050-leads-pipeline · PR: none · Updated: 2026-11-06 by design
Stage done: design
Next: build (backend, T1–T5) — kickoff: "Build FEAT-050 (backend) on branch feat/FEAT-050-leads-pipeline. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Scoring is pure code (`leads/score.ts`, design §5.1): fixed points and bands (hot ≥ 5, warm 3–4), owner keywords and minimum budget in `lead_settings.qualification` (D2). No model, no evals.
- Score on capture (visitor zone, `app_agent_visitor`) and on a qualification save (dashboard zone, open leads only). Hot-lead alert only on capture, once per lead (`hot_alerted_at`, dedupe `hot_lead:<leadId>`), recipients from `escalation_candidates()` (D3). `hot_lead` kind, `lead` subject and `/leads/:id` link already exist in platform notifications.
- T1 must check whether the visitor zone can read the contact's other conversations' `task_kinds`; if not, add `lead_intents()` (design §4).
- Export is a direct CSV download after re-auth (D1, Ken chose it 2026-11-06).
- `exportable()` is the seam FEAT-051 extends to drop withdrawn-consent leads; today it passes everything.
- New capabilities `leads.manage`, `leads.export` (Owner, Admin). Agents read via `inbox.read`.
- Seed: four contact-form leads (no conversation) for Kaki Bakery only, so inbox E2E counts don't change.

## Left to CI or later
- E2E (`leads.e2e.ts`) and screen renders run in the verify stage's GitHub CI (no Docker here).

## Pending for Ken
- None.
