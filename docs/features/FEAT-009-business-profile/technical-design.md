# Technical Design: FEAT-009 — Business profile, hours, SG holidays, F&B industry template

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E1 Identity and tenancy) and §5 (M2, first) · Epic: E1
> Implements: ONB-03, ONB-06 (p: the F&B template's suggested FAQs only; FEAT-054 adds its boundary rules and FEAT-049 its lead fields; other industries are M7) · Also serves: AGT-09 (p: the owner's hours and closures drive the after-hours behaviour FEAT-023 built), KB-15 (p: the GST flag is now set by the owner) · Binding NFRs: NFR-10 (SG time zone, holidays, phone and UEN formats; plan §7), NFR-11 (codes only in audit and logs), NFR-09 (WCAG 2.1 AA), NFR-19 (validation and data-view states)
> Realizes: UC-03 main flow steps 1–3 (profile, UEN check, SG holidays preloaded, the industry template's suggested FAQs) and alternate 1a in part (the profile is saved on every Save)
> Screens: SCR-APP-044 (Business profile), SCR-APP-006 (p: the profile step at `/setup`, without the wizard frame), designed in [ui-design.md](ui-design.md)
> Status: Verified (self-check §9) · Date: 2026-10-21

## 0. Sequencing note: M1.5 deferred (owner decision, 2026-10-21)

Plan §5 says the M1.5 real-model gate blocks M2. On 2026-10-21 the owner decided to start FEAT-009 before M1.5, because this feature has no model dependency: it is a settings screen, a schema change and a deterministic change to the opening-hours maths. M1.5 is deferred, not dropped, and **must run before FEAT-012** (the website crawl), the first M2 feature that calls a model (Bedrock extract and embed). Nothing in this feature's acceptance depends on a real model, so its report carries no "real-model check pending" items. Plan §5 is not edited (it is signed off); the decision is recorded here and in the acceptance report.

## 1. Intent

The business profile is where an owner tells KakiAgent who the business is and when it is open. Today `business_profiles` holds only the GST flag and FEAT-023's hours, both set by the dev seed, and `tenants.name` is set once at sign-up. FEAT-009 gives the Owner and Admins one screen, SCR-APP-044, to set the business name, UEN (format-checked), industry, contact email and phone, default languages, GST registration, weekly opening hours and holidays, and reuses the same form as the wizard's first step (SCR-APP-006, partial: FEAT-035 adds the wizard frame). The SG public-holiday calendar is preloaded: the owner sees the coming holidays and chooses for each whether the business opens, and can add its own closures (a staff day off, a renovation). Those choices reach the agent, so the after-hours notice and the hours slots follow them. Choosing "Food and beverage" offers the F&B template's suggested FAQs: questions bakeries, cafés and caterers are asked often, each with a one-click start on a FAQ fact that the owner answers and saves. It comes first in M2 because the crawl (FEAT-012) and the KB review (FEAT-013) assume a profile exists, and the readiness check (FEAT-035) requires one.

## 2. Codebase context

Surveyed on `main` at `6d9f424` (after FEAT-025, PR #16).

- **Schema:** migrations 0000–0017. `business_profiles` (0002, 0012) holds `tenant_id`, `gst_registered`, `hours jsonb` (the `WeeklyHours` shape, FEAT-023 §4), `open_on_public_holidays` and timestamps, with forced RLS (0003). Every tenant has a row: FEAT-005's `createWorkspace` inserts it and the dev seed upserts it. The dashboard role has only `SELECT` on it and `SELECT` on `tenants` (0001); `tenants.name` is the business name everywhere (prompt, disclosure, `visitor_tenant_state()`). There is no `holidays` table.
- **Tenancy:** `hours.ts` has `WeeklyHours`, `hoursOn(hours, openOnPublicHolidays, day)` and `openStatus(hours, openOnPublicHolidays, now)` with `closedForHoliday`; `sg-holidays.ts` holds the 2026–2027 MOM days as a set (names only in comments), `SG_HOLIDAYS_COVER_THROUGH = 2027`, and says "FEAT-009 adds tenant-specific closures and openings on top of this calendar". `assistant.ts` is the settings pattern: whole document, `version`, `SettingsConflictError`, an audit entry with changed field codes.
- **Agent:** `turn.ts` calls `openStatus(tenant.hours, tenant.openOnPublicHolidays, wall)`; `hours-text.ts` builds the system slots (`hours.today` says "closed (public holiday)" when `closedForHoliday`) and the cached hours lines of the prompt from the weekly hours only.
- **api:** `settings.ts` registers the Assistant routes (`settings.manage`, `withTenant(dashboardDb, …)`, Zod parse in and out, `SettingsConflictError` → 409 `version_conflict` in `app.ts`). `facts.ts` holds `ForbiddenError`.
- **Dashboard:** `/settings` lists "Business profile" as "Coming soon"; `/setup` is a placeholder naming FEAT-009. `pages/assistant.tsx` is the form pattern (validation from the contract schema on blur and submit, error summary, sticky Save, conflict alert, toast held by the page). `pages/fact.tsx` creates FAQ facts; manual facts are approved on save (FEAT-011).
- **Divergences (reality wins):** the plan's `holidays` table is kept, but as the tenant's exceptions to the SG calendar and its own closures; the calendar itself stays code data (FEAT-023 D3, D4 here). ONB-06's template "preloads suggested FAQs"; here the suggestions are offered, not written into the KB, because a FAQ needs the owner's answer before it may reach visitors (D5).

## 3. API contracts

All in `packages/contracts`. Both routes need a session and `settings.manage` (Owner, Admin).

### 3.1 Shapes

```ts
Industry = 'fnb' | 'retail' | 'beauty_wellness' | 'education' | 'professional_services' | 'home_services' | 'other'
ProfileLanguage = 'en' | 'zh' | 'ms' | 'ta'

/** ACRA formats (D2): 8 digits + letter; year + 5 digits + letter; T/S/R + yy + 2 letters + 4 digits + letter. Upper-cased, spaces removed. */
Uen = string → normalised | null ('' → null)
/** SG numbers (D3): 8 digits starting 3, 6, 8 or 9, with or without +65, spaces or hyphens. Stored as '+65XXXXXXXX'. */
SgPhone = string → normalised | null
ContactEmail = email (≤ 254) | null

TimeOfDay = 'HH:MM' (00:00–23:59); close may also be '24:00'
HoursInterval = { open: TimeOfDay, close: TimeOfDay | '24:00' }       // open < close
WeeklyHoursInput = { mon..sun: HoursInterval[] (0–4, sorted, not overlapping) }   // same rules as tenancy's WeeklyHours

HolidayException = {
  day: 'YYYY-MM-DD',              // a Singapore day, today or later, within 2 years
  kind: 'open' | 'closed',        // open: usual hours on an SG public holiday; closed: closed all day
  label: string(trim, ≤ 60) | null,
}

BusinessProfileBody = {
  version: int ≥ 1,               // the version read
  name: string(trim, 1..120),     // tenants.name (D1)
  uen: Uen, industry: Industry | null,
  contactEmail: ContactEmail, contactPhone: SgPhone,
  languages: ProfileLanguage[] (1–4, distinct),
  gstRegistered: boolean,
  hours: WeeklyHoursInput | null, // null = not set: no after-hours behaviour (FEAT-023)
  openOnPublicHolidays: boolean,
  exceptions: HolidayException[] (≤ 60, distinct days),
}
// Refinements: kind 'open' only on an SG public holiday and only when openOnPublicHolidays is false;
// kind 'closed' on an SG public holiday only when openOnPublicHolidays is true (otherwise it is already closed).

BusinessProfile = BusinessProfileBody & { updatedAt: string }

PublicHoliday = { day: 'YYYY-MM-DD', name: string }
SuggestedFaq = { id: string, question: string, hint: string, added: boolean }

BusinessProfileResponse = {
  profile: BusinessProfile,
  calendar: { holidays: PublicHoliday[] /* today .. today + 365 days, capped at the cover year */, coverThrough: number },
  template: { industry: 'fnb', suggestedFaqs: SuggestedFaq[] } | null,   // null unless the saved industry has a template
}
```

The contract's messages are the screen's (NFR-19), e.g. "UEN must be 9 or 10 characters, like 201912345K" (design.md §4.2), "Enter a Singapore number with 8 digits, like 9123 4567", "Opening time must be before closing time", "Hours on Monday overlap".

### 3.2 `GET /api/v1/settings/business-profile`

- 200 `BusinessProfileResponse`. Exceptions are the rows from today (SGT) on; past rows are not returned (§4).
- `template.suggestedFaqs[].added` is true when the tenant has a FAQ fact (any status except rejected) whose question equals the suggestion's, ignoring case, spaces and a trailing `?` (D5).
- 401 `unauthorized`/`session_expired`, 403 `no_workspace`, 403 `forbidden` (an Agent).

### 3.3 `PUT /api/v1/settings/business-profile`

- Body `BusinessProfileBody`, the whole document (D7). Response 200 `BusinessProfileResponse` with `version + 1`.
- 400 `bad_request` on any schema failure, including the refinements.
- 409 `version_conflict` ("These settings were changed by someone else", the FEAT-024 mapping) when the stored version is not `body.version`.
- Side effects in the same transaction: `tenants.name`, the profile row, the exception rows from today on replaced by the body's, and one audit entry `settings.profile_updated` (§5.1). No outbox event: the next visitor turn reads the state (as FEAT-024).

## 4. Schema changes

Migration `0018_business_profile` (drizzle DDL from `schema.ts`) and `0019_business_profile_rls` (hand-written), against 0000–0017.

| Change | Conceptual entity | Definition |
|---|---|---|
| `business_profiles.version integer not null default 1` | BUSINESS_PROFILE | Optimistic concurrency (D7). Existing rows start at 1 |
| `business_profiles.uen text null`, `industry text null`, `contact_email text null`, `contact_phone text null`, `languages text[] not null default '{en}'` | BUSINESS_PROFILE (ONB-03) | Checks: `business_profiles_uen_ck` (the three ACRA patterns, D2), `business_profiles_industry_ck` (the seven codes), `business_profiles_phone_ck` (`^\+65[3689][0-9]{7}$`), `business_profiles_email_ck` (length ≤ 254 and one `@`), `business_profiles_languages_ck` (non-empty, `<@ '{en,zh,ms,ta}'`) |
| table `holidays` | BUSINESS_PROFILE detail (D4) | `tenant_id uuid → tenants.id`, `day date`, `kind text not null`, `label text null`, `created_at timestamptz not null default now()`; primary key `(tenant_id, day)`; checks `holidays_kind_ck` (`kind in ('open','closed')`), `holidays_label_ck` (null or non-blank, ≤ 60) |
| RLS (0019) | ADR-005 | `holidays`: `ENABLE` + `FORCE`, policy `tenant_isolation`; `GRANT SELECT, INSERT, DELETE ON holidays TO app_dashboard`; `GRANT SELECT ON holidays TO kaki_tenant_state`. `GRANT UPDATE (gst_registered, hours, open_on_public_holidays, version, uen, industry, contact_email, contact_phone, languages, updated_at) ON business_profiles TO app_dashboard`; `GRANT UPDATE (name) ON tenants TO app_dashboard` (D1). No grant to `app_agent_visitor` |
| `visitor_tenant_state()` recreated (0019) | ADR-013 d3; FEAT-022 D10 | Adds `holidays jsonb`: `{ "YYYY-MM-DD": "open" \| "closed" }` for the tenant's rows within 15 days either side of today in SGT (the `openStatus` horizon is 14), `'{}'` when none. Same owner, definer, `search_path` and grant. Contact fields, UEN, industry and languages are not added (D9) |
| `TENANT_SCOPED_TABLES` | | gains `holidays`; the RLS suite gets its case (AC-9) |

Past exception rows are kept (they explain an old after-hours notice) and are not returned or rewritten by the API. Rollback is forward-only: a later migration would drop the table and columns and restore the 0015 function text.

## 5. Component design

```mermaid
sequenceDiagram
    autonumber
    participant D as "Dashboard SCR-APP-044 / -006"
    participant A as "api settings route"
    participant T as "tenancy profile"
    participant K as "kb listFacts"
    participant DB as "Postgres"
    participant W as "agent-worker turn"
    D->>A: "GET /api/v1/settings/business-profile"
    A->>T: "getBusinessProfile, upcomingHolidays, template"
    A->>K: "FAQ questions (for added)"
    A-->>D: "profile + calendar + template"
    D->>A: "PUT … (version n)"
    A->>T: "saveBusinessProfile"
    T->>DB: "update where version = n; tenants.name; replace exceptions; audit"
    W->>DB: "visitor_tenant_state() → hours, holidays"
    W->>W: "openStatus(hours, openOnPH, exceptions, now)"
```

### 5.1 `@kaki/tenancy`

- `sg-holidays.ts`: the calendar becomes `[day, name]` pairs (names from MOM: "New Year's Day", "Chinese New Year", "Chinese New Year (second day)", "Hari Raya Puasa", "Good Friday", "Labour Day", "Hari Raya Haji", "Vesak Day", "National Day", "Deepavali", "Christmas Day", and "Day off for {holiday}" for the Monday in lieu). New: `SG_PUBLIC_HOLIDAY_LIST: readonly { day, name }[]` and `sgHolidaysBetween(from, to)`. `SG_PUBLIC_HOLIDAYS` and `isSgPublicHoliday` keep their behaviour.
- `hours.ts`:
  - `HolidayExceptions = Readonly<Record<string, 'open' | 'closed'>>` (day → kind), default `{}`.
  - `hoursOn(hours, openOnPublicHolidays, day, exceptions = {})`: `closed` → `[]`; an SG public holiday → the weekday's hours if `openOnPublicHolidays` or the exception is `open`, else `[]`; any other day → the weekday's hours.
  - `openStatus(hours, openOnPublicHolidays, now, exceptions = {})` uses it for every day of the horizon. `OpenStatus` gains `closedReason: 'public_holiday' | 'closure' | null` (today has weekly hours but is closed by the holiday rule or by a closure); `closedForHoliday` stays (= `closedReason === 'public_holiday'`). Callers that pass no exceptions get FEAT-023's results unchanged.
- `profile.ts` (new):
  - `BusinessProfile` type: `{ version, name, uen, industry, contactEmail, contactPhone, languages, gstRegistered, hours, openOnPublicHolidays, exceptions: { day, kind, label }[], updatedAt }`.
  - `getBusinessProfile(tx, tenantId, today)` (dashboard zone): the row joined with `tenants.name`, `hours` through `WeeklyHours` (invalid → null, as `visitorTenantState`), and the exception rows with `day >= today`, ordered by day.
  - `saveBusinessProfile(tx, { tenantId, userId, version, profile, today })`: `update business_profiles set … , version = version + 1, updated_at = now() where tenant_id = $1 and version = $2 returning`; no row → `SettingsConflictError` (reused). Then `update tenants set name`, `delete from holidays where day >= today`, insert the body's exceptions after dropping redundant ones (D4), and `audit.append` `settings.profile_updated`, actor user, subject `business_profile`/tenantId, payload `{ version, fields: [codes] }` with codes `name`, `uen`, `industry`, `contact_email`, `contact_phone`, `languages`, `gst_registered`, `hours`, `open_on_public_holidays`, `exceptions`; never a value (ADR-014, NFR-11).
  - Validation is the contract's; `saveBusinessProfile` re-parses `hours` with `WeeklyHours` and rejects an `open` exception on a day that is not an SG public holiday (`InvalidProfileError`, → 400), so a caller that skips the contract cannot store either.
- `templates.ts` (new): `INDUSTRY_TEMPLATES: Partial<Record<Industry, { suggestedFaqs: { id, question, hint }[] }>>` with the F&B template only (D1 vertical): 12 suggestions, ids stable (`fnb.custom-orders`, `fnb.notice`, `fnb.delivery-area`, `fnb.delivery-fee`, `fnb.halal`, `fnb.allergens`, `fnb.vegetarian`, `fnb.self-collection`, `fnb.payment`, `fnb.bulk-orders`, `fnb.shelf-life`, `fnb.dine-in`). Each question is a plain English customer question ("Do you take custom cake orders?") and its hint tells the owner what to cover ("Say what you can customise and how much notice you need."). `questionKey(q)` normalises for the `added` check. The template holds questions only, never answers, so it can't put a claim in a tenant's mouth (D5).
- `VisitorTenantState` gains `holidays: HolidayExceptions` from the function's new column (malformed → `{}`).

### 5.2 `@kaki/agent`

- `turn.ts`: `openStatus(tenant.hours, tenant.openOnPublicHolidays, wall, tenant.holidays)`.
- `hours-text.ts`: `hours.today` when `closedReason === 'closure'` → `closed today` / `今天休息`; `public_holiday` keeps FEAT-023's texts. `HoursContext` is unchanged otherwise. The cached hours lines stay the weekly hours and the public-holiday rule only, so `system` does not change from day to day (FEAT-004 AC-3; D4).
- `evals/src/run.ts` and the case schema: `Fixture` and `Case` gain optional `holidays` (an exceptions map), passed to `openStatus` as the worker does; cases in `feat-009-holidays.json` (four, see tasks.md T4) (a closure today: notice with the next opening, `hours.today` "closed today"; an `open` exception on a public holiday: no notice). Fake provider only; no model behaviour is involved.

### 5.3 api

`apps/api/src/settings.ts` gains `GET`/`PUT /api/v1/settings/business-profile` (§3.2, §3.3), same `manager` guard. The response builder takes `today = sgDay(now)`, `sgHolidaysBetween(today, today + 365)`, and, when the industry has a template, the FAQ questions from `listFacts(dashboardKb(…), { type: 'faq' })` paged until done (a tenant has at most a few hundred FAQs; D5). `InvalidProfileError` → 400 `bad_request` in `app.ts`. The api's existing dependencies already include `@kaki/kb` and `@kaki/tenancy`.

### 5.4 Dashboard (SCR-APP-044, SCR-APP-006 p)

- `pages/business-profile.tsx`: `BusinessProfileForm` (the whole form, both modes) and `BusinessProfilePage` (`/settings/business-profile`, the settings mode). `/setup` renders `SetupProfilePage` (wizard mode: different heading and lede, "Save and continue" which, after saving, goes to Knowledge with a toast; FEAT-035 replaces this with the wizard frame).
- `components`: an `HoursEditor` (design.md §4.2 `hours-editor`): one row per day with an "Open" switch and time ranges (`<input type="time">`, step 15 min), "Add hours" (≤ 4 per day), "Copy Monday to weekdays"; `24:00` is shown and entered as a close of `00:00` ("midnight"). A `HolidayList`: the preloaded SG holidays from `calendar` with the "Open on public holidays" switch and, per holiday, an "Open" checkbox whose default follows the switch; "Other closures" with a date, an optional label and Remove; the line "Public holidays are listed through {coverThrough}."
- Suggested FAQs (F&B saved): a card listing each suggestion with its hint and "Add answer" (a link to `/knowledge/facts/new?type=faq&question=…`), or "Added" when `added`. `pages/fact.tsx` reads `type` and `question` from the query on the new-fact route to prefill the draft (the owner can still change both).
- Settings index: "Business profile" becomes a link. Fetchers in `lib/api.ts`.

### 5.5 Dev data

The seed sets the bakery's profile (industry `fnb`, a valid UEN, a contact email and phone, languages en and zh) and no exceptions; the second tenant keeps nulls. Existing E2E tests are unaffected.

## 6. Acceptance criteria

- **AC-1 (ONB-03; UC-03 1).** An Owner or Admin reads and saves the whole profile: name, UEN, industry, contact email and phone, languages, GST, hours and public-holiday rule, exceptions. It reads back unchanged with `version + 1`, `tenants.name` changes with it, and an Agent gets 403 on both routes. A stale version gets 409 `version_conflict` and changes nothing.
- **AC-2 (ONB-03 "invalid UEN is rejected"; UC-03 2; NFR-10).** UENs `53312345A`, `201912345K`, `T08LL1234A` and `s99ab1234z` (normalised to `S99AB1234Z`) are accepted; `2019123K`, `201912345`, `X08LL1234A`, `2019-12345K` and 11 characters are rejected with the UEN message (400 and inline). Phones `91234567`, `+65 6123 4567` and `8123-4567` are stored as `+65…`; `71234567`, `9123456` and `+60 12 345 6789` are rejected. A bad email, an empty language list, an unknown industry and a blank name are rejected. The database checks reject the same values written directly.
- **AC-3 (ONB-03 hours; AGT-09).** Hours: an interval with open ≥ close, overlapping intervals, more than four in a day or a malformed time is rejected (with the day named); a close of `24:00` is accepted; `hours: null` is accepted and turns the after-hours behaviour off.
- **AC-4 (ONB-03 "SG calendar preloaded"; NFR-10).** `calendar.holidays` lists the SG public holidays from today to a year ahead (capped at the cover year), with names and the days in lieu; `coverThrough` is 2027. `sgHolidaysBetween` and the names are unit-tested against the 2026 and 2027 lists.
- **AC-5 (SRS §1.4 business hours; AGT-09).** `openStatus` with exceptions: a `closed` day is closed (and reopens the next open day; `closedReason = 'closure'`); an `open` exception on a public holiday with the rule "closed" gives the weekday's hours; with the rule "open", a `closed` public holiday is closed. Without exceptions every FEAT-023 case is unchanged. An `open` exception on a day that is not a public holiday, or a redundant one, is rejected by the contract; `saveBusinessProfile` also rejects the first and drops the second.
- **AC-6 (AGT-09; UC-20 5b).** A visitor turn on a tenant closure day (weekly hours say open) stores the after-hours notice with the next opening, and `hours.today` renders "closed today" / "今天休息"; on a public holiday with an `open` exception during its hours, no notice. The prompt's `system` is byte-identical before and after an exception is added.
- **AC-7 (ONB-06 p; UC-03 3).** With industry `fnb` saved, the response carries the F&B template's suggested FAQs; one whose question already exists as a FAQ fact (case, spaces and `?` ignored) is `added`; with another industry or none, `template` is null. Choosing an industry writes nothing to the KB. "Add answer" opens the FAQ form with the question prefilled; saving it marks the suggestion added.
- **AC-8 (GOV-01; ADR-014; NFR-11).** Each save writes one `settings.profile_updated` entry with the actor, the new version and the changed field codes, and no value (no name, UEN, email, phone or label).
- **AC-9 (GOV-03; ADR-005).** `holidays` has forced RLS; tenant B can't read or write tenant A's rows; the dashboard role can update only the listed `business_profiles` columns and only `tenants.name`; the visitor role can't select `holidays` or `business_profiles` and gets only its own tenant's exceptions, within the window, from `visitor_tenant_state()`.
- **AC-10 (SCR-APP-044, SCR-APP-006 p; NFR-09, NFR-19).** The screen loads, validates on blur and submit with a linked error summary (including an hours error naming the day), edits hours with the hours editor, lists the coming holidays with an "Open" choice and the cover year, adds and removes a closure, saves with a toast, shows the conflict alert on 409, the error state, and the no-permission state for an Agent; `/setup` shows the same form in wizard mode. No serious axe violations at 375 px and desktop.
- **AC-11 (E2E; UC-03 1–3, UC-20 5b).** In the browser an owner sets the industry to F&B, an invalid UEN (sees the error), then a valid one, sets today as a closure, saves, sees the suggested FAQs, adds one through "Add answer", and sees it marked added; on the widget host page the next question gets the after-hours notice. The test restores the profile afterwards.
- **AC-12 (AGT-14).** `pnpm eval` and `--fast` pass every threshold with the two new cases and the existing cases unchanged.

All criteria are verifiable on the fake provider; none depends on a real model (§0).

## 7. Decisions

- **D1 — The business name stays on `tenants.name`, edited from the profile.** Driver: every reader (prompt, disclosure, widget config, `visitor_tenant_state()`) already reads `tenants.name`; a second copy on the profile would drift. The dashboard role gets `UPDATE (name)` on `tenants` and no other tenant column, so it still can't touch the kill switch, routing knobs or widget key. Rejected: a `business_name` column on the profile.
- **D2 — UEN is checked for format only, in the three ACRA shapes, and is optional until go-live.** Driver: ONB-03 asks for a format check, and ACRA publishes no check-digit algorithm for every format. Formats: businesses `nnnnnnnnX`; local companies `yyyynnnnnX`; other entities `TyyPQnnnnX` (T/S/R + year + entity type + serial + letter). Lower case and spaces are normalised. Whether a UEN is required to go live is FEAT-035's readiness rule; requiring it here would block owners who are still registering. Rejected: a live ACRA lookup (an external dependency and a sub-processor question).
- **D3 — Phone numbers are Singapore numbers, stored in one form.** Driver: NFR-10 (SG phone formats) and FEAT-049's later reuse. Eight digits starting 3, 6, 8 or 9, accepted with `+65`, spaces or hyphens, stored as `+65XXXXXXXX` and shown as `+65 XXXX XXXX`. A foreign number is rejected; an SME that needs one is a new requirement.
- **D4 — `holidays` holds the tenant's exceptions to the SG calendar; the calendar stays code.** Driver: design.md §4.2's hours editor ("an 'open on this day' option per holiday") and the plan's `holidays` table, without duplicating MOM's list per tenant (FEAT-023 D3). Two kinds: `open` (usual weekday hours on a public holiday when the rule is "closed") and `closed` (closed all day, any day). Redundant rows are dropped on save, so every row changes the result. Special hours for a single day (a half day on Chinese New Year eve) are not in ONB-03 and are left out; a closure plus a note in the KB covers the common case. Exceptions don't enter the cached prompt: they change `hours.today`, `next_open` and the notice only, so `system` stays stable from day to day.
- **D5 — The template's suggested FAQs are offered, not written into the KB.** Driver: a FAQ without the owner's answer is not a fact, and ADR-010 lets only owner-approved facts reach visitors; an invented answer ("Yes, we deliver islandwide") would be a false claim. "Add answer" starts the existing FAQ form with the question filled in, so the owner writes and approves the answer in one step and can still edit the question (ONB-06 "can be edited"). `added` is derived from the KB, so there is no new state to keep in sync. Rejected: `needs_review` facts with placeholder answers, which would fill the review queue (FEAT-013) with drafts and could be approved unread.
- **D6 — Default languages are stored, not yet used by the agent.** Driver: ONB-03 lists them, and FEAT-023 picks the reply language per message, which already serves a mixed audience. FEAT-032 (widget theme and locale) and the readiness check can read them. Recorded so the field isn't mistaken for a reply-language setting.
- **D7 — One `PUT` saves the whole profile, hours and exceptions, with one version.** Driver: one form, one Save (design.md §3), and FEAT-024 D9. The exceptions are part of the document, so there is no per-row conflict handling.
- **D8 — `/setup` reuses the profile form until FEAT-035 builds the wizard.** Driver: SCR-APP-006 is partial in the plan; the wizard frame, progress and resume (ONB-02) are FEAT-035. The setup page saves the same document and sends the owner to Knowledge next, which is the wizard's next working step today.
- **D9 — Contact email and phone are the business's contacts, kept on the profile and not given to the visitor zone yet.** Driver: they are tenant configuration, not a visitor's personal data (ADR-015 keys PII by contact), but they may be a sole proprietor's own number, so they stay out of audit payloads and logs, and out of `visitor_tenant_state()` until a feature needs the agent to give them (FEAT-044 handover, FEAT-049 leads). Rejected: putting them in the prompt now, which would let the model type a phone number the verifier must then block (FEAT-022 D13).
- **D10 — Saving the profile needs no re-authentication.** Driver: AUTH-03 and design.md §4.10 list boundary rules, payouts and deletion as sensitive, not profile fields; the change is audited (GOV-01), as FEAT-024 D8.

## 8. Escalations and open items

- **Logical model note (no amendment requested).** HOLIDAY is a detail of BUSINESS_PROFILE (same tenant, same consistency boundary); architecture §5.3 doesn't draw it. Recorded here for the next architecture revision, with FEAT-023's hours and FEAT-024's assistant settings.
- **M1.5 is deferred by the owner's decision of 2026-10-21 (§0)** and runs before FEAT-012.
- **Calendar upkeep.** The calendar covers 2026–2027 (FEAT-023 §8). The screen shows the cover year so an owner notices when it ends; the yearly MOM update is a one-file change.
- **Other industry templates** (retail, beauty and wellness, education, professional and home services) are M7 (plan §5); their industries are selectable now and simply have no suggestions.
- **The F&B template's boundary rules and lead fields** arrive with FEAT-054 and FEAT-049, which add to `INDUSTRY_TEMPLATES`.

## 9. Self-check

Requirement coverage: ONB-03 → AC-1, AC-2, AC-3, AC-4, AC-5, AC-8, AC-10, AC-11 (tasks T1–T8); ONB-06 (p) → AC-7, AC-11 (T3, T5, T7, T8). AGT-09 (p) → AC-5, AC-6, AC-12 (T2, T4). UC-03 1–3 → AC-1, AC-2, AC-4, AC-7; UC-20 5b → AC-6, AC-11. NFR-10 → AC-2, AC-4; NFR-11 → AC-8; NFR-09/NFR-19 → AC-10; GOV-03/ADR-005 → AC-9. E2E obligation: UC-03 is a critical flow (architecture §8.7) → T8 adds `business-profile.e2e.ts`. IDs checked: ONB-02/03/06, AGT-09, AGT-14, AUTH-03, KB-15, GOV-01/03, NFR-09/10/11/19, UC-03, UC-20, SCR-APP-006, SCR-APP-044, ADR-005/008/010/013/014/015, FEAT-004/012/013/022/023/024/032/035/044/049/054 all resolve. Schema: one table inside BUSINESS_PROFILE's boundary (§8 note), forced RLS in the same migration pair. Contract changes are additive; `openStatus` and `hoursOn` keep their signatures with an optional last argument.
