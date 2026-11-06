# UI design: FEAT-056 — Signed mobile approval links

> Screens: SCR-APP-018 (p: the signed-link landing at `/approve` and its states; the approval itself is FEAT-055's) · Mode: per-feature · Status: Draft · Date: 2026-11-06

Components from design.md: the auth layout of SCR-APP-001/002 (`AuthLayout`: logo, one card, `h1` that takes focus when the state changes), `alert`, `button` (`primary`, `secondary`), `text-input`, `spinner`, `link`. Terms: *approval*, *sign-in link*. No new tokens; only `var(--…)`.

## SCR-APP-018 — Approval: link landing (`/approve`)

The page the alert's "Review and approve" button opens. Outside the app shell (no sidebar or tab bar), so it reads well on a phone straight from an email. One `AuthLayout` for every state, keyed by state (`focusKey`), so each change moves focus to the new `h1`. The token is read from `#token=` and the hash is removed from the address bar at once; it is never shown.

| State | When | `h1` | Body | Actions |
|---|---|---|---|---|
| **Checking** | while `open` runs | "Opening your approval" | `spinner` with "Checking your link…" (`aria-busy` on the card) | none |
| **Sign in** | `sign_in` | "Sign in to review this approval" | "For your security, approval links only work for the signed-in team member they were sent to." Email field "Work email" as on SCR-APP-001 (same validation text) | `primary` "Email me a sign-in link"; divider "or"; `secondary` "Continue with Google" (when offered) |
| **Check your email** | after the email form | "Check your email" | "We sent a sign-in link to **{email}**. Open it on this phone and you'll go straight to the approval. It works once, for 15 minutes." | `secondary` "Use a different email" (back to Sign in) |
| **Link expired** | 410 | "This link has expired" | "Approval links last 24 hours. The request may still be waiting in your approvals." | `primary` "Open approvals" → `/approvals` |
| **Already used** | 409 | "This link has already been used" | "Each approval link works once. Open your approvals to find the request." | `primary` "Open approvals" → `/approvals` |
| **Not valid** | 400, or no token | "This link isn't valid" | "It may have been copied incompletely. Open your approvals instead." | `primary` "Open approvals" → `/approvals` |
| **Wrong account** | 403 `wrong_account` | "This link is for another team member" | "You're signed in as **{your email}**. Sign out, then sign in as the team member this was sent to." | `primary` "Sign out and switch" (signs out, back to Sign in with the token kept); `secondary` "Open my approvals" |
| **No longer on the team** | 403 `not_member` | "You no longer have access" | "Your access to this business has ended, so you can't review its approvals. Ask the Owner if this is a mistake." | `secondary` "Go to KakiAgent" → `/` |
| **Can't check** | network or 5xx | "We couldn't open your link" | `alert` danger "Check your connection and try again." | `primary` "Try again" (re-posts the kept token) |

- **Opened** has no screen: the page replaces itself with `/approvals/:id` (FEAT-055 SCR-APP-018), which shows pending with actions in the phone's sticky footer, or "already approved by …", "expired", "not delivered" when the approval moved on. When the session switched business, the top bar's business name shows the approval's business.
- **Two-step owed:** goes to SCR-APP-005/006 with `next=/approve`, then back here, then to the approval; no extra copy.
- Sign-in from this page by email returns to the approval in whichever browser opens the sign-in link (the link carries the approval token). The "Open approvals" actions go through normal sign-in when signed out.
- Errors use the `alert` danger style only for "Can't check"; the dead-link states are informational (no alert colour), since nothing is wrong with what the approver did.
- Live region: state changes are announced by the focused `h1`; no `role="status"` on the page (E2E pitfall in code-map).
- Phone: card full width with the 16 px gutter; buttons full width (`auth__wide`), at least 44 px tall.

### Alert email (FEAT-052's `approval_pending`, copy only)

- Button "Review and approve"; under it, muted text "This link works once, for 24 hours. You'll be asked to sign in."
- Digest: each approval item's link is its own; the same line appears once under the list when any item is an approval.

## Manifest

`docs/design-manifest.json` SCR-APP-018: `states.covered` gains the landing states, `gaps` empties, `contract_bindings` gains `POST /api/v1/approval-links/open`, and the source lists this file's section too.
