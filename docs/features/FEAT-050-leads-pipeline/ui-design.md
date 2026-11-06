# UI design: FEAT-050 — Leads list, pipeline, scoring and CSV export

> Screens: SCR-APP-032 (new), SCR-APP-033 (new; "consent withdrawn" is FEAT-051), SCR-APP-043 (partial: Qualification card), SCR-APP-014 (partial: score in the sidebar) · Contracts: [technical-design.md](technical-design.md) §3 · Strategy: code-native (design.md, tokens.json; no design tool connected)
> Status: designed · 2026-11-06

**Shared words.** Score chips: **Hot** (`--color-danger-soft` / `-fg`, flame icon), **Warm** (`--color-warning-soft` / `-fg`, sun icon), **Cold** (`--color-info-soft` / `-fg`, snowflake icon), **Not scored** (neutral, dash icon). Status chips as FEAT-049's sidebar: New (info), Contacted (accent), Won (success), Lost (neutral). Text always present, never colour alone (design.md `chip`). Reasons, in the order the server returns them:

| Code | Text |
|---|---|
| `keyword` | Mentions "{detail}" |
| `budget_met` | Budget meets your S${detail} minimum |
| `budget_below` | Budget below your S${detail} minimum |
| `wants_to_order` | Asked for a quote or to order |
| `both_contacts` | Left phone and email |
| `need_given` | Said what they need |
| `timing_given` | Said when they need it |
| `returning` | Came back |

Points show as "+2" in text-secondary after each reason on the Lead page only; the list shows the chip alone. Marketing flag: "Offers: Yes · 18 Nov 2026, 2:30 pm" / "Offers: No" / "Offers: Not asked" (`MarketingFlag`; same words as the FEAT-049 sidebar).

## SCR-APP-032 — Leads

`/leads`, every member. Nav item "Leads" (sidebar and the More sheet on mobile) already exists.

- **Header:** `page-title` "Leads"; lede "People who left their details in chat or on your contact form." Right of the title (below it on phones): `secondary` button "Export CSV" (download icon), Owner and Admin only; Agents see no button.
- **Tabs** (`tabs`, in the URL `?status=`): "Open" (New + Contacted, default) · "New" · "Contacted" · "Won" · "Lost" · "All", each with its count in a caption pill. On phones the tabs scroll horizontally inside their own row (no page scroll).
- **Score filter:** a `select` "Score: Any · Hot · Warm · Cold" beside the tabs (`?score=`), label visible ("Score").
- **Rows** (`table` ≥ 768; stacked `list` below), each row one link to `/leads/:id`: Name (or "No name given"), then email · phone (text-secondary, phone `+65 9123 4567`), "What they need" first line (truncate with ellipsis, full text in the link's accessible name is not needed), Score chip, Status chip, Source caption ("Chat" / "Contact form"), Updated ("2:14 pm" / "Yesterday" / "18 Nov"). Mobile: name + score chip on line 1, email · phone line 2, status chip + updated on line 3. Table header columns: Name, Contact, Need, Score, Status, Updated.
- **Order:** newest update first. "Load more" (cursor) at the bottom, `secondary`, busy "Loading…".
- **Export** (design.md §4.10 sensitive action): Export CSV → `confirm-dialog` "Export {n} leads?" where n is the current tab's count with the score filter applied (the dialog notes "Filters: Open · Hot" when filtered); body: "The file includes names, phone numbers and emails. Keep it safe and delete it when you're done." and an info `alert` "The Do Not Call Registry applies before you call or text anyone for marketing. Check the Offers column." Buttons "Export" (primary, busy "Exporting…") and "Cancel". Then the `reauth-dialog` if needed (FEAT-006). On success the browser downloads `leads-2026-11-18.csv` and a toast says "Exported {n} leads. This export is recorded in the audit log." Errors: 413 → danger `alert` in the dialog "That's more than 10,000 leads. Pick a status or score to export fewer."; other failures → toast "Couldn't export. Try again."; re-auth cancelled → nothing (dialog closes, focus back to Export CSV). Focus returns to the Export CSV button after the dialog closes.
- **States:** loading (`skeleton` rows), empty Open with no leads at all (`empty-state` icon leads, "No leads yet", "When a visitor leaves their details, they appear here.", action "Check lead settings" → `/settings/leads`), empty filtered ("No {Hot} leads in {Open}", action "Clear score filter"), error (`error-state` "Couldn't load leads" + Try again), exporting (dialog busy).
- **No live updates** (technical-design D6): refetch on window focus and after a status change.

## SCR-APP-033 — Lead

`/leads/:leadId`, every member. Back link "Leads" (keeps the list's tab and filter). Max width 960; two columns ≥ 1024 (main 2/3, aside 1/3), one column below.

- **Header:** `h1` the name (or "No name given"), Score chip, Status chip. Owner and Admin: a `menu` button "Status: {New}" (chevron) with the four statuses as `menuitemradio`, the current one checked; choosing one saves at once (not optimistic: the button shows "Saving…" and is busy) and toasts "Marked as Contacted". Agents see the chips only and no menu.
- **Details card:** "Phone", "Email" (each with the copy icon button from FEAT-049's sidebar, `CopyRow`), "What they need" (full text, preserves line breaks), "Budget", "Preferred date or time", "Source" (Chat / Contact form), "Left details {captures} times" when captures > 1, "First captured 18 Nov 2026, 2:30 pm", "Updated …". Empty values read "Not given" in text-secondary.
- **Score card:** title "Score: Hot · 7 points"; the reasons list with points; footer caption "Hot is 5 points or more, warm 3 to 4. Change what counts on Lead settings." with the link to `/settings/leads#qualification` (Owner/Admin; Agents get the sentence without the link). Not scored: "Not scored yet. It's scored the next time they leave details or when you save lead settings."
- **Consent card** (aside): one entry per record, newest first: "Agreed to be contacted" / "Chose not to share details" / "Agreed to offers" / "Declined offers", the time, "Website chat" or "Contact form", and a disclosure (`<details>`, summary "Wording shown (version 3)") revealing the exact text. FEAT-051 adds "Consent withdrawn" here and a danger `alert` at the top of the page.
- **Conversations card** (aside): up to 20 rows "18 Nov 2026 · Closed" linking to `/inbox/:id`; none (contact form) → "Left on the contact form, no conversation."
- **Status errors:** 409 `stale` → warning `alert` under the header "Someone else changed this lead. It's now {Won}." and the page shows their version; 409 `open_lead_exists` → warning `alert` "This person already has an open lead. Close that one first." with a link "Open their lead" when the server names it (else just the text); 403 → toast "You can't change leads." ; other → toast "Couldn't save. Try again."
- **States:** loading (skeleton of the cards), not found (`empty-state` "This lead doesn't exist or was deleted", action "Back to leads"), error (`error-state` + Try again).

## SCR-APP-043 — Leads and consent (partial: Qualification card)

New card between "Lead fields" and "Consent", `id="qualification"`, same one Save for the page.

- Title "Qualification", body "Decides which leads are hot, warm or cold. Your assistant adds points for asking for a quote, leaving phone and email, and saying when."
- "Keywords that make a lead hot" — the list-with-Add pattern of Rules' topics (`TopicListEditor`, here `KeywordListEditor`): a `text-input` "Add a keyword" + "Add" button, each keyword a row with a Remove icon button ("Remove wedding"); max 20; help "Matched in what the visitor says they need. For example: wedding, corporate, 婚礼."
- "Minimum budget" — `text-input` with an "S$" prefix, `inputmode="numeric"`, optional; help "Leads whose budget meets this get extra points. Leave empty to ignore budget."
- Validation (field errors + the page's `ErrorSummary`): empty keyword "Enter a keyword"; duplicate "You already added {kw}"; > 40 chars "Keep keywords to 40 characters"; 21st "You can add up to 20 keywords"; budget not a whole number "Enter a whole number of dollars"; out of range "Enter an amount from S$1 to S$10,000,000".
- Saved: toast "Lead settings saved" and, when the server rescored, "Lead settings saved. {n} open leads rescored."
- F&B tenants start with the template's keywords shown as unsaved defaults.

## SCR-APP-014 — Inbox (partial)

Sidebar Lead section: the Score chip after the status chip (or "Not scored"), and a link "Open lead" → `/leads/:id` under the consent lines.

## Tokens used

`--color-danger-soft`/`-fg`, `--color-warning-soft`/`-fg`, `--color-info-soft`/`-fg`, `--color-success-soft`/`-fg`, `--color-accent-soft`, `--color-bg-surface`, `--color-bg-subtle`, `--color-border-default`, `--color-text-primary`, `--color-text-secondary`, `--color-text-link`, `--radius-md`, `--radius-lg`, `--space-2`…`--space-6`, `--size-control-md`, `--size-control-lg`, `--type-caption-size`, `--font-weight-medium`; points and counts use `font-variant-numeric: tabular-nums`.

## Gaps and escalations

- FEAT-051: "Consent withdrawn" on SCR-APP-033 (and the CSV exclusion). FEAT-053: webhooks on SCR-APP-043.
- design.md has no score-chip alias; Hot/Warm/Cold use the status aliases above (danger/warning/info). If Ken prefers a neutral hot chip, it's a token-alias change only.
- No board (columns) view (technical-design D5).
