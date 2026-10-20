# UI Design: FEAT-005 — Sign up, sign in and sessions

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-001, SCR-APP-002, SCR-APP-003, SCR-APP-059 (p: session expired; the other system pages are unchanged) · Mode: per-feature · Status: Verified · Date: 2026-10-20

No design tool is connected and the manifest policy is `code-native`, so each section below is the design. These are the first screens outside the dashboard shell, so they share one layout, the existing `.auth` centred card (max width `--size-reading-max`, `--space-8` padding, `--radius-xl`, `--shadow-sm`), with the "KakiAgent" wordmark above the `h1`. They use only design.md components and tokens.

The account menu in the shell's top bar (design.md §3 "avatar menu") is built here too, because sign-out has to live somewhere; it is described under SCR-APP-059 because it is how a session ends.

## SCR-APP-001 — Sign in

- **Strategy and source:** code-native. Route `/sign-in`, outside the shell. One screen for sign-up and sign-in: the same response whether or not the email is registered (AUTH-01).
- **Composition:** `.auth` card; h1 "Sign in to KakiAgent"; line "New here? Enter your email and we'll set up your account." (`text-secondary`); a `field` "Work email" (`text-input`, `type="email"`, `autocomplete="email"`, placeholder "e.g. you@yourbusiness.sg"); `Email me a sign-in link` (`primary`, full width); when Google is configured, a divider "or" and `Continue with Google` (`secondary`, full width, Google "G" mark as its leading icon); a caption with links to the Terms of Service, Acceptable Use Policy and DPA (`/legal/:document`).
- **Content and data mapping:** `GET /api/v1/auth/options` → `google` shows or hides the Google button. Submit → `POST /api/v1/auth/magic-link`. Google → full-page navigation to `GET /api/v1/auth/google/start`.
- **Conformance:** pass. One primary per region; the Google button is `secondary`, not a brand-coloured button (design.md §4.1 has no brand variant, and the mark identifies it).

### default
Empty field, focus on it on load. Google button only when `google: true`; while options load, the space is not reserved (the form is usable at once).
### sending
`Email me a sign-in link` in its loading state (spinner, `aria-busy`), field read-only.
### sent
The card's content is replaced by the SCR-APP-002 "sent" state (same route, no navigation, so Back returns to the form).
### rate-limited
On 429: a warning `alert` "Too many sign-in links for now" · "Wait a few minutes, then try again. The links we already sent still work for 15 minutes." Field keeps its value.
### validation
On blur or submit with an invalid address: field error "Enter an email address, like you@yourbusiness.sg", `aria-invalid`, focus on the field.
### error
Network failure or 5xx: danger `alert` "We couldn't send your link" · "Check your connection and try again." `?error=google` on load: danger `alert` "Google sign-in didn't work" · "Try again, or use a sign-in link instead."

- **Responsive notes:** the card fills the width below 640 px with `--space-5` page padding; buttons are 44 px on touch.

## SCR-APP-002 — Check your email / link problem

- **Strategy and source:** code-native. The "sent" state renders inside `/sign-in`; the link states render at `/auth/verify`, the route the emailed link opens (token in the URL fragment).
- **Composition:** `.auth` card with an h1 and body text; a `secondary` or `primary` action as below.
- **Content and data mapping:** `/auth/verify` reads `#token=…`, removes it from the address bar (`history.replaceState`), and posts `POST /api/v1/auth/magic-link/verify`. 200 `next: 'app'` → `/inbox`; `next: 'create-workspace'` → `/welcome`. 400 `link_expired` / `link_used` / `link_invalid` → the states below.
- **Conformance:** pass.

### sent
h1 "Check your email" · "We sent a sign-in link to **{email}**. It works once, for 15 minutes." · when `delayed: true`, an info `alert` "Your email may take a few minutes" · "Our email service is slow right now. We'll keep trying until the link expires." · `Use a different email` (`ghost`, back to the form) · caption "No email? Check your spam folder, or send a new link in a minute."
### verifying
h1 "Signing you in" with a spinner (after 300 ms) and `aria-busy` on the card.
### expired
h1 "This link has expired" · "Sign-in links work for 15 minutes. Send yourself a new one." · `Send a new link` (`primary`, to `/sign-in`).
### used
h1 "This link has already been used" · "Each link signs you in once. If that wasn't you, send a new link and sign in again." · `Send a new link` (`primary`).
### invalid
`link_invalid`, or no token in the URL: same as expired, with h1 "This link isn't valid".
### error
Network or 5xx: danger `alert` "We couldn't sign you in" · "Check your connection, then try the link again." · `Try again` (`primary`, posts again). The link is not consumed by a failed request.

## SCR-APP-003 — Create your workspace

- **Strategy and source:** code-native. Route `/welcome`, outside the shell; the app sends a signed-in user here when `/api/v1/me` returns `tenant: null`.
- **Composition:** `.auth` card; h1 "Create your workspace"; line "Signed in as {email}." (`text-secondary`); `field` "Business name (required)" (`text-input`, `autocomplete="organization"`, placeholder "e.g. Kaki Bakery"), help "Your customers see this name in the chat."; a `checkbox` "I agree to the [Terms of Service], [Acceptable Use Policy] and [Data Processing Agreement]" with each title a `link` to `/legal/:document` (new tab) and, below, a caption "Versions {tos version} · {aup version} · {dpa version}"; `Create workspace` (`primary`, full width); `Sign out` (`ghost`).
- **Content and data mapping:** versions from `GET /api/v1/auth/options` `terms`; submit → `POST /api/v1/workspaces` with `businessName` and `accepted` set to the versions shown. 201 → invalidate `me`, go to `/setup`.
- **Conformance:** pass. One checkbox for three documents, because AUTH-08 records three acceptances of one act; each document stays one click away.

### default
Empty name, unchecked box; `Create workspace` enabled (validation runs on submit, design.md §4.2).
### saving
`Create workspace` loading; fields read-only.
### validation
On submit with errors, a danger `alert` at the top listing each as a link to its field, focused: "Enter your business name" · "Agree to the terms to continue". Field-level errors as well.
### terms-updated
On 409 `terms_outdated`: warning `alert` "The terms were just updated" · "Review the new versions, then agree again." The checkbox is cleared and the versions refetched.
### declined
No server state: leaving the page (or `Sign out`) creates nothing. Signing in again lands here (UC-01 3a).
### error
Network or 5xx: danger `alert` "We couldn't create your workspace" · "Nothing was saved. Try again." with the input kept.

## SCR-APP-059 — System pages (session expired; account menu)

- **Strategy and source:** code-native. The existing `SessionExpired` page at `/session-expired` (unchanged look: `.auth` + `empty-state`, "Your session has ended" · "For your security, please sign in again." · [Sign in again]). New is when it is shown.
- **Content and data mapping:** any dashboard query that gets 401 `session_expired` routes here (idle 12 hours, 30 days old, signed out elsewhere); 401 `unauthorized` (no cookie) goes straight to `/sign-in` instead. A 403 `no_workspace` goes to `/welcome`.
- **Conformance:** pass.

### session-expired
As above. The body adds no reason (we don't say "signed out elsewhere", since the reason is not the visitor's business on a shared screen).

### account menu (shell top bar)
The `avatar` (initial of the email) becomes the trigger of a `menu` (Radix DropdownMenu, design.md §4.5) labelled "Account". Items: a non-interactive label with the email (`text-secondary`, `body-sm`); `Sign out`; after a divider, `Sign out of all devices` (danger text, as design.md §4.5 places danger items). Sign out → `POST /api/v1/auth/sign-out`, clear the query cache, go to `/sign-in`. Sign out of all devices → `POST /api/v1/auth/sign-out-everywhere`, same. Both are reversible by signing in again, so neither asks for confirmation (design.md §4.10 lists no sign-out).

## Supporting routes (not inventory screens)

- **`/setup`** (inside the shell): the wizard's entry route (UC-03 step 1). Until FEAT-009 it is the existing `Placeholder` "Set up your assistant" naming FEAT-009. No new screen ID: the wizard screens are SCR-APP-006 onward and belong to FEAT-009.
- **`/legal/:document`** (outside the shell): `.auth` card, h1 the document title, "Version {version}", and "The full text will be published here before the pilot." until the legal review (technical-design D9). Not an inventory screen; GOV-07's documents are SCR-APP-047 and SCR-OPS-009 later.

## Gaps and escalations

- design.md §5 rule 11 ("session expiry warn[s] before expiring and allow[s] extension where AUTH-02 permits"): the idle limit is extended by any use, and the 30-day absolute limit can't be extended, so there is nothing to warn about while the user is active. No pre-expiry warning is built; recorded as a gap on SCR-APP-059.
- No escalations to design.md: every element above is an existing component.
