# Handoff: FEAT-039 — Contact identity, verified merge and undo
Branch: feat/FEAT-039-contact-identity · PR: none · Updated: 2026-11-10 by build (backend)
Stage done: build (T1–T6 of 10)
Next: build (UI, T7–T9) — kickoff: "Build FEAT-039 (UI) on branch feat/FEAT-039-contact-identity. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the UI session needs
- Routes (`apps/api/src/contacts.ts`): `GET /api/v1/contacts/:id` → `ContactDetail`; `POST /api/v1/contacts/search` `{ q, exclude? }` → `ContactSearchResponse` (422 `invalid_body` under 2 chars); `GET /api/v1/contacts/:id/merge/:otherId` → `MergePreview`; `POST /api/v1/contacts/:id/merge` `{ otherId }` → `MergeResponse { mergeId, contact }` (`:id` survives, D5); `POST /api/v1/contacts/merges/:mergeId/undo` → `UndoMergeResponse { contact }` (the restored contact). 409 body `ContactConflict409` (`not_mergeable`: `same_contact`/`merged`; `undo_blocked`: `already_undone`/`survivor_merged`); 404 for unknown or other-tenant IDs.
- Contracts (end of `packages/contracts/src/index.ts`, "contacts" section): `ContactIdentity` (`value` already formatted for display: `+65 9123 4567`, `@user` / "Telegram account"; `source` drives the ui-design caption), `ContactDuplicate`, `ContactMergeEntry`, `ContactLead.supersededBy`, `ContactConversation.channel`. Sidebar: `ContextSidebar.contact.verified { email, telegram }` and `duplicates` (0–5). `LeadDetail.supersededBy`.
- A merged-away contact's `GET` answers `mergedInto { contactId, label, mergeId }` with empty lists: the page shows the redirect notice. `ContactMergeEntry.undoBlocked` is always null in practice (a merged-away survivor's page has no merges list); `canUndo` = not undone.
- Dev seed (D10): bakery contact "R. Tan" shares Rachel Tan's email (lead-form identities on both), with no lead and no conversation. So the demo/E2E path into the pair is the Leads list → Rachel Tan's lead page → "View contact" → "Possibly the same person: R. Tan". The sidebar duplicate hint needs a conversation: the E2E can get one by leaving Rachel's email in the widget lead form (a new contact sharing it, D1), or link a conversation by SQL. Restore in `afterEach` by undoing the merge.
- Capability `contacts.merge` = all three roles; `canMerge` on the detail.

## Deviations from the design (small)
- Consents re-keying: 0048 had granted the visitor zone `UPDATE (contact_id) ON consents` for lead capture. Kept, but a restrictive policy `consents_link_once` lets it set `contact_id` only while null, so no app role can re-key a linked consent (AC-7); the dashboard has no UPDATE at all.
- Audit payload of `contact.merged` is flat (`conversations`, `consents`, `leads`, `identities` counts beside the IDs): the audit payload type takes no nested objects.
- D1 changed six existing tests to the same browser (`visitor_id`) instead of the same typed email: leads `leads.int` (2), `pipeline.int` (2), api `leads-widget.int` (contact form then chat now makes two leads), db `rls.int` (2: display email no longer unique; link-once). Each carries a FEAT-039 comment; T4's commit lists them.

## Left to CI or later
- api `uploads.int` needs Docker (LocalStack); not runnable here. E2E and renders: verify stage's GitHub CI.

## Pending for Ken
- None.
