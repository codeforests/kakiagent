# UI Design: FEAT-006 — Two-step verification and re-authentication

> Screens: SCR-APP-005 (new), the `reauth-dialog` (design.md §4.3, first use), SCR-APP-055 (p: two-step card), SCR-APP-045 (p: require two-step), SCR-APP-002 (adds re-auth and two-step outcomes) · Mode: per-feature · Status: Draft · Date: 2026-10-28

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so these are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `AuthLayout` (the FEAT-005 sign-in card), `field`, `text-input`, `checkbox`, `toggle`, `button` (`primary`, `secondary`, `ghost`, `danger-ghost`), `alert`, `card`, `dialog`/`confirm-dialog` (bottom sheet below 640 px), `toast`, `spinner`, `skeleton`, `empty-state`. No new component or token. Copy: "two-step verification" everywhere (never "MFA" or "2FA" in the UI), "authenticator app", "code", "recovery code".

**Code inputs (all screens):** one `text-input`, label "6-digit code", `inputmode="numeric"`, `autocomplete="one-time-code"`, `maxlength` 7 (a space is allowed), monospace digits (`--font-family-mono`), width 12 ch. Recovery inputs: label "Recovery code", `autocomplete="off"`, `autocapitalize="off"`, placeholder "e.g. abcde-fghij". Spaces and hyphens are ignored. Submit on Enter; validated on submit only ("Enter the 6 digits from your authenticator app" when not 6 digits).

## SCR-APP-005 — Two-step verification

- **Strategy and source:** code-native (this section). Routes: `/two-step` (challenge) and `/two-step/setup` (enrolment), both outside the shell in `AuthLayout`. Roles: all.
- **Contract bindings:** `GET /api/v1/auth/mfa`, `POST /api/v1/auth/mfa/challenge`, `POST /api/v1/auth/mfa/enrolment`, `POST /api/v1/auth/mfa/enrolment/confirm`, `GET /api/v1/auth/reauth`, `POST /api/v1/auth/reauth`, `POST /api/v1/auth/reauth/email`.

### Challenge (`/two-step`, state `challenge`)
- Lucide `shield-check` 40 px (accent), title "Enter your code", body "Open your authenticator app and enter the 6-digit code for KakiAgent." Caption: "Signing in as {email}".
- Code field, `primary` full-width "Continue" (busy: "Checking…"). Below: `ghost` link-button "Use a recovery code" → recovery state; caption link "Not you? Sign out" (`POST /auth/sign-out` → `/sign-in`).
- **Wrong code:** field error "That code didn't work. Check the time on your phone is set automatically, then try the newest code." Plus "{n} tries left" when `attemptsLeft ≤ 2`. Focus stays in the field, value cleared.
- **Success:** to the page the user was going to (`?next=` kept from the redirect, same-origin paths only), else `/inbox`.

### Recovery (`/two-step`, after "Use a recovery code")
- Title "Use a recovery code", body "Enter one of the recovery codes you saved when you set up two-step verification. Each code works once."
- Recovery field, `primary` "Continue". `ghost` "Use your authenticator app instead" → challenge.
- Wrong: "That recovery code didn't work. Check for typos; used codes don't work again." Too many (429 `too_many_attempts`): `alert` warning "Too many tries. Wait 15 minutes, then try again."
- **Success with few codes left** (≤ 3, from `GET /auth/mfa`): before continuing, an interstitial in the same card: `alert` warning "You have {n} recovery codes left." with `primary` "Get new codes" (→ `/account#two-step`) and `secondary` "Later".

### Locked (`/two-step`, 429 `mfa_locked` or `lockedUntil` set)
- Lucide `lock` 40 px (warning), title "Too many wrong codes", body "For your security, codes from your app won't work until {h:mm a} (15 minutes). You can still sign in with a recovery code."
- `primary` "Use a recovery code" → recovery state; caption link "Sign out". The challenge form is hidden until the time passes (the page re-reads status on focus).

### Enrol (`/two-step/setup`)
Three steps in one card, with "Step {n} of 3" as `page-lede`:
1. **Scan** — title "Set up two-step verification", body "Each time you sign in, you'll enter a code from an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password." The QR (SVG from `uqr`, 192 px square on a white `surface` plate with 16 px quiet zone, `role="img"`, `aria-label` "QR code for your authenticator app") above "Can't scan it? Enter this key:" and the key in `--font-family-mono`, grouped in fours, with a `ghost` "Copy key" (toast "Key copied"). `primary` "Next".
2. **Confirm** — "Enter the 6-digit code your app shows for KakiAgent." Code field, `primary` "Turn on two-step verification" (busy "Turning on…"); `ghost` "Back". Wrong: "That code didn't work. Make sure you scanned the code on this screen, then enter the newest code."
3. **Save recovery codes** — title "Save your recovery codes", body "If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe, like a password manager. You won't see them again." Codes in a two-column grid (`--font-family-mono`, subtle fill, radius md, `aria-label` "Recovery codes", one `li` each). Buttons `secondary` "Copy codes" (toast "Codes copied") and `secondary` "Download" (`kakiagent-recovery-codes.txt`). `checkbox` "I've saved these codes" (required), then `primary` "Continue" (disabled until checked, with the reason as help text).
- **Forced variant** (state `enrol`, the workspace requires it): above step 1 an `alert` info "{Workspace} requires two-step verification. Set it up to open the dashboard." No way out but "Sign out" (caption link). After step 3, Continue → `/inbox`.
- **Voluntary variant** (from My account): `ghost` "Cancel" on steps 1–2 back to `/account`; Continue → `/account` with toast "Two-step verification is on."
- **Re-auth first:** starting enrolment may return `reauth_required`; the page opens the `reauth-dialog` before step 1 (the guard), then continues. A user who signed in within 10 minutes (the usual forced case) sees no dialog.
- **States:** loading (skeleton of the card: QR square and three lines), scan, confirm, codes, confirm failed, start failed (`alert` danger "We couldn't start setup. Check your connection and try again." [Try again]), already enrolled (409 → to `/account`).
- **Responsive:** at 375 px the card is full width with 16 px gutter; QR stays 192 px; codes grid stays two columns (each code fits 11 ch).
- **A11y:** each step's title is the `h1` and receives focus on step change; the codes list is announced with its count; Continue's disabled reason is linked by `aria-describedby`.

## `reauth-dialog` — Confirm it's you (design.md §4.3)

- **Strategy and source:** code-native (this section). Opened by `useReauthGuard` on a 403 `reauth_required` from any sensitive action, over the current page; `dialog` (bottom sheet below 640 px). Contract bindings: `GET /api/v1/auth/reauth`, `POST /api/v1/auth/reauth`, `POST /api/v1/auth/reauth/email`.
- Title "Confirm it's you". Body "This is a sensitive change, so we need to check it's really you."
- **Authenticator mode** (`methods` has `totp`): code field, `primary` "Confirm" (busy "Checking…"), `secondary` "Cancel"; `ghost` "Use a recovery code" swaps the field. Errors as in the challenge; locked shows the locked message with "Use a recovery code".
- **Email mode** (`methods` is `['email']`): body adds "We'll email a confirmation link to {email}." `primary` "Email me a link" (busy "Sending…"). Then the waiting state: Lucide `mail` 24 px, "Check your email. Open the link in this browser; this window carries on by itself." with `spinner`, caption "Didn't get it? [Send another link]" (enabled after 30 s) and `secondary` "Cancel". The dialog polls `GET /auth/reauth` every 3 s and on window focus; `fresh: true` → success. Rate-limited: `alert` warning "Too many links for now. Try again in 15 minutes."
- **Success:** the dialog closes and the original action runs again at once; its own busy state and toast follow (no extra click, no toast from the dialog).
- **Cancel / Esc:** closes, the action isn't performed, focus returns to the control that started it; nothing else changes. Esc and the scrim don't close while a code is being checked.
- **A11y:** `role="dialog"`, title as name; initial focus on the code field (authenticator) or "Email me a link"; the waiting text is a `role="status"` live region.

## SCR-APP-002 — Verify link (additions)

- `next: 'mfa'` → `/two-step`; `next: 'mfa-enrol'` → `/two-step/setup`.
- `next: 'reauthed'` → card with Lucide `circle-check` (success): title "You're confirmed", body "Go back to the tab where you were making the change. It carries on by itself." and a `secondary` "Close this tab" (calls `window.close()`, hidden when the browser won't allow it).
- `link_other_session` → title "Open this link in the browser you were using", body "This confirmation link only works in the browser where you asked for it. Copy it into that browser, or start the change again here." `primary` "Go to the dashboard".

## SCR-APP-055 — My account (part: two-step verification)

- Route `/account` in the shell, linked as "My account" (first item) in the account menu. Page title "My account"; the rest of the page is an `empty-state` "Your name, email and devices arrive here soon." naming FEAT-008 (the `Placeholder` pattern) below the card. Contract: `GET /api/v1/auth/mfa`, `POST /api/v1/auth/mfa/recovery-codes`, `DELETE /api/v1/auth/mfa`.
- **Two-step card** (`card`, `id="two-step"`, `h2` "Two-step verification"):
  - **Off:** "Add a code from your phone each time you sign in, so a stolen email can't open your account." `primary` "Set up" → `/two-step/setup`.
  - **On:** status line with Lucide `shield-check` (success) "On since {d MMM yyyy}"; "{n} recovery codes left" (warning text and icon when ≤ 3). Actions: `secondary` "Get new recovery codes" (confirm-dialog "Get new recovery codes?" / "Your old codes stop working." / "Get new codes"; then the codes in a dialog with Copy, Download and "Done"); `danger-ghost` "Turn off" (confirm-dialog "Turn off two-step verification?" / "You'll sign in with just your email link or Google." / "Turn off"; toast "Two-step verification is off.").
  - **Required:** when `requiredBy` isn't empty, "Turn off" is disabled with help "{Workspace} requires two-step verification." (a 409 shows the same text in an `alert`).
  - All three actions go through the re-auth guard.
- **States:** loading (skeleton card), error (`error-state` "We couldn't load your two-step setting." [Try again]), off, on, on with few codes, required.

## SCR-APP-045 — Team (part: require two-step verification)

- Route `/settings/team`; the Settings "Team" row now links it. Page title "Team"; below the card an `empty-state` "Members, roles and invitations arrive here soon." naming FEAT-007. Contract: `GET /api/v1/team/mfa`, `PUT /api/v1/team/mfa`.
- **Card** `h2` "Two-step verification": `toggle` labelled "Require two-step verification for everyone in {workspace}", help "{enrolled} of {members} members use it."
  - Turning on (sensitive, design.md §4.10): confirm-dialog "Require two-step verification?" / "{members − enrolled} members who haven't set it up will have to before they can use the dashboard again." (or "Everyone already uses it." when 0) / "Require it". Then re-auth if needed, then the toggle changes from the response; toast "Two-step verification is now required."
  - Turning off: confirm-dialog "Stop requiring two-step verification?" / "Members can turn it off for themselves." / "Stop requiring"; toast "Two-step verification is no longer required."
  - Owner not enrolled: toggle disabled with help "Set up two-step verification for yourself first." + link "Set up" (`/two-step/setup`).
  - Admin and Agent: the toggle is read-only (`aria-disabled`, not focus-trapped) with help "Only the Owner can change this."
- **States:** loading (skeleton), error (`error-state` [Try again]), off, on, owner not enrolled, read-only, saving (toggle shows a 12 px `spinner`, never optimistic), save failed (`alert` danger "We couldn't change this. Check your connection and try again.").

## Gaps and escalations

- None against design.md: `reauth-dialog` lists "magic link, Google or TOTP"; this feature offers TOTP/recovery or the emailed link (technical-design D4). Google re-prompt is a later addition, not a design change.
