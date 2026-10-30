# Technical design: FEAT-035 — Onboarding wizard frame and go-live readiness check

> Implements: ONB-02 (guided wizard, progress saved at every step, resume, skip after the profile), ONB-09 (go-live readiness check: blocking items and warnings), ONB-08 (p: instrumented: sign-up and first go-live timestamps; the pilot median is read from them) · Realizes: UC-03 (1a, 9–11, 7a, 10a) · Screens: SCR-APP-012 (new), the wizard frame of SCR-APP-006..011, SCR-APP-009 (adds persona and disclosure) · Module: `tenancy` (`readiness`, `onboarding`)
> Status: designed · 2026-10-30

## 1. Intent

The setup steps exist as separate pages (FEAT-009, -012, -013, -058, -054, -027, -032). This feature joins them into one wizard: a focused shell with a step header, progress that is saved at every step so the owner resumes where they left off, and "Skip for now" on every step after the profile. It ends with the go-live check (SCR-APP-012): seven required items and two warnings, a choice of channels, and Go live. Until a tenant's first go-live, no channel can go live while a required item fails, from the check or from the Channels page. The first go-live is timestamped so the sign-up-to-live time (ONB-08) can be measured on pilot tenants.

## 2. Codebase context

- **Setup pages** (`apps/dashboard/src/router.tsx`, children of `AppShell`): `/setup` `SetupProfilePage` (business-profile.tsx; on save it navigates to `/knowledge`, a FEAT-009 stopgap), `/setup/sources` (add-website.tsx), `/setup/review` (review.tsx), `/setup/rules` (setup-rules.tsx), `/setup/test` (coach.tsx), `/setup/website` (widget.tsx). Each has a `page-lede` "Step N of the setup" and a Continue link to the next path; Website's Continue goes to `/`. `WelcomePage` sends a new workspace to `/setup`.
- **Readiness inputs already exist:** governance `privacyReadiness(tx, tenantId)` → `{ privacyNotice, purposeStatement }` (FEAT-058); approvals `rulesSaved(tx, tenantId)` (FEAT-054); kb `reviewSummary(dashboardKb(tx, tenantId, userId))` → `approvedInUse`, `needsReview`, `conflicts` (FEAT-013/-014); tenancy `getBusinessProfile(tx, tenantId, today)` and `getAssistantSettings(tx, tenantId)` (`version` 0 = never saved); identity `CURRENT_TERMS`, `termsAreCurrent`; `terms_acceptances` is readable by `app_dashboard` (0007).
- **Going live:** channels `setChannelState(tx, { tenantId, userId, id, version, state })` (FEAT-034), called by `POST /api/v1/channels/:id/live|offline` in `apps/api/src/channels.ts`. FEAT-034 D9 left the ONB-09 precondition to this feature. New tenants start with the widget offline (trigger, FEAT-034 D3); the dev seed sets both dev tenants' widget live.
- **Dependencies:** `tenancy` depends on `db`, `governance`. Nothing but `agent` depends on `tenancy`, so `tenancy` may import `kb`, `approvals`, `identity` and `channels` without a cycle (dependency-cruiser `no-circular`).
- **Design:** ux-foundations §"Navigation model" (the wizard's focused shell: no sidebar, a step header with progress, "Save and exit"), F1, SCR-APP-012; design.md §4.6 `readiness-checklist`, §4.10 sensitive-action pattern (go-live: confirm dialog, server acknowledgement, toast; no re-auth, FEAT-034 D9).

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: onboarding and go-live (ONB-02, ONB-09; FEAT-035 §3)`)

```ts
OnboardingStep = z.enum(['profile', 'sources', 'review', 'rules', 'test', 'website', 'go_live'])   // wizard order
OnboardingProgress = z.object({
  currentStep: OnboardingStep,                                   // 'profile' when never saved
  steps: z.record(OnboardingStep, z.enum(['done', 'skipped'])),  // partial: absent = not started
  firstLiveAt: z.iso.datetime().nullable(),                      // null = never live
})
StepOutcomeBody = z.object({ outcome: z.enum(['visited', 'done', 'skipped']) })
ReadinessKey = z.enum(['profile', 'approved_fact', 'disclosure', 'purpose', 'notice', 'terms', 'rules'])
ReadinessResponse = z.object({
  items: z.array(z.object({ key: ReadinessKey, ok: z.boolean() })),  // always all seven, in this order
  warnings: z.object({ conflicts: z.number().int().nonnegative(), needsReview: z.number().int().nonnegative() }),
  ready: z.boolean(),                                            // every item ok
  preLiveForm: z.boolean(),                                      // purpose && notice (UX-R4)
  firstLiveAt: z.iso.datetime().nullable(),
  channels: z.array(ChannelItem),                                // FEAT-034's item, registry order
})
GoLiveBody = z.object({
  channels: z.array(z.object({ id: z.uuid(), version: z.number().int().positive() })).min(1).max(10),
  acknowledgeWarnings: z.boolean(),
})
NotReady = z.object({ error: z.literal('not_ready'), missing: z.array(ReadinessKey).min(1) })
```

| Route (dashboard, `settings.manage`) | Body | 200 | Errors |
|---|---|---|---|
| `GET /api/v1/onboarding/progress` | — | `OnboardingProgress` | 403 Agent |
| `PUT /api/v1/onboarding/progress/:step` | `StepOutcomeBody` | `OnboardingProgress` | 400 `invalid_body`; 400 `not_skippable` (`profile`, `go_live` with `skipped`); 404 unknown step; 403 |
| `GET /api/v1/onboarding/readiness` | — | `ReadinessResponse` | 403 |
| `POST /api/v1/onboarding/go-live` | `GoLiveBody` | `ReadinessResponse` after the change | 409 `NotReady` (nothing changed); 409 `warnings_unacknowledged` (warnings > 0 and `acknowledgeWarnings` false); 409 `version_conflict`; 404 unknown or another tenant's channel id; 403 |
| `POST /api/v1/channels/:id/live` (FEAT-034, changed) | `ChannelStateBody` | `ChannelItem` | **new:** 409 `NotReady` while the tenant has never been live and an item fails; otherwise as FEAT-034 |

`visited` sets `currentStep` to the step. `done` and `skipped` record the step's outcome and set `currentStep` to the next step (`go_live` stays `go_live`). `done` overwrites an earlier `skipped` and vice versa. Going live (either route) leaves step outcomes alone; the first go-live sets `firstLiveAt` and `currentStep = 'go_live'`.

## 4. Schema changes (migration `0039_onboarding_progress.sql` + Drizzle table)

```sql
create table onboarding_progress (
  tenant_id     uuid primary key references tenants(id),
  current_step  text not null default 'profile',
  steps         jsonb not null default '{}'::jsonb,          -- { "<step>": "done" | "skipped" }
  first_live_at timestamptz,
  first_live_by uuid references users(id),
  updated_at    timestamptz not null default now(),
  constraint onboarding_progress_step_ck check (current_step in
    ('profile','sources','review','rules','test','website','go_live')),
  constraint onboarding_progress_steps_ck check (jsonb_typeof(steps) = 'object')
);
```

- Forced RLS and `tenant_isolation` policy in the same migration; `select, insert, update` to `app_dashboard`; no delete. Name in `TENANT_SCOPED_TABLES`; a case in `rls.int.test.ts`.
- **Backfill:** every tenant with a channel whose `state = 'live'` gets a row with `first_live_at = min(state_changed_at)` (or `now()` if null) and `current_step = 'go_live'`, so tenants already live are not gated again.
- **Dev seed** (`packages/db/src/setup.ts` `seed`): both dev tenants are seeded live, so they get the same row (`first_live_at = coalesce(existing, now())`). A fresh sign-up has no row: no row reads as `currentStep: 'profile'`, `steps: {}`, never live.
- Sign-up time is `tenants.created_at`; nothing new stored for it.

## 5. Component design

### 5.1 Identity (`packages/identity/src/terms.ts`)
- `termsAccepted(tx, tenantId): Promise<boolean>` — the newest accepted version per document from `terms_acceptances` (dashboard zone) passed to `termsAreCurrent`; a missing document is false. Exported from the index. Re-acceptance after a material change is FEAT-073's.

### 5.2 Tenancy (`packages/tenancy/src/onboarding.ts`, `readiness.ts`; exported from the index; package deps `@kaki/kb`, `@kaki/approvals`, `@kaki/identity`, `@kaki/channels`)
- `ONBOARDING_STEPS` (the order), `getProgress(tx, tenantId)`, `recordStep(tx, tenantId, step, outcome)` (upsert; `NotSkippableError` for `profile`/`go_live` skipped). Last write wins: progress is a convenience, not a decision.
- `profileComplete(p: BusinessProfile): boolean` — name, industry, weekly hours, an email or a phone, at least one language (D2). UEN stays optional (FEAT-009 D2; Ken's decision pending as Q1).
- `goLiveReadiness(tx, tenantId, userId, today)` → the `ReadinessResponse` minus `channels`: `profile` = `profileComplete`; `approved_fact` = `approvedInUse ≥ 1`; `disclosure` = assistant settings saved at least once (D3); `purpose`/`notice` = `privacyReadiness`; `terms` = `termsAccepted`; `rules` = `rulesSaved`; warnings = `conflicts`, `needsReview`; `firstLiveAt` from the progress row.
- `goLive(tx, { tenantId, userId, channels, acknowledgeWarnings, today })` — one transaction: lock the progress row (`insert … on conflict do nothing` then `select … for update`); if never live, compute readiness: any failing item → `NotReadyError(missing)`; warnings and not acknowledged → `WarningsUnacknowledgedError`. Then `setChannelState(…, 'live')` per channel (its errors pass through: 404, 409; any error rolls back every channel). If `first_live_at` is null: set it, `first_live_by`, `current_step = 'go_live'`, and append one audit `onboarding.first_live` (actor user, payload `{ minutesToLive, channels: <ids> }`, minutes from `tenants.created_at`; no PII, ADR-014).
- `goLiveOne(tx, { tenantId, userId, id, version, today })` for the Channels page: the same gate with `acknowledgeWarnings: true` (warnings never block, ONB-09; the checkbox is the go-live check's UX, D5) and the same first-live bookkeeping.

### 5.3 API (`apps/api/src/onboarding.ts`, `registerOnboardingRoutes(app, deps, sessionFrom)`, wired at the end of `app.ts`)
- The four routes of §3, all `settings.manage`, inside `withTenant` on the dashboard zone. `NotReadyError` → 409 `{ error: 'not_ready', missing }`; `WarningsUnacknowledgedError` → 409 `warnings_unacknowledged`; channels errors mapped as in `channels.ts`. `today` is the SGT date (as the profile routes).
- `apps/api/src/channels.ts`: the `live` branch calls tenancy `goLiveOne`; `offline` is unchanged.
- Integration suite `apps/api/test/onboarding.int.test.ts` (helpers: `testApp`, `sessionCookie`; a fresh tenant with no progress row and the widget offline, built like the welcome-flow tests): progress round-trip and skip rules; each readiness item flips on its own input; go-live 409 `not_ready` lists exactly the failing keys and changes nothing; warnings need the acknowledgement; success sets the channel live, `firstLiveAt`, one `onboarding.first_live` audit and `channel.live`; a second go-live doesn't audit `first_live` again; after the first go-live the Channels route goes live with a failing item; Agent 403 on every route; tenant B can't read A's progress or go live with A's channel id (404).

### 5.4 Dashboard (detail in ui-design.md)
- `lib/onboarding.ts`: `STEPS` (key, path, title, skippable), `stepOf(pathname)`, `nextStep`, `prevStep`, `useProgress`, `useRecordStep`, `useReadiness`, `useGoLive`, `missingItems(readiness)`; unit tests in `lib/onboarding.test.ts`.
- **Focused shell:** the setup routes move under their own `path: '/setup'` layout route rendering `<AppShell focused />`: no sidebar or tab bar; the top bar, banners and `ReauthProvider` stay; a `WizardHeader` (`shell/wizard-header.tsx`) above the outlet records `visited` on each step change. The step pages drop their "Step N of the setup" ledes and their Continue links for `WizardFooter` (Back, Skip for now, Continue → records the outcome and navigates). The profile step navigates to `/setup/sources` after saving (records `done`).
- **SCR-APP-009:** an "Assistant" section (bot name, tone, greeting, the AI disclosure note) between Rules and Privacy, from the Settings → Assistant form extracted as `AssistantBlock` (`pages/assistant.tsx`) with a `variant="setup"`.
- **SCR-APP-012** `/setup/go-live` (`pages/go-live.tsx`): the checklist, warnings, channel choice, "I understand", Go live with the confirm dialog, the live state.
- **Home:** a "Continue setup" card while `firstLiveAt` is null, for Owner and Admin.
- **Channels page:** a 409 `not_ready` on Go live shows an alert linking to the go-live check.

### 5.5 E2E (`e2e/tests/onboarding.e2e.ts`)
A fresh sign-up (as `auth.e2e.ts`) lands in the focused shell at step 1; saves the profile → step 2; skips 2 → step 3; Save and exit → Home shows "Continue setup" at step 3; resume; opens the go-live check: blocked rows with Fix links, Go live disabled; the Channels page's Go live shows the not-ready alert; axe at 1280 and 375 (tall viewport), light and dark. Existing specs asserting "Step N of the setup" (`review.e2e.ts`, `privacy.e2e.ts`) change to the header's "Step N of 7".

## 6. Acceptance criteria

- **AC-1** (ONB-02 "progress is saved at every step"; UC-03 1a) Each step change records `visited`, and Continue and Skip record `done`/`skipped`, in `onboarding_progress`; after leaving (Save and exit, sign-out, a new session) the progress API and Home's "Continue setup" return the same step.
- **AC-2** (ONB-02 "steps after the profile can be skipped and finished later") Steps 2–6 offer Skip for now and record `skipped`; a skipped step can be reopened from the step list and later recorded `done`; `profile` and `go_live` can't be skipped (400 `not_skippable`, no button).
- **AC-3** (ONB-09 required items) The readiness response reports each of the seven items from its own source and flips it when, and only when, that source changes: a complete profile (D2), at least one approved fact (KB-16), saved assistant settings with the AI disclosure (AGT-11, D3), purpose statement (LED-02), privacy notice (GOV-14), current terms accepted (AUTH-08), saved boundary rules (APR-01).
- **AC-4** (ONB-09 "go-live is blocked until the required items pass"; UC-03 10a) While the tenant has never been live and any item fails, `POST /onboarding/go-live` and `POST /channels/:id/live` return 409 `not_ready` with exactly the failing keys and change no channel, progress or audit; the go-live check links each failing item to where it's fixed.
- **AC-5** (ONB-09 "can go live with warnings; conflicting and unreviewed facts stay out of visitor answers"; UC-03 7a) With conflicts or facts waiting for review, the check shows each count; go-live succeeds only with `acknowledgeWarnings` (409 `warnings_unacknowledged` otherwise); after it, `visitor_facts` still excludes conflicted and unreviewed facts.
- **AC-6** (UC-03 10–11; ONB-10) A ready go-live sets every chosen channel live in one transaction (all or none), audits `channel.live` per channel and `onboarding.first_live` once, sets `firstLiveAt`; later go-lives and the Channels page don't re-run the gate or re-audit `first_live`.
- **AC-7** (ONB-08 p: instrumented) `first_live_at` and `tenants.created_at` give each tenant's minutes to go live; the `onboarding.first_live` audit carries `minutesToLive` and no personal data; the median query is in §8.
- **AC-8** (ADR-005; RBAC) `onboarding_progress` has forced RLS: tenant B can't read or write A's row; Agents get 403 on every onboarding route and see no Home card.
- **AC-9** (SCR-APP-006..012 frame; NFR-19, NFR-09) The wizard runs in the focused shell with the step header (step N of 7, title, progress, step list with done/skipped/current), Save and exit, Back, Skip and Continue; SCR-APP-012 shows its states (loading, error with Try again, blocked, warnings, ready, going live, live, conflict, permission); axe reports no serious or critical issues at 1280 and 375, light and dark.
- **AC-10** (SCR-APP-009; AGT-08, AGT-11) The Rules and privacy step includes the assistant persona and disclosure note; saving it there is the same save as Settings → Assistant and turns the `disclosure` item green.

## 7. Decisions

- **D1 — Readiness lives in `tenancy` and composes other modules.** The plan names `tenancy.readiness`; tenancy imports kb, approvals, governance, identity and channels through their package names (no cycle). The gate wraps `setChannelState` in `goLive`/`goLiveOne` rather than putting a tenancy call inside channels, which would create a cycle.
- **D2 — A complete profile is name, industry, weekly hours, a contact (email or phone) and a language.** UEN stays optional (format-checked when given, FEAT-009 D2). Q1 to Ken; if he wants UEN required, it's one more condition in `profileComplete` and one copy line.
- **D3 — "AI disclosure" means the assistant settings were saved once.** A default disclosure always shows (AGT-11 can't be removed), so the item asks the owner to look at it and save, like rules (FEAT-054) and privacy (FEAT-058 D6). The setup step gains the assistant block for that.
- **D4 — The gate applies until the first go-live, as ONB-09 says ("before the first go-live").** After it, the Channels page takes channels live and offline freely; regressions (terms re-acceptance) belong to their own features (FEAT-073). Tenants already live are backfilled as live.
- **D5 — Warnings are acknowledged in the go-live check only.** The server needs `acknowledgeWarnings` on the check's route; the Channels page route never blocks on warnings, since ONB-09 lets the owner go live with them and that page shows its own confirmation.
- **D6 — Progress is recorded by the frame, not derived.** Step status is what the owner did (done/skipped), so a skipped step stays visibly skipped even after its data arrives elsewhere; readiness, not progress, decides go-live. Last write wins: no version column.
- **D7 — Paths stay as they are** (`/setup`, `/setup/sources`, …) and `/setup/go-live` is added, so existing links and specs keep working; only the "Step N of the setup" ledes move into the header.
- **D8 — Resume is a Home card, not a redirect.** Signing in still lands on Home (and a new workspace on `/setup`); the card names the saved step. A forced redirect would trap owners who want the inbox before setup is done.
- **D9 — No re-authentication for go-live** (FEAT-034 D9: not in AUTH-03's list); it follows the confirm → server acknowledgement → toast pattern.

## 8. Escalations and open items

- **Q1 (Ken):** is a UEN required to go live? Recommended: no (D2). Decision card posted 2026-10-30.
- **ONB-08 measurement:** the pilot median is `percentile_cont(0.5) within group (order by first_live_at - t.created_at)` over `onboarding_progress join tenants` for website-only pilot tenants; an operator report is FEAT-066/FEAT-070's. ONB-08 stays partial (instrumented) as the plan says.
- **Not in this plan row:** the hours-and-location suggestion from the crawl (FEAT-012 §8 suggested crediting it here). ONB-09 and ONB-02 don't need it, so it isn't designed here; KB-05 stays partial. Suggest crediting it to FEAT-020 (re-crawl) in the plan's next revision.
- The pre-live contact form itself (UX-R4) is FEAT-049; the check only reports whether it would be allowed (`preLiveForm`).
- Other channels in the wizard's website step are FEAT-036+ (the choose-channels list grows from the registry on its own).

## 9. Self-check

- Every FR criterion of ONB-02 and ONB-09 maps to an AC; ONB-08 is instrumented only, as planned. UC-03 1a, 7a, 9–11, 10a are covered; 1–8 are earlier features' screens inside the frame.
- New table: forced RLS, policy, `TENANT_SCOPED_TABLES`, RLS case (AC-8). Tenant ID only from the session.
- Audit entries carry IDs and a number only (ADR-014). No side effects beyond the database (no outbox events needed).
- Module boundaries: imports through package names; no cycle (D1). No model calls; the agent pipeline is unchanged.
- UI uses design.md's `readiness-checklist`, `progress`, `confirm-dialog`, `alert`, `checkbox`, tokens only.

Traceability: ONB-02 → AC-1, AC-2, AC-9; ONB-09 → AC-3, AC-4, AC-5, AC-6; ONB-08 (p) → AC-7; ONB-10 → AC-6; UC-03 1a → AC-1, 7a → AC-5, 10–11 → AC-6, 10a → AC-4; AGT-11, AGT-08 → AC-10; ADR-005 → AC-8; ADR-014 → AC-6, AC-7.
