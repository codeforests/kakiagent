# UI Design: FEAT-035 — Onboarding wizard frame and go-live readiness check

> Screens: SCR-APP-012 (new: Go-live check), the wizard frame of SCR-APP-006..011, SCR-APP-009 (adds the assistant block), Home (resume card), SCR-APP-036 (not-ready alert) · Mode: per-feature · Status: Draft · Date: 2026-10-30

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `readiness-checklist`, `progress`, `button` (`primary`, `secondary`, `ghost`), `checkbox`, `card`, `alert`, `chip`, `confirm-dialog`, `skeleton`, `error-state`, `toast`, `list`.

## Wizard frame (SCR-APP-006..011 and -012)

- **Shell:** `AppShell focused` for every `/setup` route (ux-foundations "Navigation model"): no sidebar and no tab bar; the top bar (tenant name, AI status pill, account menu), banners, skip link and `main` landmark stay. Content column max width as the settings forms, centred.
- **`WizardHeader`** (`shell/wizard-header.tsx`), first in `main`, above the page's own `h1`:
  - Row 1: caption "Set up your assistant" (body-sm, text-secondary) and, at the right, `ghost` "Save and exit" (→ records `visited` for the current step, then navigates to `/` with toast "Setup saved. Pick up where you left off from Home.").
  - Row 2: "Step {n} of 7 · {title}" (body-sm, weight 600) and a determinate `progress` bar (accent on subtle) at `done or skipped steps / 7`, with `aria-label="Setup progress"` and `aria-valuetext="{k} of 7 steps finished"`.
  - Row 3, ≥ 768 px: the step list, an `ol` of seven links (Business profile, Add your sources, Review your facts, Rules and privacy, Test your assistant, Add to your website, Go live). Each shows a status icon and text: done (check, success, sr text "done"), skipped (`chip` neutral "Skipped"), current (`aria-current="step"`, weight 600, accent underline), not started (text-secondary). Every step is a link: the owner may jump anywhere (ONB-02).
  - Below 768 px the list collapses behind a `ghost` "All steps" disclosure button (`aria-expanded`) under row 2; opened, it shows the same `ol` stacked, 44 px rows.
  - On each step change: records `visited` (fire and forget; a failure is silent, the next Continue retries), moves focus to the page `h1` (`tabIndex=-1`) and the document title becomes "{title} · Setup · KakiAgent".
- **`WizardFooter`** (replaces each step's Continue link), at the end of the page content, separated by a divider:
  - `secondary` "Back" (steps 2–7; → previous step, no outcome recorded).
  - `ghost` "Skip for now" (steps 2–6 only; records `skipped`, → next step; toast "Skipped. You can come back to it from the step list.").
  - `primary` "Continue" (steps 2–6; records `done`, → next step). Step 1's primary stays the form's "Save and continue" (saves the profile, records `done`, → `/setup/sources`). Step 6's Continue goes to `/setup/go-live`. While the outcome request runs the buttons are disabled with "Continue…"; if it fails, navigate anyway (progress is a convenience, D6).
  - Each step keeps its existing caption next to Continue (e.g. step 4's "You'll need … before you go live").
  - Below 480 px the buttons stack full width: Continue first, then Skip, then Back.
- **Removed:** the "Step N of the setup" `page-lede` on each step (the header says it).

## SCR-APP-009 — Wizard · Rules and privacy (adds the assistant block)

- **Strategy and source:** code-native (this section); rules and privacy are unchanged from FEAT-054 and FEAT-058.
- **Layout:** `h2` "Rules" (FEAT-054), then **`h2` "Assistant" (`id="assistant"`)** with lede "Your assistant's name, how it greets visitors and how it says it's an AI. Visitors always see the disclosure." and `AssistantBlock variant="setup"`: the Settings → Assistant form (bot name, tone, emoji, greeting, AI disclosure note, after-hours and fallback messages) in the same cards, with its own Save ("Save assistant") and states (loading, error, never saved: caption "Not saved yet", saved, saving, conflict). Then `h2` "Privacy" (`id="privacy"`, FEAT-058).
- **Caption:** "You'll need saved rules, saved assistant settings, a privacy notice and a purpose statement before you go live." hidden once all four are done.

## SCR-APP-012 — Go-live check

- **Strategy and source:** code-native (this section). Route `/setup/go-live`, step 7 of the frame. Roles: Owner, Admin; an Agent gets the `no-permission` page (403).
- **Contract bindings:** `GET /api/v1/onboarding/readiness`, `POST /api/v1/onboarding/go-live`.
- **Layout:** `h1` "Ready to go live?", lede "We check a few things so visitors get safe, accurate answers from the start." Then three `card`s:
  1. **Required** — `readiness-checklist` with the seven rows in contract order. Row: icon + label + (failing) one-line reason + `ghost` "Fix" link. Labels and fix targets:
     - profile — "Business profile" · reason "Add your industry, opening hours, a contact and a language." · `/setup`
     - approved_fact — "At least one approved fact" · "Approve the facts your assistant may use." · `/setup/review`
     - disclosure — "AI disclosure" · "Check how your assistant says it's an AI, then save." · `/setup/rules#assistant`
     - purpose — "Purpose statement" · "Say why you collect visitors' details." · `/setup/rules#privacy`
     - notice — "Privacy notice" · "Link your privacy notice or fill in ours." · `/setup/rules#privacy`
     - terms — "Current terms accepted" · "The account owner needs to accept the current terms. Contact support if this stays." · no link
     - rules — "Boundary rules" · "Check and save what your assistant may say and promise." · `/setup/rules`
     Pass rows: success check icon, label only, sr text "done". Fail rows: danger ✗ icon, sr text "missing".
  2. **Warnings** (only when a count > 0) — warning `!` rows: "{n} conflicts not resolved" · "Facts that disagree stay out of answers until you choose." · "Resolve" → `/review/conflicts`; "{n} facts waiting for review" · "They stay out of answers until you approve them." · "Review" → `/setup/review`. Then `checkbox` "I understand these facts won't be used in answers yet" (required to go live while warnings show).
  3. **Channels** — lede "Choose where your assistant starts answering." One `checkbox` per channel from `channels` (name from the registry); offline channels checked by default; live channels shown checked and disabled with a `chip` success "Live". Info line under it (body-sm): `preLiveForm` true → "Until a channel is live, its visitors can leave their details in a contact form." false → "Until a channel is live, it stays hidden. A contact form needs your purpose statement and privacy notice." (UX-R4).
- **Footer:** `secondary` "Back" (→ step 6) and `primary` "Go live". Disabled while any required row fails (caption "Fix the missing items to go live."), while warnings show and "I understand" is unticked, or while no offline channel is ticked.
- **Go live sequence** (design.md §4.10): Go live → `confirm-dialog` "Go live on {n} channel(s)?" body "Your assistant starts answering real visitors on {names}. You can take a channel offline any time in Settings → Channels." Buttons `secondary` "Cancel", `primary` "Go live" (busy "Going live…"). Server acknowledgement → live state + toast "Your assistant is live." Never optimistic.
- **States:**
  - loading: `skeleton` of the three cards. error: `error-state` "We couldn't check your setup." [Try again].
  - blocked: rows keep contract order (failing rows are not moved), so the list reads the same each visit.
  - warnings, ready (all pass, no warnings): as above.
  - going live: dialog busy.
  - 409 `not_ready` (something changed meanwhile): dialog closes, `alert` danger "Something changed. Fix the items below to go live." and the checklist refetches; focus on the alert.
  - 409 `warnings_unacknowledged`: the checklist refetches (new warnings appeared); `alert` warning "New warnings appeared. Check them before going live."
  - 409 `version_conflict` or 404: `alert` warning "A channel changed while you were here." with `secondary` "Reload".
  - other failure: `alert` danger "We couldn't go live. Check your connection and try again." inside the dialog; it stays open.
  - **live** (`firstLiveAt` set): `h1` "You're live", lede "Your assistant is answering visitors on {live channel names}." then `primary` "Open the inbox" (→ `/inbox`) and `secondary` "Manage channels" (→ `/settings/channels`); the checklist is shown below, read-only, under `h2` "Your setup", with the warnings' links still active. The header's step 7 shows done.
- **Responsive:** at 375 px the cards are full width with 16 px padding; Fix links move under the row text; the footer stacks (Go live first); the dialog becomes a bottom sheet.
- **A11y:** the checklist is a `ul` with `aria-label="Required before going live"`; icons `aria-hidden` with sr text; the disabled Go live has `aria-describedby` on the caption that says why; the 409 alerts use `role="alert"`.

## Home — "Continue setup" card

- Shown above the existing content while `firstLiveAt` is null and the role is Owner or Admin (no card, and no request, for Agents).
- `card` with `title-sm` "Finish setting up your assistant", body "Step {n} of 7: {title}. {k} of 7 steps finished." the `progress` bar, and `primary` "Continue setup" (→ the saved step's path). Loading: no card (no skeleton); error: no card.

## SCR-APP-036 — Channels (not-ready alert)

- A 409 `not_ready` from Go live closes the confirm dialog and shows `alert` warning in the channel card: "Finish the go-live check first. {k} required item(s) missing." with `ghost` link "Open the go-live check" (→ `/setup/go-live`). Focus moves to the alert.

## Gaps and escalations

- Other channels on the website step and in the channel choice appear from the registry as they're built (FEAT-036+). The pre-live contact form is FEAT-049. Terms re-acceptance is FEAT-073.
- Manifest: new SCR-APP-012 entry; the "wizard frame (FEAT-035)" gaps on SCR-APP-006..011 close with a supplement pointing here; SCR-APP-009's persona gap closes.
