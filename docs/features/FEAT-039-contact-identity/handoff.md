# Handoff: FEAT-039 — Contact identity, verified merge and undo
Branch: feat/FEAT-039-contact-identity · PR: draft (see the branch's PR) · Updated: 2026-11-10 by build (UI)
Stage done: build (T1–T9 of 10), status `developer-done`
Next: verify — kickoff: "Verify FEAT-039 on branch feat/FEAT-039-contact-identity. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- UI: `pages/contact.tsx` (page state, focus, mutations) + `pages/contact-parts.tsx` (cards, search/preview/undo dialogs, `UndoToast`); helpers in `lib/contacts.ts` (+ `contacts.test.ts`); route `/contacts/:contactId`; sidebar in `conversation-parts.tsx` (`VerifiedMark`, `CopyRow` `badge`, View contact, `sidebar-duplicates` hint); lead page `lead-superseded` alert, View contact, no `StatusMenu` when superseded.
- `ConfirmDialog` gained `focusTitle` (packages/ui) for the preview; `ConsentEntry` moved from `lead.tsx` to `leads-parts.tsx` (shared with the Contact page).
- Focus: a closing dialog places focus in its `onCloseAutoFocus` (Radix's close focus runs after React effects, so an effect alone was overridden; the stubbed run caught it). Undo from the toast has no dialog, so an effect focuses there.
- Deviation: merge rows read "automatically (verified details)", not "(verified {kind})": `ContactMergeEntry` has no identifier kind.
- E2E `e2e/tests/contact-merge.e2e.ts`: inserts one widget conversation for "R. Tan" with the owner connection (deleted in `afterAll`), merges R. Tan into Rachel Tan from Rachel's page, undoes from the Merges card; `afterEach` undoes any open merge via the API. It runs after/before `leads.e2e` (which restores Rachel's lead itself).

## Left to CI or later
- E2E (all three browsers) and renders: verify stage's GitHub CI. api `uploads.int` needs Docker (LocalStack).
- Local (build UI): format:check, lint, typecheck, `pnpm test` (155 files / 1810 tests) PASS.

## Pending for Ken
- None.
