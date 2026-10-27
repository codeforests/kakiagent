# Handoff: FEAT-058 — Privacy notice and template, consent wording, data-processing documents
Branch: feat/FEAT-058-privacy-documents · PR: https://github.com/codeforests/kakiagent/pull/35 (draft) · Updated: 2026-10-27 by build (UI)
Stage done: build (T1–T10 of 10), status developer-done
Next: verify — kickoff: "Verify FEAT-058 on branch feat/FEAT-058-privacy-documents. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Dashboard: `lib/privacy.ts` (+ `privacy.test.ts`), `pages/privacy-parts.tsx`, `pages/privacy.tsx` (`/settings/privacy`), `pages/setup-rules.tsx` (`/setup/rules`); Settings row linked; review Continue → `/setup/rules`; coach is "Step 5", widget "Step 6".
- One shared `version`: each form reads `data.version` from the query cache at save time, so saving one form doesn't make the other stale. Forms remount only on Reload (a `generation` counter in `PrivacyScreen`), keeping unsaved edits in the other form.
- PDF buttons are real links (`href` to the PDF route) whose click fetches the file so a failure can show the toast "We couldn't download the PDF. Try again."; the blob link is attached to the DOM before the click (Firefox).
- Never-saved notice starts on "On my website"; the template's contact email is prefilled from the profile. The purpose Save is enabled while it's still the default (D6: the default doesn't count until saved).
- Terms with `acceptedVersion` null read "{title} · not accepted yet" (ui-design didn't cover it).
- Full local checks in `tasks.md` evidence; renders were checked in the session's Chromium with `/api/**` stubbed (no stack).

## Left to CI or later
- E2E `e2e/tests/privacy.e2e.ts` (5 tests) and real-stack renders: Ken's local CI. Due before merge anyway: lockfile changed (pdf-lib, pdfjs-dist in governance).
- `governance anchors.int.test.ts` and `api uploads.int.test.ts` S3 cases need Testcontainers/LocalStack: not runnable in cloud sessions, untouched here.

## Pending for Ken
- Ken's local CI run on this branch before merge (lockfile).
- Legal review of the notice template, consent question and DPA before pilot (already in pending-actions.md).
