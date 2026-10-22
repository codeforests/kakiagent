# UI Design: FEAT-012 — Website crawl with attestation, extraction to review, source status and retry

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E2) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-023 (new), SCR-APP-024 (new), SCR-APP-007 (new, partial: the website part, no wizard frame), SCR-APP-028 (extended: provenance) · Mode: per-feature · Status: Verified · Date: 2026-10-21

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so every screen here is a code-native spec. SCR-APP-023, -024 and -007 have no manifest entry yet; SCR-APP-028 keeps `feature: FEAT-022` and gains this file as a spec locator. Every value comes from design.md and `tokens.json`; no new component or token is introduced.

## Cross-screen

- **Knowledge tabs.** `/knowledge` gains an underline tab row (design.md §4.4 `tabs` styling) under the page head: **Facts** (`/knowledge`) · **Sources** (`/knowledge/sources`). They are route links in a `nav` with `aria-label="Knowledge"` and `aria-current="page"` on the active one, not a Radix tablist, because each is its own URL. The Sources tab shows a danger count pill when any source is failed ("1").
- **Nav badge (KB-12 in-app alert).** The sidebar and More entry "Knowledge" show the same failed count as a danger pill (`nav-item` count badge), from `GET /api/v1/kb/sources`, fetched with the shell's other counts on load and on every Sources poll.
- **Source states → `status-badge`:** Queued (neutral, clock icon) · Processing (info, spinner icon) · Ready (success, check icon) · Failed (danger, alert icon). Text always present.
- **Stage names** (shown while queued or processing): crawl → "Reading pages", extract → "Finding facts", promote → "Saving facts".
- **Failure reasons** (`failure` → text):
  - `no_pages`: "No page could be read. robots.txt or the domain limits excluded every page."
  - `site_unreachable`: "We couldn't reach the site. Check the address and that the site is online."
  - `extraction_unavailable`: "Finding facts failed after several tries. Your pages are saved; try again in a few minutes."
  - `internal`: "Something went wrong on our side. Try again; if it fails again, contact support."
- **Page reasons** (`status`/`reason` → text): included "Read"; excluded robots "Excluded: blocked by robots.txt"; off_domain_redirect "Excluded: redirects to another site"; not_html "Excluded: not a web page"; duplicate "Excluded: same content as another page"; failed timeout "Failed: took too long to load"; http_error "Failed: the site returned {httpStatus}"; blocked_address "Failed: address not allowed"; load_error "Failed: couldn't load"; skipped plan_limit "Skipped: plan limit".
- **Polling (technical design D6):** while any shown source is queued or processing, the screen refetches every 2 s; it stops when none is, when the tab is hidden (`visibilitychange`), and on unmount. Status changes are announced in a polite live region ("kakibakery.sg is ready. 38 facts need review."), never every count change.
- **Dates** in SGT, "21 Oct 2026, 2:30 pm" (NFR-10).

## SCR-APP-023 — Sources

- **Strategy and source:** code-native (this section). Route `/knowledge/sources`. Owner, Admin (`kb.manage`); others get the SCR-APP-059 no-permission page.
- **Composition:**
  - Page head: title "Knowledge", the tabs, then a section head "Sources" with the `primary` button "Add website" (→ `/knowledge/sources/new`). Help text: "Websites you add are read page by page. The facts we find wait for your review before your assistant uses them."
  - A `list` of `source-row`s (design.md §4.6), newest first. Each row is one link to SCR-APP-024 except its Retry button:
    - Globe icon, name (the domain), and under it in caption text-secondary: "Added 21 Oct 2026, 2:30 pm".
    - State chip. While processing: the stage name and a determinate `progress` bar: crawl uses `pagesIncluded + pagesExcluded + pagesFailed` of `pagesFound` (or of `pageLimit` when larger is unknown), extract uses `pagesExtracted / pagesIncluded`, promote is indeterminate.
    - Counts: Ready "38 facts · 38 need review · 31 pages read"; Ready with no facts "No facts found · 12 pages read"; Failed: the reason text inline in danger caption, then a `secondary sm` "Retry" button.
- **Content and data mapping:** `GET /api/v1/kb/sources`; Retry is `POST /api/v1/kb/sources/:id/retry` `{ version }`.

### default
The list as above. "Review facts" `link` on a ready row with facts needing review goes to `/review` (FEAT-013 placeholder until then).
### loading
Three skeleton rows in the row layout.
### empty
`empty-state`: globe icon, "No sources yet", "Add your website and we'll find your products, prices and policies for you to review.", [Add website].
### error
`error-state`: "We couldn't load your sources." [Try again].
### processing
Rows in Queued or Processing show the stage and progress and poll (cross-screen). A queued row after a provider error shows "Queued · Finding facts · waiting to retry" (UC-03 5c).
### failed
The reason and Retry. While the retry request runs, the button shows its loading state; on success the row turns Queued and the live region says "Retrying kakibakery.sg."; 409 refreshes the list with the toast "This source has already changed."; another failure shows a danger `alert` above the list: "We couldn't retry just now. Nothing was changed."
### permission
Agents never see Knowledge (ux-foundations §IA); a direct URL gets SCR-APP-059.

- **Responsive notes:** below 768 px each row stacks: name and chip on one line, counts or reason under it, Retry full width under that (44 px).
- **Decisions:** no re-crawl schedule control yet: KB-08's schedule is FEAT-020, so the row has no schedule text rather than a disabled control (inventory "re-crawl schedule" recorded as a gap).

## SCR-APP-007 — Add your sources (website part)

- **Strategy and source:** code-native (this section). The form is one component, `AddWebsiteForm`, shown at `/knowledge/sources/new` (page head "Add website", back link "Sources") and at `/setup/sources` (page head "Add your sources", step text "Step 2 of the setup", and a `ghost` "Skip, I'll add files later" that goes to `/`, UC-03 4a). FEAT-035 adds the wizard frame; FEAT-015–017 add files, spreadsheets and chat exports to this screen.
- **Composition:**
  1. `field` "Website address (required)", `text-input` type `url`, placeholder "e.g. https://kakibakery.sg", help "We read pages on this domain only."
  2. Disclosure `ghost sm` "Add subdomains" revealing a `textarea` "Other subdomains to include", help "One per line, e.g. shop.kakibakery.sg. Only subdomains of your domain."
  3. `checkbox` (required): "I own this website or am authorised to use its content for my business's assistant." Under it in caption: "We record this confirmation. We follow robots.txt and don't follow links to other sites." (KB-13, D9)
  4. Plan line in caption text-secondary: "Your plan reads up to {pageLimit} pages." (the limit from config until FEAT-067; the API returns it on the source, the form shows the configured default from `GET /api/v1/kb/sources`' `pageLimit` field).
  5. `primary` "Start reading pages". It stays enabled; submitting without the checkbox shows the field error (below), so the rule is announced, not silently disabled.
- **Content and data mapping:** `POST /api/v1/kb/sources` `{ kind: 'website', url, subdomains, attested }`. On 201 → SCR-APP-024 for the new source, toast "Reading kakibakery.sg. You can leave this page; we'll keep going."

### default
The empty form.
### validation
Per design.md §4.2 (blur and submit; error summary alert on submit):
- empty or malformed URL: "Enter the website address, like https://kakibakery.sg";
- checkbox not ticked (and 400 `attestation_required`): "Confirm you own or are authorised to use this website";
- 400 `url_not_public`: "This address can't be read from the internet. Use your public website address.";
- 400 on subdomains: "Each subdomain must end in .{domain}, like shop.{domain}".
### submitting
The button's loading state; fields read-only.
### exists
409 `source_exists`: warning `alert` "You've already added {domain}." with a `link` "Open it" to that source (the list is refetched to find its ID).
### error
Other failures: danger `alert` "We couldn't start reading your site. Nothing was saved." with the form kept.

- **Responsive notes:** single column, max width 560 px; full-width button below 640 px.

## SCR-APP-024 — Source

- **Strategy and source:** code-native (this section). Route `/knowledge/sources/:id`.
- **Composition:**
  - Back link "Sources". Title: the domain; under it the start URL as an external `link` ↗ and "Confirmed by you on 21 Oct 2026, 2:30 pm" (attestation). State chip on the right of the title.
  - **Status card** (`card`): while busy, the stage name, `progress` and counts ("Reading pages · 18 of 32"); ready, three `kpi`-style figures without deltas: "Facts found 38" (link to `/knowledge?sourceId=…`), "Need review 38" (link to `/review`), "Pages read 31"; failed, the reason in a danger `alert` with `secondary` "Retry".
  - **Pages** section: a `select` filter "All pages (40) · Read (31) · Excluded (5) · Failed (1) · Skipped (3)", then a `table` with columns Page (title, or the URL path when untitled, and the path in caption under it; the full URL as an external link), Result (the page reason text, with a chip: Read success, Excluded neutral, Failed danger, Skipped warning), Facts (number, tabular; "—" when not read).
  - When skipped pages exist, an info `alert` above the table: "{n} pages were skipped because your plan reads up to {pageLimit} pages." (UC-03 5b; the upgrade link arrives with FEAT-067, so no link yet.)
  - Footer: `danger-ghost` "Delete source…".
- **Content and data mapping:** `GET /api/v1/kb/sources/:id`; Retry as on SCR-APP-023; delete `DELETE /api/v1/kb/sources/:id?version=`.

### processing
The status card shows progress; the table fills as pages finish (poll); rows are appended without moving focus.
### ready
As above. With zero facts: info `alert` "We didn't find facts on these pages. Add files or type facts in by hand." with a `link` to `/knowledge/facts/new`.
### failed
The reason, Retry, and whatever pages were listed.
### loading, error, not-found
Skeleton status card and five skeleton rows; `error-state` "We couldn't load this source." [Try again]; 404 → "This source doesn't exist or was deleted." with a link back to Sources.
### delete-confirm
`confirm-dialog`: title "Delete {domain}?"; body "Its {facts} facts will be deleted too, including any you approved or edited, and your assistant stops using them straight away. The page list is removed. This can't be undone."; `secondary` "Cancel" (initial focus), `danger` "Delete source". In progress: loading, Esc and scrim disabled. 204 → Sources, toast "Source deleted." 409 `invalid_state`: alert in the dialog "This source is still being read. Try again when it's finished."; 409 `version_conflict`: "This source changed since you opened it. Close this and try again."; 404 → Sources with toast "This source was already deleted."
### filtered-empty
"No pages match this filter." [Show all pages].

- **Responsive notes:** below 768 px the table is a stacked list (page title, then path, then the result chip and facts count); the status card figures stack.
- **Decisions:** the "changes since the last crawl" diff of the inventory belongs to FEAT-020 (KB-08), recorded as a gap. Pages are not paginated: the response is bounded (plan cap plus ≤ 2,000 skipped), and the filter covers the long lists.

## SCR-APP-028 — Fact (extended: provenance)

- **Strategy and source:** code-native (this section, on top of FEAT-011's and FEAT-022's). Routes unchanged.
- **Composition change:** for a fact with `provenance`, a **Source** section after the form fields (view and edit modes): the source passage well (design.md §4.6: subtle fill, 3 px border-strong left edge, body-sm) holding the `quote`, then caption text: "From {title or path} on {domain}" as an external `link` ↗ to the page URL, "· {confidence}% confidence" (below 70% in warning text with an icon), and a `link` "Open source" to SCR-APP-024. Manual facts show nothing new. The quote is shown as text, never as HTML.
- **States:** unchanged; the section renders in every state that shows the fact.
- **Decision:** the passage shows the quote alone rather than the page around it. FEAT-013's review card (design.md `fact-review-card`) highlights the span inside its context; this screen only answers "where did this come from".

## Manifest and gaps

- New entries SCR-APP-023, SCR-APP-024, SCR-APP-007 (`feature: FEAT-012`, `code-native`, conformance pass). Gaps: 023 "re-crawl schedule (FEAT-020)"; 024 "changes since last crawl (FEAT-020), a file's extraction (FEAT-015)"; 007 "files, spreadsheets, chat exports (FEAT-015..017), wizard frame (FEAT-035)".
- SCR-APP-028: the gap "sources (FEAT-012)" is closed; review interval (FEAT-018) and version history (FEAT-021) remain.
- No design-system escalation: tabs, `source-row`, `progress`, the passage well, `confirm-dialog` and the badges are all in design.md.
