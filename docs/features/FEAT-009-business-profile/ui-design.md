# UI Design: FEAT-009 — Business profile, hours, SG holidays, F&B industry template

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E1) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-044 (new), SCR-APP-006 (p: the profile step without the wizard frame) · Mode: per-feature · Status: Verified · Date: 2026-10-21

No design tool is connected and the manifest policy is `code-native`, so this document is the design. SCR-APP-044 and SCR-APP-006 get their first manifest entries. Everything uses design.md §4 components (`field`, `text-input`, `select`, `checkbox`, `toggle`, `hours-editor`, `card`, `list`, `alert`, `toast`, `button`); the `hours-editor` is built here for the first time, following §4.2. No token, component or variant is added.

## SCR-APP-044 — Business profile

- **Strategy and source:** code-native. Route `/settings/business-profile`, from the Settings index ("Business and team" → "Business profile", now a link). Back link "Settings" above the h1 on every width, as SCR-APP-041.
- **Composition:** dashboard shell; back link; h1 "Business profile"; lede "Your details and opening hours. Your assistant uses your hours to tell visitors when you're open."; a single column (max 720 px) of cards:
  1. **Your business** (`card`, h2): `field` "Business name (required)"; `field` "UEN", placeholder "e.g. 201912345K", help "Your Unique Entity Number from ACRA. You can add it later."; `select` "Industry" (Food and beverage · Retail · Beauty and wellness · Education and tuition · Professional services · Home services · Other; first option "Choose an industry"), help "Food and beverage comes with suggested questions to answer."; `checkbox` "GST-registered", help "Prices are quoted with GST when you're GST-registered."
  2. **Contact** (`card`, h2): `field` "Contact email", type email; `field` "Contact phone", placeholder "e.g. 9123 4567", help "A Singapore number. Visitors don't see these yet." A checkbox group "Languages your customers use" (English · 中文 · Bahasa Melayu · தமிழ், each label with its `lang`), help "Your assistant replies in the visitor's language either way."
  3. **Opening hours** (`card`, h2, the `hours-editor`): a `toggle` "Set opening hours" (off = no hours: "Without hours, your assistant doesn't tell visitors when you're closed."). When on, one row per day Mon–Sun: the day name, a `toggle` labelled "Open on {day}", and when open its time ranges — two `<input type="time">` (labels "Opens"/"Closes", visually hidden on desktop with the day in the accessible name: "Monday opens") joined by "to", a "Remove" ghost button on the second and later ranges, and "Add hours" (ghost, up to four ranges). Closed days show "Closed" in text-secondary. Under Monday, a ghost button "Copy Monday to Tue–Fri". A close of 00:00 means midnight; help under the grid: "Times are Singapore time. Close at 00:00 for midnight."
  4. **Public holidays and closures** (`card`, h2): `toggle` "Open on public holidays", help "With this on, you keep your usual hours on public holidays." Then the `list` "Coming public holidays" of `calendar.holidays`: each row "Fri 25 Dec 2026 · Christmas Day" with a `checkbox` "Open" whose state starts from the toggle; changing it records an exception. Caption under the list: "Public holidays are listed through 2027." Then "Other closures": rows of `date` input (min today), `field` "Reason (optional)" (placeholder "e.g. Staff day off", 60 characters) and "Remove", and a secondary "Add a closure" button.
  5. **Suggested questions** (`card`, h2 "Suggested questions for food and beverage", only when the saved industry has a template): lede "Customers often ask these. Add your answers so your assistant can reply." A `list` of the suggestions: question (body, 500), hint (caption, text-secondary), and on the right "Add answer" (secondary link button) or a success `status-badge` "Added". When the owner has changed the industry but not saved: the card shows "Save to see the suggested questions for this industry." and no list.
  6. **Sticky action bar**: `Save changes` (primary), `Cancel` (ghost, resets the form).
- **Content and data mapping:** load `GET /api/v1/settings/business-profile` → fields from `profile`, the holiday list from `calendar`, the card from `template`. Save `PUT` with every field and the loaded `version`; the holiday checkboxes become `exceptions` only where they differ from the toggle; empty texts → null; the phone shown as `+65 XXXX XXXX` after load.
- **Conformance:** pass. One `primary` per region. Labels say what "on" means. The day toggles and holiday checkboxes have accessible names with the day.

### default
Fields filled from `profile`; `Save changes` disabled until something changes.
### loading
Skeleton blocks in the cards (`aria-busy="true"`).
### validation
On blur and on submit with the contract schema. On submit with errors, the danger `alert` at the top lists each as a link to its field and takes focus. Messages: "Enter your business name", "UEN must be 9 or 10 characters, like 201912345K", "Enter an email address, like hello@example.com", "Enter a Singapore number with 8 digits, like 9123 4567", "Choose at least one language", "Monday: opening time must be before closing time", "Monday: hours overlap", "Choose a date for each closure", "Each date can only be listed once", "A closure can't be in the past". An hours error links to that day's first time input.
### saving
`Save changes` shows "Saving…"; fields are read-only until the response.
### saved
Toast "Business profile saved. Your assistant uses it from the next reply."; the form shows the saved values (and the suggested questions if the industry now has a template).
### conflict
On 409, warning `alert` "Someone else saved this profile while you were editing. Reload to see their version, then make your change again." [Reload].
### error
Load failure: `error-state` "We couldn't load your business profile" · "Nothing you saved is lost." · [Try again]. Save failure other than 400/409: danger `alert` "We couldn't save your profile just now. Nothing was changed."
### permission
For the `agent` role: "Only the Owner or an Admin can change the business profile."

- **Responsive notes:** below 768 px each day row wraps: day and toggle on one line, ranges below, full-width time inputs (44 px touch height). Holiday rows wrap the checkbox to the right of the date. The action bar sits above the tab bar.
- **Decisions:**
  - **Native time inputs.** Driver: they give the platform's accessible time picker and keyboard entry, and show 12- or 24-hour by the browser's locale; the stored value is always `HH:MM`. Rejected: a custom select of 96 quarter-hours, which is slow on a phone.
  - **Holiday choices as checkboxes under one toggle.** Driver: design.md §4.2 ("an 'open on this day' option per holiday"); most owners set the rule once and flip one or two days.
  - **Suggestions only after Save.** Driver: they depend on the saved industry and the KB; showing them for an unsaved choice would link to a FAQ form while the profile change could still be cancelled.

## SCR-APP-006 — Wizard · Business profile (p)

Route `/setup`. The same form as SCR-APP-044 with: no back link; h1 "Tell us about your business"; lede "This is the first step of setting up your assistant. You can change any of it later in Settings."; no suggested-questions card (it appears on the profile screen and is linked from the toast); the primary button "Save and continue". After a successful save it goes to `/knowledge` with the toast "Business profile saved. Next, add what your assistant should know." All other states as SCR-APP-044. FEAT-035 adds the wizard frame (steps, progress, resume) around it.

## Fact form (SCR-APP-028, prefill only)

`/knowledge/facts/new?type=faq&question=…` opens the form with the type FAQ and the question filled in; both stay editable. No visual change.

## Escalations and open items

- None filed. The manifest gains SCR-APP-044 and SCR-APP-006 (partial, `gaps: ["wizard frame (FEAT-035)"]`).
