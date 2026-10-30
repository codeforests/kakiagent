# Handoff: FEAT-054 — Boundary rules with safe defaults
Branch: feat/FEAT-054-boundary-rules · PR: see below (draft) · Updated: 2026-10-30 by build (UI)
Stage done: build (T1–T11 of 11), status developer-done
Next: verify — kickoff: "Verify FEAT-054 on branch feat/FEAT-054-boundary-rules. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `lib/rules.ts` (`useRules`, `useSaveRules` through `useReauthGuard().guard`, `diffRules`, `topicError`, `discountError`, `rulesFieldErrors`, `savedCaption`), `pages/rules-parts.tsx` (`RulesBlock`, `RulesForm`, `TopicListEditor`), `pages/rules.tsx` (`/settings/rules`), `pages/setup-rules.tsx` (rules block above Privacy). Settings index row links to `/settings/rules`.
- Checked in this session's Chromium against a stubbed API (no stack): page and confirm dialog at 1280 and 375, confirm lines, toast, focus back on Save, 409 alert, and confirm → re-auth dialog (email) → save with no second click; axe serious/critical clean on page and dialog.
- Save button: when there's nothing to save it is `aria-disabled` (not `disabled`), so focus can return to it after a save (ui-design asks for both); clicks are ignored.
- `ErrorSummary` (privacy-parts) gained an optional `title` ("Some rules need fixing").
- `privacy.e2e.ts`: the setup caption assertion changed to the ui-design copy ("You'll need saved rules, a privacy notice and a purpose statement before you go live."). Not a weakened test: the copy changed by design.
- `rules.e2e.ts` deletes the dev tenant's `boundary_rules` rows in `beforeEach`/`afterEach` through the owner connection (like `privacy.e2e.ts` does for `privacy_settings`), not by saving `SAFE_DEFAULTS` as the backend handoff suggested: every browser then starts from the F&B template, and no blocked topic leaks into later specs. It ages the owner's `reauth_at` to cover the emailed re-auth link in every browser.

## Left to CI or later
- E2E (`rules.e2e.ts`, `privacy.e2e.ts`), light/dark axe and 375 px in the real stack: verify stage's GitHub CI.
- `uploads.int.test.ts` (S3 presigner) can't run in cloud sessions without Docker/LocalStack.

## Pending for Ken
- None.
