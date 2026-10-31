# UI Design: FEAT-008 — My account: profile, email change, sessions list

> Screens: SCR-APP-055 (completes My account: name, email change, devices; plus its "Confirm new email" state at `/verify-email`), the top bar's account menu and the Team member row (name shown) · Mode: per-feature · Status: Draft · Date: 2026-10-31

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `card`, `field`, `text-input`, `button` (`primary`, `secondary`, `ghost`, `danger-ghost`), `alert`, `status-badge`, `list`, `dialog`/`confirm-dialog` (bottom sheet below 640 px), `reauth-dialog` (FEAT-006), `toast`, `skeleton`, `error-state`, `avatar`, `menu`, `AuthLayout` (the sign-in card), `spinner`. No new component or token. Copy says "email address", "device", "sign out" (never "session" or "revoke" in the UI).

## SCR-APP-055 — My account (name, email, devices)

- Route `/account` (unchanged), all roles, and users without a workspace. Order: `h1` "My account", `page-lede` "How your team sees you, how you sign in, and where you're signed in." Then four `card`s, each with an `h2`, stacked with `--space-6` between, max content width as other settings pages: **Profile**, **Email address**, **Devices**, then FEAT-006's **Two-step verification**, unchanged. The FEAT-008 placeholder goes.
- **Contract bindings:** `GET /api/v1/me/account`, `PATCH /api/v1/me/profile`, `POST /api/v1/me/email-change`, `DELETE /api/v1/me/email-change`, `GET /api/v1/me/sessions`, `DELETE /api/v1/me/sessions/:id`, `POST /api/v1/auth/sign-out-everywhere`, `POST /api/v1/email-change/confirm`, plus FEAT-006's two-step routes.

### Profile card (`h2` "Profile")
- Field "Your name" (`text-input`, `autocomplete="name"`, `maxlength` 60, value the current name or empty), help "Your team sees this. When you take over a chat, the customer sees it too." `primary` "Save" at the right of the field (below it < 640), disabled until the value differs from the saved one ("Saving…" while pending).
- Validated on submit: empty with a saved name → saved as cleared (the help then says "Your team sees your email address until you add a name."); over 60 characters or control characters → field error "Use up to 60 letters, numbers and spaces." Success: toast "Name saved." Focus stays on the field.

### Email address card (`h2` "Email address")
- **Default:** the address in `--type-body` weight 500 with help "You sign in with this address." When `googleLinked`, a second line with the Google glyph: "Google sign-in is linked to this address." `secondary` "Change email".
- **Change dialog** (`dialog`, form, opened by "Change email"; the request goes through the re-auth guard, so "Confirm it's you" may come first and the request then runs on its own): `h2` "Change your email address". Field "New email address" (`text-input` type email, `autocomplete="email"`). Body "We'll send a link to the new address. Nothing changes until you open it. We'll also tell {current email} about the change." `secondary` "Cancel", `primary` "Send link" ("Sending…"). Errors in the field: `same_email` "That's already your email address."; invalid "Enter an email address like name@example.com."; 429 `alert` warning in the dialog "Too many changes. Try again in an hour." Success: dialog closes, toast "Check {new email} for the link.", focus back to the card's action button.
- **Pending:** an `alert` info inside the card: title "Waiting for you to confirm {new email}", body "Open the link we sent there by {expiry, d MMM h:mm a}. Until then you still sign in with {current email}." With `delivery: queued`, a `status-badge` neutral "Sending…" and help "We'll keep trying to send it." Actions: `secondary` "Send a new link" (re-sends the same address through the request, toast "New link sent to {new email}.") and `danger-ghost` "Cancel change" (`confirm-dialog` "Cancel the change to {new email}?" / "The link we sent stops working. You keep signing in with {current email}." / `secondary` "Keep it", `danger` "Cancel change"; toast "Change cancelled."). "Change email" becomes "Use a different address" (the same dialog; a new request replaces the pending one).
- The page re-reads the account on window focus, so after confirming in another tab the card shows the new address with a toast "Your email address is now {email}." when it changed.

### Devices card (`h2` "Devices")
- `page-lede`-sized help "Where you're signed in now. Sign out anything you don't recognise."
- `list` (one layout at every width; rows 56 px with two lines): Lucide `monitor` or `smartphone` 20 px (smartphone for iPhone, iPad and Android labels) · primary text the device label ("Chrome on Windows") · secondary "Signed in {d MMM} with {email link | Google} · Active {relative: 'now' under 2 minutes, '5 min ago', 'today 14:02', '3 Nov'}". This device first, with a `status-badge` success "This device" and no action. Other rows: `ghost` "Sign out" (accessible name "Sign out Chrome on Windows").
- Sign out one → `confirm-dialog` "Sign out {device}?" / "Anyone using it will need to sign in again." / `secondary` "Cancel", `danger` "Sign out". The row disappears, toast "Signed out {device}.", focus moves to the Devices heading. A 404 (already ended) removes the row quietly and refetches.
- Below the list, when there are other devices: `danger-ghost` "Sign out of all devices" → `confirm-dialog` "Sign out of all devices?" / "You'll be signed out here too, and everywhere else you're signed in." / `danger` "Sign out everywhere" → the existing sign-out-everywhere flow (to `/sign-in`).
- **Only this device:** the list has one row and the help line reads "You're only signed in here."

### States
- Each card loads on its own: loading (`skeleton` card with two lines), error (`error-state` inside the card: "We couldn't load your profile." / "…your email address." / "…your devices." [Try again]). Profile and Email come from one request, so they share loading and error.
- Default (no name, no pending change, one device), named, pending, pending with queued delivery, several devices, saving (buttons busy), the change dialog with each error, both confirm dialogs, the re-auth dialog over the change dialog.

### Confirm new email (`/verify-email`, a state of SCR-APP-055, D10)
- Outside `AppShell`, in `AuthLayout` (works signed in or not). The token is read from `#token=`, held in memory and removed with `history.replaceState`; the page posts confirm once on load.
- **Confirming:** `spinner` and "Confirming your new email address…".
- **Confirmed:** Lucide `mail-check` 40 px (success), title "Your email address is now {email}", body "Use it the next time you sign in." `primary` "Go to My account" (signed in) or "Sign in" (not signed in; to `/sign-in`).
- **Expired** (`link_expired`): Lucide `clock` (warning), "This link has expired", body "Links work for 24 hours. Ask for a new one on My account." `primary` "Go to My account".
- **Used** (`link_used`): "This link was already used", body "If your email didn't change, ask for a new link on My account."; same action.
- **Invalid** (`link_invalid`, also cancelled, replaced or no token): "This link doesn't work", body "It may have been replaced by a newer link or cancelled."; same action.
- **Taken** (`email_taken`): Lucide `alert-triangle` (danger), "That address already has an account", body "Your email address hasn't changed. Choose a different one on My account."; same action.
- **Error** (network or 5xx): `error-state` "We couldn't confirm your email address." [Try again] (re-posts the held token).
- Each state's title is the focused `h1` on arrival.

## Account menu (top bar, design.md §4.5 `menu`)
- The avatar shows the first letter of the name when set (a CJK name's first character), else of the email. The menu label shows the name (body, 500) above the email (caption, text-secondary); the email alone when no name.

## Team member row (SCR-APP-045, FEAT-007 layout)
- The Person cell's primary text is the name when set, with the email as secondary text below; the email alone otherwise. Dialog titles and toasts that said "{email}" use the name when set.

## Gaps and escalations

- Visitor-facing display of the name is FEAT-042's (technical-design §8).
- Manifest: SCR-APP-055 moves to FEAT-008 with the new states, contracts and this spec; its FEAT-008 gap closes. SCR-APP-045 gains the "member names" state.
