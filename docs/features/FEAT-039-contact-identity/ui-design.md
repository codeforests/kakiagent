# UI Design: FEAT-039 — Contact identity, verified merge and undo

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E5) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-016 (new), SCR-APP-015 (p: sidebar Contact section), SCR-APP-033 (p: View contact, merged-lead banner) · Mode: per-feature · Status: Draft · Date: 2026-11-10

No design tool is connected and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `card`, `chip`/`status-badge`, `button` (`primary`, `secondary`, `ghost`), `dialog`, `confirm-dialog`, `field`, `text-input`, `list`, `alert`, `toast` (with one Undo action, design.md §4.3), `skeleton`, `error-state`, `empty-state`, `link`, `context-sidebar`. No new component or token. Icons (Lucide): `shield-check` verified, `circle-dashed` not verified, `mail`, `phone`, `send` (Telegram, always with its text), `users` duplicates, `git-merge` merge, `undo-2` undo.

## SCR-APP-016 — Contact

- **Strategy and source:** code-native (this section).
- **Route:** `/contacts/:contactId`; breadcrumb "Inbox / Contact" (from the thread) or "Leads / Contact" (from a lead, by `?from=lead`). No nav entry. Every role sees and merges (`canMerge`); without it the merge controls are absent.
- **Contract bindings:** `GET /api/v1/contacts/:id`, `POST /api/v1/contacts/search`, `GET /api/v1/contacts/:id/merge/:otherId`, `POST /api/v1/contacts/:id/merge`, `POST /api/v1/contacts/merges/:mergeId/undo`.
- **Layout:** title = name or label, caption "First seen {date} · {conversationCount} conversations". Desktop (≥ 1024): two columns, main (Identifiers, Conversations, Leads, Consent) and side (Possibly the same person, Merges). Below 1024: one column, side cards after Identifiers.

**Identifiers** card ("How to reach them"): one row per identity: kind icon, value (email, `+65 9123 4567`, `@username` or "Telegram account"), and a chip: verified (`--color-success-soft`, `--color-success-default` icon) with `shield-check` "Verified" plus caption by source ("by their email provider", "by Telegram"); not verified (`--color-bg-subtle`, `--color-text-secondary`) with `circle-dashed` "Not verified" plus caption "typed in the chat form" / "from email we couldn't check". Copy button per row (as the sidebar's `CopyRow`). Help line under the card (body-sm): "We only join contacts automatically when the same verified email or Telegram account shows up. Typed details stay separate until you merge them."

**Conversations** card: rows "{channel} · {date} · {status}" linking `/inbox/:id`, newest first; more than 20 → caption "Showing the latest 20 of {n}." Empty: "No conversations. They left details on the contact form."

**Leads** card: each lead "{status chip} {need or 'No need given'} · {date}" → `/leads/:id`; a superseded lead adds chip (`--color-bg-subtle`) "Merged into another lead" and links there. Empty: "No leads yet."

**Consent records** card: FEAT-051's consent list (same row component as SCR-APP-033). Empty: "No consent recorded."

**Possibly the same person** card (`users`), shown when `duplicates` is non-empty: body "These contacts share details with this one. They aren't joined because the details aren't verified." Each row: label, the shared values ("Same email: mei@example.com"), `secondary` "Review merge" → preview dialog. With `canMerge`, under the card (or alone when there are no duplicates): `ghost` `git-merge` "Merge with another contact" → search dialog.

**Search dialog** (`dialog` "Find the other contact"): `field` with `text-input` type search, "Name, email, phone or Telegram username" (min 2 characters, debounced 300 ms, POST body), results list (label, email/phone/@username, "Last seen {date}"), each a button "Choose" → preview dialog. States: idle caption "Type at least 2 characters."; searching (skeleton rows); none "No other contacts match."; error inline `alert` "We couldn't search. Try again." Escape or "Cancel" closes; focus returns to the opener.

**Merge preview** (`confirm-dialog`, heading "Merge {other} into {this}?", focus on the heading):
- Two compact columns "Keeps" / "Merges in" (stacked on phone): identifiers with verified chips, "{n} conversations", open lead need, consent decisions.
- "After the merge" block: "{n} ways to reach them", "{n} conversations"; lead line by `leadOutcome`: `none` nothing, `keep` "Their open lead stays.", `move` "The open lead from {other} moves here.", `supersede` "Both have an open lead. {other}'s is kept as merged and only this contact's stays in your pipeline."; consent line: "Marketing: {Agreed | Declined | Withdrawn | Not asked}" with, when the result differs from this contact's, an `alert` warning "Marketing consent changes to {x} because {other}'s record is newer. Check they're the same person."
- Caption: "You can undo this from this page."
- Actions: "Cancel" / `primary` "Merge" (busy "Merging…"). Success: dialog closes, the page re-renders with the merged data, focus on the title, toast "Merged {other} into {this}." with action "Undo". Errors: 409 `merged` → inline alert "{other} was already merged into another contact. Reload to see where." + Reload; `same_contact` can't occur from the UI; 404 → "That contact no longer exists."; network → "We couldn't merge. Try again." (actions re-enabled).

**Merges** card (`git-merge`, heading "Merged into this contact"), shown when `merges` is non-empty: rows "{otherLabel} · {date} · by {member | 'automatically (verified {kind})'}" and `ghost` `undo-2` "Undo merge" when `canUndo` → `confirm-dialog` "Undo the merge with {otherLabel}?" body "Their conversations, leads, consent records and contact details go back to {otherLabel}. Anything added since the merge stays here." "Cancel" / `primary` "Undo merge" (busy "Undoing…"); success toast "Merge undone." and focus on the Merges heading; `undoBlocked = survivor_merged` → no button, caption "This contact was merged into another since. Undo that merge first."; undone rows show "Undone {date}" muted. 409 `already_undone` → alert "Someone already undid this merge." + Reload.

**Merged-away contact** (`mergedInto` set): the page shows only an `alert` info "{label} was merged into {mergedInto.label}." with `link` "Open {mergedInto.label}" and, with `canMerge`, `secondary` "Undo merge" (same confirm). Links from old threads therefore never dead-end.

**States:** loading (skeleton cards), not found (`empty-state` "We couldn't find this contact." + link to Inbox), error (`error-state` "We couldn't load this contact." + "Try again"), populated, no conversations, no leads, no consent, duplicates, no duplicates, search idle / searching / results / none / error, preview, preview consent warning, merging, merge failed, merged (toast with Undo), merges list, undo confirm, undoing, undo blocked, already undone, merged-away contact, view only (no `canMerge`).

**Accessibility:** verified state is text plus icon, never colour alone; the toast's Undo is a real button and the same action stays on the page after the toast goes; dialogs trap focus and return it; result rows are buttons with the contact's label as name.

## SCR-APP-015 — Conversation (partial: sidebar Contact section)

- `CopyRow`s for email and Telegram gain a trailing chip: `shield-check` "Verified" (`--color-success-soft`) when `verified.email` / `verified.telegram`, nothing otherwise (phone is never verified yet, so no chip).
- With `contactId`: `link` "View contact" → `/contacts/:contactId`. With `duplicates > 0`: caption with `users` icon "Possibly the same person as {n} other contact(s)." linking to the Contact page's duplicates card (`#duplicates`).
- No change without a contact (existing caption).

## SCR-APP-033 — Lead (partial)

- Under the contact block: `link` "View contact" → `/contacts/:contactId?from=lead`.
- `supersededBy` set: `alert` info at the top "This lead was merged into another lead when their contacts were merged." with `link` "Open the current lead"; status controls hidden (the lead is out of the pipeline); everything else read-only as now.

## Tokens used

`--color-success-soft`/`--color-success-default` (verified chip), `--color-bg-subtle`/`--color-text-secondary` (not verified, merged chips), `--color-warning-soft`/`--color-warning-default` (consent warning alert), `--color-info-soft` (merged-away and merged-lead alerts), `--space-*`, `--radius-md`, `--type-body-sm` captions; nothing new.

## Gaps and escalations

- Phone numbers can't show as verified until a verified phone source exists (technical design §8).
- The Telegram "Continue on Telegram" link and email verification that produce automatic merges are FEAT-038's widget screens (SCR-WGT-004); here they appear only as "automatically (verified {kind})" merge rows.
