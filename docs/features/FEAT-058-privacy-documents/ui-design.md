# UI Design: FEAT-058 — Privacy notice and template, consent wording, data-processing documents

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E8) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-047 (new, partial), SCR-APP-009 (new, partial), plus the hosted privacy notice (a public page, not an inventoried screen) · Mode: per-feature · Status: Draft · Date: 2026-10-27

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `field`, `text-input`, `textarea`, `radio`, `button`, `link`, `alert`, `card`, `table`/stacked `list`, `chip`, `error-state`, `skeleton`, `toast`. No new component or token.

Saved marker (both forms): caption, text-secondary, "Version {seq} · saved {d MMM yyyy}"; never saved: chip (warning-soft) "Not saved yet" with text, never colour alone.

## Shared parts (`pages/privacy-parts.tsx`)

- **`NoticeForm`** — `card` titled "Privacy notice", lede "Visitors see a link to this in the chat menu and below the chat. You need one before you go live."
  - `radio` group "Where is your privacy notice?": "On my website" / "Use the KakiAgent template".
  - **On my website:** `field` "Link to your privacy notice (required)", `text-input` type url, placeholder "e.g. https://kakibakery.sg/privacy", help "Use the page's full address, starting with https://". Errors: empty "Add the link to your privacy notice."; not https "The link must start with https://"; malformed "That doesn't look like a web address. Copy it from your browser's address bar."
  - **Template:** read-only summary line "Business: {name} · UEN {uen}" with `link` "Edit in Business profile" (to `/settings/business-profile`); fields "Contact person (required)" help "Who visitors can ask about their data, often your data protection officer."; "Contact email (required)" (prefilled from the profile's email when the template was never saved); "Contact phone"; "Business address"; `textarea` "Anything else to tell visitors" (help "Plain text. Up to 2,000 characters."). Errors: "Add a contact person." / "Add a contact email, like hello@kakibakery.sg". After a template save: `link` "Preview your notice" (opens the hosted URL in a new tab; accessible name ends "(opens in a new tab)") and caption "Template version {templateVersion}".
  - Footer: `primary` "Save privacy notice" (disabled until changed), saved marker. Success toast "Saved. Visitors now see this privacy notice." Switching modes and saving replaces the link visitors see; the earlier version is kept (no confirm needed: not a §4.10 action).
- **`PurposeForm`** — `card` titled "Why you collect details (PDPA purpose)", lede "Before your assistant asks for a name, phone or email, visitors see this and are asked if it's OK."
  - `field` "English (required)" `textarea` (max 600), prefilled with the default when never saved: "We'll use your name and contact details to reply to your enquiry and follow up about it. We won't use them for anything else without asking."
  - `field` "中文 (Chinese)" `textarea` (max 600), prefilled: 「我们会使用您的姓名和联系方式回复您的询问并跟进。未经您同意，我们不会将其用于其他用途。」 help "Shown to visitors chatting in Chinese. Leave empty to show the English text."
  - **Preview** (subtle fill, radius md, `aria-label` "What visitors see"): the English statement, then the fixed question "Is it OK for us to use your details for this?" with two non-interactive pills "Yes" / "No thanks". Caption "The question is the same for every business."
  - Footer: `primary` "Save purpose statement", saved marker; never saved also shows `alert` info "Review the text and save it. Your assistant can't ask for details until you do." Errors: "Add the English purpose statement." / "Keep it under 600 characters ({n} now)." Success toast "Saved. Visitors will see this before giving their details."
- **`DocumentsSection`** — `card` titled "Where your data goes", lede "KakiAgent processes your visitors' data for you. These are the services we use and where data is processed. Updated {d MMM yyyy}."
  - Statement line with a check icon: "All your data is stored in Singapore."
  - `table` "Services we use" (desktop) / stacked `list` (< 768): Service · What it does · Where · Stores your data (Yes / "No, processed only"). One row per `subProcessors` item.
  - `table` "Data processed outside Singapore": Data · Goes to · Why · Protection · Kept. One row per `transfers` item.
  - Downloads: two `secondary` buttons rendered as links with a download icon, "Download data-flow PDF" and "Download DPA (version {dpaVersion})"; caption under the DPA "The full agreement text will be added after legal review. The schedules are final."
- **`TermsSection`** — `card` titled "Terms you accepted": a `list` of ToS, AUP, DPA: "{title} · version {acceptedVersion} · accepted {d MMM yyyy}"; when `acceptedVersion ≠ currentVersion`, chip (warning-soft) "New version {currentVersion}" and the caption "You'll be asked to accept it the next time you sign in." (re-acceptance flow: FEAT-073). Not shown on the setup step.

## SCR-APP-047 — Privacy and data

- **Strategy and source:** code-native (this section).
- **Route:** `/settings/privacy`, linked from the Settings row "Privacy and data" (`pages/settings.tsx`, now with `to`). Breadcrumb "Settings / Privacy and data". Roles: Owner, Admin (`settings.manage`); Agents get the permission state "Only the Owner and Admins can change privacy settings."
- **Contract bindings:** `GET /api/v1/settings/privacy`, `PUT /api/v1/settings/privacy/notice`, `PUT /api/v1/settings/privacy/purpose`, `GET /api/v1/settings/privacy/documents/data-flow.pdf`, `GET /api/v1/settings/privacy/documents/dpa.pdf`.
- **Layout:** title "Privacy and data", lede "Your privacy notice, what visitors agree to, and where their data goes." One column, max width per design.md §3 reading width: `NoticeForm`, `PurposeForm`, `DocumentsSection`, `TermsSection`. Readiness: when either readiness flag is false, an `alert` (warning) above the cards "You need a privacy notice and a saved purpose statement before you go live." with links to the missing card.
- **States:** loading (skeletons per card); error (`error-state` "We couldn't load your privacy settings." [Try again]); never saved (defaults, "Not saved yet" chips, readiness alert); saved; saving (button busy "Saving…", form read-only); validation errors (summary `alert` danger listing fields as links, focus to it); conflict (`alert` danger in the card "Someone else changed this. Reload to see their version." [Reload]); save failed (`alert` danger "We couldn't save. Check your connection and try again."); download failed (toast "We couldn't download the PDF. Try again."); permission.
- **Out of scope here (D9):** retention periods (FEAT-059), terms re-acceptance (FEAT-073); no placeholders for them.

## SCR-APP-009 — Wizard · Rules and privacy

- **Strategy and source:** code-native (this section).
- **Route:** `/setup/rules`, step 4 of the setup (after "Review your facts", whose Continue now goes here; Test becomes step 5, Website step 6). FEAT-054 adds boundary rules above the privacy block; FEAT-035 adds the frame and skip.
- **Contract bindings:** as SCR-APP-047 except the PDF routes.
- **Layout:** page-lede "Step 4 of the setup", title "Rules and privacy", lede "Tell visitors how you use their details. You can change this any time in Settings → Privacy and data." Then `NoticeForm` and `PurposeForm`; then a `link` "See where your data goes" to `/settings/privacy#documents`.
- **Footer:** `primary` "Continue" to `/setup/test` (always enabled: saving can wait, the readiness check enforces it), caption "You'll need both before you go live." hidden once both readiness flags are true.
- **States:** as SCR-APP-047 for the two forms; permission as SCR-APP-047.

## Hosted privacy notice (`GET /privacy/:key`, api)

- Server-rendered, no script. `lang="en"`, `<title>` "Privacy notice · {business}". Page width 680 px max, 16 px side gutter, `--color-bg` background, `--color-text-primary` text, body type; `h1` "Privacy notice", subtitle "{business}" and "UEN {uen}" when set; `h2` per section in the order of technical-design §5.1; "Last updated {d MMM yyyy}" caption; footer caption "Hosted by KakiAgent for {business}." Light and dark from `prefers-color-scheme` through the token CSS. Links: the contact email as `mailto:` only (no other links).
- 404 page: same shell, `h1` "This privacy notice isn't available", body "Ask the business for its privacy notice." No business name (the key may be unknown).

## Gaps and escalations

- Retention (FEAT-059), re-acceptance and sub-processor notices (FEAT-073), wizard frame and skip (FEAT-035), boundary rules on the step (FEAT-054), purpose statement in chat and consent (FEAT-049).
- `zh-Hans` hosted notice (technical-design D7); legal review of the template, consent question and DPA (pending-actions).
