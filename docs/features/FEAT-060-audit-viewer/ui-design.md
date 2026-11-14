# UI design: FEAT-060 — Audit log viewer, chain verification and export

> Screens: SCR-APP-050 (new), SCR-APP-014 (partial: "View audit log" link in the context sidebar) · Contracts: [technical-design.md](technical-design.md) §3 · Strategy: code-native (design.md, tokens.json; no design tool connected)
> Status: designed · 2026-11-14

**Shared words.** Actors: user → member name ("Former member" when `actorName` is null), agent → "Assistant", system → "System", visitor → "Visitor", operator → "KakiAgent support". Groups (filter labels): Conversations · Assistant · Knowledge · Approvals and rules · Contacts and leads · Team and account · Settings and channels · Audit log · Other. Event text: `EVENT_TEXT[code]` in sentence case ("Fact updated", "Reply sent by the assistant", "Approval decided", "Leads exported", "Audit chain verified", "Audit log exported"); unknown codes humanise the code (`kb_source.parsed` → "Kb source parsed"). Personal data: none → nothing shown; kept → "Personal data kept separately"; erased → "Personal data erased". Break reasons: `hash_mismatch` "This entry was changed after it was written", `link_mismatch` "This entry doesn't follow the one before it", `seq_gap` "An entry is missing before this one", `anchor_mismatch` "This entry doesn't match the copy stored outside the database", `truncated` "Entries after this one were removed", `pii_commitment_mismatch` "The personal data linked to this entry was changed". Times in SGT: "18 Nov 2026, 2:14:07 pm" in detail, "2:14 pm" / "Yesterday 2:14 pm" / "18 Nov, 2:14 pm" in the list.

## SCR-APP-050 — Audit log

`/settings/audit`, Owner and Admin. Settings index → "Privacy and data" → "Audit log" (row gets its link; Agents don't see the row). An Agent opening the URL gets the standard no-permission state.

- **Header:** `breadcrumb` Settings › Audit log; `page-title` "Audit log"; lede "Every decision the assistant made and every change your team made. Entries can't be edited or deleted." Right of the title (below on phones): `secondary` button "Export" (download icon).
- **Verify card** (`card`, above the filters): title "Chain verification"; body states:
  - never verified: "Check that no entry has been changed or removed." + `secondary` "Verify audit chain".
  - last result intact: success `chip` "Intact" + "Last verified 18 Nov, 2:14 pm by Mei Ling · 12,345 entries" + "Verify again".
  - verifying: button busy "Verifying…", `aria-live=polite` text "Checking every entry. This can take up to a minute."
  - verified (this run): success `alert` "Chain intact. 12,345 entries checked against 48 stored checkpoints." When `anchors` is `none_yet`: "…checked. The first outside checkpoint is stored within 15 minutes." When `unavailable`: warning `alert` "Entries checked, but the copies stored outside the database couldn't be read. Try again later."
  - tamper detected: danger `alert` (role=alert) "Problem found at entry #4,512. {break reason words}." + `link` "Show entry" (opens the detail panel for that seq; for `seq_gap`/`truncated` it opens the nearest existing entry) + body-sm "Contact support. Entries after this point can't be trusted until it's explained." Card chip "Problem found".
  - cooldown (429): info text "Verified moments ago. You can check again in {n} s." with the button disabled until then; running elsewhere (409): "A check is already running for this business." Neither is an error.
- **Filters** (`AuditFiltersBar`, all in the URL: `?from&to&group&actorType&actor&conversation`):
  - Date range: two `field` date inputs "From" / "To" (SGT days; default none = all time, quick chips "Today" · "Last 7 days" · "Last 30 days"). `to` before `from` → field error "End date must be on or after the start date".
  - "Type" `select`: All types + the nine groups.
  - "Who" `select`: Anyone · Assistant · Team (any member) · each member by name · System · Visitor · KakiAgent support (maps to `actorType`/`actor`).
  - Conversation: no field; when `?conversation=` is set, a removable `chip` "Conversation {first 8 chars of ID}" with × "Clear conversation filter".
  - "Clear filters" `link` when any filter is set. Phones: filters collapse behind a `secondary` "Filters (2)" button opening a bottom sheet with the same fields and "Show results".
- **List** (`AuditTable`; `table` ≥ 768, stacked `list` below): columns When · Who · What · About. "What" = event text, then the code in caption mono text-secondary. "About" = the primary subject as words ("Conversation", "Fact", "Lead", "Member" …) with a short ID in mono. Each row is one button (whole row) opening the detail; `aria-label` "{event text}, {who}, {when}". Phones: line 1 event text + time, line 2 who · about. Newest first; "Load more" `secondary` (busy "Loading…").
- **Entry detail** (`EntryDetail`, `slide-over` ≥ 768, full-height sheet below; title "Entry #4,512"): definition list When (full SGT time) · Who · What (text + mono code) · About (every subject: type label + mono ID; conversation → `/inbox/:id`, lead → `/leads/:id`, fact → `/knowledge/facts/:id`, approval → `/approvals/:id`, contact → `/contacts/:id`; others not linked) · Details (payload as a key/value list: keys humanised from snake_case, values as text, nested objects as indented JSON in mono; empty → "No details") · Personal data (state words; never the data) · Chain: "Hash" and "Previous hash" in mono, wrapped, each with a `icon-button` copy ("Copied" toast). Close returns focus to the row.
- **Export** (design.md §4.10): "Export" → `confirm-dialog` "Export audit log" with radio group Format "CSV (spreadsheets)" · "JSON (for auditors; includes every chain field)" (default CSV), a line "{Filters: Last 30 days · Knowledge}" or "All entries", and body "The file has IDs and codes, not customers' personal data." Buttons "Export" (primary, busy "Exporting…") / "Cancel". Then the `reauth-dialog` if needed (FEAT-006). Success: download `audit-log-2026-11-18.csv` and toast "Audit log exported. This export is recorded in the log." and the list refetches. 413: dialog error `alert` "That's more than 100,000 entries ({count}). Choose a shorter date range." Other failure: "Couldn't export. Try again."
- **States:** loading (`skeleton` rows, verify card skeleton); empty with no filters ("No entries yet", only possible on a brand-new business); filtered-empty (`empty-state` "No entries match these filters", action "Clear filters"); error (`error-state` "Couldn't load the audit log" + Try again); detail not found ("This entry doesn't exist." in the panel); permission (Agent).
- **No live updates:** refetch on window focus, after a verify and after an export.

## SCR-APP-014 — Inbox (partial)

Context sidebar (`ContextSidebar`), last section, Owner and Admin only: `link` "View audit log" (list icon) → `/settings/audit?conversation=<id>`. Agents don't see it.

## Tokens used

`--color-success-soft`/`-fg`, `--color-danger-soft`/`-fg`, `--color-warning-soft`/`-fg`, `--color-info-soft`/`-fg`, `--color-bg-surface`, `--color-bg-subtle`, `--color-border-default`, `--color-text-primary`, `--color-text-secondary`, `--color-text-link`, `--font-mono` (hashes, IDs, codes), `--radius-md`, `--radius-lg`, `--space-2`…`--space-6`, `--size-control-md`, `--type-caption-size`, `--type-body-sm-size`.

## Gaps and escalations

- design.md has no `date-range` component; two date `field`s plus quick chips use existing parts. If a shared range picker is wanted later, it's a design.md addition.
- Payload values are shown as stored (IDs, codes, masked strings); per-event readable sentences ("Price changed from S$12 to S$14") are a follow-up, not in GOV-02.
