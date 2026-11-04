# Handoff: FEAT-049 — Consent and lead capture
Branch: feat/FEAT-049-lead-capture · PR: https://github.com/codeforests/kakiagent/pull/53 (draft) · Updated: 2026-11-04 by build (UI)
Stage done: build (T1–T13 of 13), status `developer-done`
Next: verify — kickoff: "Verify FEAT-049 on branch feat/FEAT-049-lead-capture. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the verify stage needs
- Widget: `apps/widget/src/cards.tsx` (`LeadCard`, `ContactForm`, `PrivacyLink` moved here), helpers in `chat.ts`, calls in `api.ts`; panel 19.17 KB gz of 35. New `--kaki-danger`/`--kaki-success` through tokens.json (generator pairs on subtle added in `gen_tokens_css.py`).
- Dashboard: `/settings/leads` (`pages/leads-settings*.tsx`, `lib/leads.ts`), Settings index row, `/leads` placeholder names FEAT-050; inbox sidebar Contact/Lead, dividers, card captions, `matchLabel` search rows.
- Backend handoff facts still hold (routes, 409/422 shapes, seed: Kaki Bakery marketing on, second tenant off).
- E2E: `e2e/tests/lead-capture.e2e.ts` (agree → form → submit → owner search by phone, decline, paused contact form; pauses via API and resumes in `afterEach`), `e2e/tests/leads-settings.e2e.ts` (second tenant, restores Budget).

## Deviations from the design
- The widget config carries no field labels, so the F&B "Date needed" label isn't used; every tenant sees "Preferred date or time".
- On Not now the consent request omits `marketing` (the server ignores it on a decline).
- A 409 `consent_required` or `wording_changed` on `/lead` turns the form back into a consent card.

## Left to CI or later
- E2E specs and screen renders: not run here (no Docker); GitHub CI in verify. Stubbed Playwright checks ran for the widget (375) and dashboard (1280/375, inbox 1440); results in tasks.md notes.
- Env-only integration failures from the backend session (governance anchors, api uploads) need S3/containers: CI.

- Flake seen: agent `suggest.int.test.ts:176` asserts the audit JSON has no "55", which fails when a random UUID contains it (FEAT-045's test); passed on re-run. Worth a follow-up fix (assert on the price text, not a bare "55").

## Pending for Ken
- None.
