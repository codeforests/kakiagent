# Technical design: FEAT-008 — My account: profile, email change, sessions list

> Implements: AUTH-05 (change profile name and email; a new email takes effect only once verified; the old email gets a notice; until then sign-in uses the old email), AUTH-02 (p: sign out, sign out of all devices, now per device and with live sockets closed) · Realizes: UC-02 step 6 (sign out one device or all) · Screens: SCR-APP-055 (completes it: name, email, devices; FEAT-006 built its two-step card) · Module: `identity` (users, sessions; architecture §5.2)
> Status: designed · 2026-10-31

## 1. Intent

A signed-in user can set the name their team and, from FEAT-042 on, visitors see ("Mei Ling joined", ux-foundations J4), change their sign-in email safely, and see every device they are signed in on and sign any of them out. Changing the email is a two-step move: the new address gets a confirmation link and the old one gets a notice; nothing changes until the link is opened, so a stolen session can't quietly move the account. Signing a device out, or signing out everywhere, also closes that device's open dashboard socket at once (the FEAT-007 open item).

## 2. Codebase context

- **Identity** (`packages/identity/src`): `users` (`email` unique, normalised; `google_sub`; no name yet) and `sessions` (`active_tenant_id`, `auth_method`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`; no device info) are identity-zone only (0007 grants: `users` SELECT, INSERT, UPDATE `(google_sub, last_sign_in_at)`; `sessions` SELECT, INSERT, UPDATE `(last_seen_at, active_tenant_id, revoked_at)`, 0037 adds `(mfa_at, reauth_at)`). `authenticate` (`sessions.ts`) rules: revoked, 30 days absolute, 12 hours idle. `revokeSession`, `revokeAllSessions` exist. `startSession` (`users.ts`) inserts the session. Magic links (`magic-link.ts`) show the identity mail pattern: HMAC token from the row id (`tokens.ts`), send now, retry by the scheduler sweep with `backoffSeconds`, SKIP LOCKED. `consumeMagicLink` resolves the user by the link's email via `findOrCreateUser`. Google sign-in binds `google_sub` on first use and refuses a different `sub` later (`google.ts`). `mfa.ts` `auditUserEvent(tx, userId, action)` appends a user-level event to each active workspace's chain. `requireReauth` (`reauth.ts`) gives 403 `reauth_required`.
- **API** (`apps/api/src/auth.ts`): `authFrom`, `meOf` → `Me { user: { id, email }, role, tenant, canApprove }`; `POST /auth/sign-out`, `POST /auth/sign-out-everywhere` (revoke, clear cookie). Rate limiter in deps (`rl:ml:e:`…). `team.ts` returns `TeamMember` (email, no name).
- **Realtime** (`apps/realtime/src/app.ts`): `/ws` subscribes to `channels.inbox(tenant)` and `channels.member(tenant, user)` (closes 4401 `session_ended`, FEAT-007). Nothing closes a socket when its own session is revoked.
- **Dashboard:** `/account` is `pages/account.tsx` (FEAT-006 two-step card + an `EmptyState` naming this feature); `shell/account-menu.tsx` shows the email initial and label, "Sign out", "Sign out of all devices"; re-auth guard `useReauthGuard` (`lib/reauth.ts`).
- **Design:** design.md §4.2 `field`/`text-input`, §4.3 `alert`, `toast`, `dialog`/`confirm-dialog`, §4.4 `card`, §4.5 `list`, `status-badge`, `avatar`; ux-foundations SCR-APP-055 (states default, email pending), J4 row (visitor sees the display name entered in My account).

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: my account (AUTH-05, AUTH-02; FEAT-008 §3)`)

```ts
DisplayName = z.string().trim().min(1).max(60).refine(noControlChars)   // shown to team and visitors
Account = z.object({
  email: z.string(), displayName: z.string().nullable(), googleLinked: z.boolean(),
  pendingEmail: z.object({
    email: z.string(), requestedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
    delivery: z.enum(['sent', 'queued']),
  }).nullable(),
})
ProfilePatch = z.object({ displayName: DisplayName.nullable() }).strict()   // null clears it
EmailChangeBody = z.object({ email: MagicLinkRequest.shape.email })          // trimmed, lower-cased
EmailChangeConfirmed = z.object({ email: z.string() })
DeviceSession = z.object({
  id: z.uuid(), device: z.string(),               // "Chrome on Windows", "Safari on iPhone", "Unknown device"
  authMethod: z.enum(['magic_link', 'google']),
  signedInAt: z.iso.datetime(), lastActiveAt: z.iso.datetime(), current: z.boolean(),
})
DeviceSessionList = z.object({ sessions: z.array(DeviceSession) })
// Changed: Me.user gains displayName: z.string().nullable(); TeamMember gains displayName: z.string().nullable()
// Reused: MagicLinkVerifyBody ({ token }) for the confirm body; ReauthRequired for 403s
```

| Route | Auth | Body | 2xx | Errors |
|---|---|---|---|---|
| `GET /api/v1/me/account` | `authFrom` | — | `Account` | 401 |
| `PATCH /api/v1/me/profile` | `authFrom` | `ProfilePatch` | 200 `Account` | 400 `validation` |
| `POST /api/v1/me/email-change` | `authFrom` + `requireReauth` (D3) | `EmailChangeBody` | 202 `Account` (pending; replaces any earlier pending request) | 403 `reauth_required`; 409 `same_email` (the current address); 429 `rate_limited` (5 per user per hour); 400 |
| `DELETE /api/v1/me/email-change` | `authFrom` | — | 204 (idempotent) | 401 |
| `POST /api/v1/email-change/confirm` | none (cookie not needed, D4) | `MagicLinkVerifyBody` | 200 `EmailChangeConfirmed` | 400 `link_expired` / `link_used` / `link_invalid` (cancelled reads as invalid); 409 `email_taken` |
| `GET /api/v1/me/sessions` | `authFrom` | — | `DeviceSessionList` (live sessions only: not revoked, not expired, not idle; current first, then by last active) | 401 |
| `DELETE /api/v1/me/sessions/:id` | `authFrom` | — | 204 | 404 (not yours, or not live); 409 `current_session` (use Sign out) |
| `POST /api/v1/auth/sign-out`, `/sign-out-everywhere` (changed) | as before | — | 204 as before | — ; **new:** each revoked session gets `session_ended` on `channels.session(id)` |

- `/me/*` uses `authFrom` (two-step `ok`), not `sessionFrom`: a user with no workspace can still manage their account. No tenant context; the user ID comes from the session only.
- Error envelope as today; identity gains `AccountError(code)` (`same_email`, `email_taken`, `current_session`, `not_found`) mapped in `app.ts`. Link errors reuse `LinkError`.

## 4. Schema changes (migration `0041_my_account.sql`, Drizzle DDL + hand-written grants in the same file)

| Table | Change |
|---|---|
| `users` | + `display_name text` null, check `users_display_name_ck (display_name is null or char_length(display_name) between 1 and 60)`. |
| `sessions` | + `user_agent text` null (the request's `User-Agent`, cut to 256 chars at insert; D6). |
| `email_changes` (new, identity zone, not tenant-scoped: it belongs to a user, like `magic_links`) | `id uuid` PK default random; `user_id uuid` → users not null; `old_email text`, `new_email text` (normalised) not null; `token_hash bytea` not null unique; `created_at`; `expires_at` (created + 24 hours); `confirmed_at`, `cancelled_at` null; `taken boolean` not null default false (the new address belonged to another user at request time: the email to it says so and carries no link, D5); `sent_at` null, `notice_sent_at` null, `send_attempts int` default 0, `next_attempt_at` default now. Partial unique `(user_id) where confirmed_at is null and cancelled_at is null` (one live request per user); index `(next_attempt_at) where sent_at is null or notice_sent_at is null`. |

- Grants to `app_identity`: `users` UPDATE `(email, display_name)` added to the existing columns; `sessions` INSERT already covers `user_agent`; `email_changes` SELECT, INSERT, UPDATE `(confirmed_at, cancelled_at, sent_at, notice_sent_at, send_attempts, next_attempt_at)`, DELETE (the purge). No grant to `app_dashboard` or `app_visitor`: names reach tenant screens only through identity-zone routes in this feature (see §8 for FEAT-042).
- Not tenant-scoped, so no RLS and no `TENANT_SCOPED_TABLES` entry, as `users`, `sessions` and `magic_links`. The RLS suite gains one assertion: `app_dashboard` and `app_visitor` can't select from `email_changes` or `users`.
- **Seed:** none (dev users keep a null name; the UI falls back to the email).
- **Rollback:** forward-only; dropping the table and the two columns reverses it.

## 5. Component design

### 5.1 Identity (`packages/identity/src`)
- `audit-user.ts`: `auditUserEvent` moves here from `mfa.ts` (unchanged; `mfa.ts` imports it) so account events share it. Payload `{}`: names and addresses are never audited (ADR-014).
- `account.ts`:
  - `getAccount(idDb, userId)` → `Account` view (the live, unexpired request only; `delivery` from `sent_at`).
  - `updateProfile(idDb, userId, displayName | null)` → update, audit `account.name_changed`.
  - `requestEmailChange(idDb, cfg, auth, rawEmail)` → one transaction: normalise; `same_email` if equal to the current; cancel any live request; `taken` = another user has the address; insert the row (`old_email` = current); audit `account.email_change_requested`. Then try to send both emails at once (5 s timeout each); failures stay queued for the sweep.
  - `sendEmailChange(idDb, mailer, cfg, id)` and the sweep `sendPendingEmailChanges` (magic-link pattern, SKIP LOCKED, `backoffSeconds`, while unexpired): to `new_email` the confirmation (`emailChangeConfirmEmail`, link `{PUBLIC_APP_URL}/verify-email#token=…`, 24 hours) or, when `taken`, `emailInUseEmail` (no link); to `old_email` the notice (`emailChangeNoticeEmail`: the new address masked as `m***@example.com`, "it changes only if confirmed from that address", and "if this wasn't you, sign in, cancel it on My account and sign out of all devices"). The sweep also deletes rows ended (confirmed, cancelled or expired) more than 7 days ago (D7).
  - `cancelEmailChange(idDb, userId)` → set `cancelled_at`, audit `account.email_change_cancelled` when a row changed.
  - `confirmEmailChange(idDb, token)` → one transaction: the atomic claim `update email_changes set confirmed_at = now() where token_hash = $1 and confirmed_at is null and cancelled_at is null and not taken and expires_at > now() returning user_id, old_email, new_email` (no row: look the hash up again to answer `link_used` / `link_expired` / `link_invalid`); `update users set email = new_email where id = user_id` (a unique violation → `email_taken`, the claim rolls back); `update users set google_sub = null` (the Google account belonged to the old address, D8); delete unconsumed `sign_in` magic links for the old address (they would otherwise create a new user, §2); audit `account.email_changed`. Sessions stay signed in (D9).
  - Token: `emailChangeToken(secret, id)` = HMAC(`MAGIC_LINK_SECRET`, `email-change:{id}`) in `tokens.ts` (domain-separated from `magic-link:` and `invite:`).
- `sessions.ts`:
  - `listSessions(idDb, userId, currentSessionId)` → live sessions with `deviceLabel(user_agent)`.
  - `revokeOwnSession(idDb, userId, sessionId, currentSessionId)` → `current_session` if equal; `update … where id = $1 and user_id = $2 and revoked_at is null and <live>`; no row → `not_found`; audit `session.revoked`.
  - `revokeAllSessions` returns the revoked IDs (was a count) for the realtime publish.
- `device.ts`: `deviceLabel(ua: string | null)` → "{Browser} on {OS}" from a short ordered table (Edge, Chrome, Firefox, Safari, Samsung Internet; Windows, macOS, iPhone, iPad, Android, Linux, ChromeOS); otherwise "Unknown device". Pure, no dependency, unit-tested.
- `startSession(tx, userId, method, preferTenant?, userAgent?)` stores the cut user agent; `consumeMagicLink`, Google callback and invitation accept pass it through from the request.
- `authenticate` and `AuthContext` gain `displayName` (same query), so `Me` and the account menu need no extra read. `listTeam` selects `display_name`.

### 5.2 API (`apps/api/src/account.ts`, `registerAccountRoutes(app, deps, { authFrom })`, wired at the end of `app.ts`)
- The §3 routes. Email change: limiter key `rl:email-change:u:{userId}` (5 per hour), then `requireReauth`. Confirm is public, takes no cookie and is limited per IP like magic-link verify.
- `auth.ts`: `meOf` adds `user.displayName`; sign-out and sign-out-everywhere publish `{ type: 'session_ended' }` on `channels.session(id)` after the revoke; the magic-link verify and Google callback pass `req.headers['user-agent']` to sign-in.
- `DELETE /me/sessions/:id` publishes on `channels.session(id)` after commit.
- Tests: `apps/api/test/account.int.test.ts` (from `testApp`, `sessionCookie`, `fakeMailer`, `staleReauth`): name set, cleared, too long 400, shows in `Me` and `GET /team`; email change without fresh re-auth 403; same email 409; request → two emails captured (link to new, notice with masked address to old) → magic link to the new address before confirming doesn't reach the account (a separate user) and to the old one still does → confirm → `Me.email` changed, `google_sub` cleared, old sign-in links dead, a second confirm `link_used`, expired `link_expired`; a new request kills the old link; cancel kills the link; taken address: 202, the email to it has no link, confirm `link_invalid`; address taken between request and confirm → 409 `email_taken`, email unchanged; rate limit 429; sessions list shows two sessions with device labels and `current`; revoke the other → it gets 401 `session_expired`; revoke current 409; another user's session 404; audit entries carry no email or name.

### 5.3 Realtime and scheduler
- `@kaki/platform` pubsub: `channels.session(sessionId)` = `s:{sessionId}`. `/ws` also subscribes to it and closes with 4401 `session_ended` (the same handler as `channels.member`). Test in `apps/realtime/test/ws.int.test.ts`: revoking one session closes its socket and leaves the user's other session's socket open.
- scheduler-worker runs `sendPendingEmailChanges` in the magic-link tick.

### 5.4 Dashboard (detail in ui-design.md)
- `lib/account.ts`: `useAccount`, `useUpdateProfile`, `useRequestEmailChange` (through `useReauthGuard`), `useCancelEmailChange`, `useSessions`, `useRevokeSession`, `accountErrorText(code)`; on profile or email success it invalidates `me`.
- `pages/account.tsx` gains Profile, Email and Devices cards above the two-step card (parts in `pages/account-parts.tsx`); the placeholder goes.
- `pages/verify-email.tsx` at `/verify-email` in `AuthLayout`, outside `AppShell` (token from `#token=` into memory, then `history.replaceState`), a state of SCR-APP-055 (D10).
- `shell/account-menu.tsx`: the avatar shows the name's initial when set; the label shows the name above the email.
- `pages/team-parts.tsx`: the member row's primary text is the name when set, the email as secondary.

### 5.5 E2E (`e2e/tests/account.e2e.ts`)
A fresh address `acct+{run}@kaki-bakery.test` signs in and creates a workspace through the API (dev owners' addresses stay untouched for other specs). Name: set → shown in the account menu → cleared. Email: change to `acct2+{run}@…` → Mailpit has the confirmation at the new address and the notice at the old → the page shows pending → a sign-in link to the old address still signs in → open the confirmation → "Your email is now …" → sign out, sign in with the new address lands in the same workspace. Devices: a second browser context signs in as the same user → the first lists two devices and signs out the other → the second context's next load shows sign-in. axe at 1280 and 375 (tall viewport), light and dark, on My account (default and pending) and each `/verify-email` state.

## 6. Acceptance criteria

- **AC-1** (AUTH-05 "change their profile name") A user sets, changes or clears a display name of 1–60 characters; it appears in the account menu, `Me.user.displayName` and their Team row; invalid names are refused with a field error; the change is audited `account.name_changed` with no name in the entry.
- **AC-2** (AUTH-05 "a new email takes effect only after it is verified"; "until verified, sign-in still uses the old email") Requesting a change (after a fresh re-authentication) sends a single-use 24-hour confirmation link to the new address and leaves the account's email unchanged: sign-in still works with the old address, not the new one. Opening the link changes the email; a used, expired, replaced or cancelled link is refused with the matching state.
- **AC-3** (AUTH-05 "the old email receives a notice of the change") Every request sends the old address a notice naming the new address masked, before anything changes; both emails are queued and retried if the provider fails.
- **AC-4** (AUTH-05; account safety) The user can cancel a pending change or replace it with a new request (the earlier link stops working). The same address is refused (409). An address that belongs to another account gets an "already in use" email instead of a link and the response doesn't reveal it; if the address is taken by the time the link is opened, the change is refused (409 `email_taken`). Confirming clears the Google link and kills unused sign-in links for the old address.
- **AC-5** (AUTH-02 "users can sign out, and sign out of all devices"; UC-02 6) My account lists the user's live sessions with a device label, sign-in method, signed-in and last-active times, and marks this device; the user signs out any other session (its next API call gets 401) or all of them; signing out this device from the list is refused in favour of Sign out.
- **AC-6** (AUTH-02 "the old session cannot call any API"; FEAT-007 open item) A session ended by sign-out, sign out of all devices or the devices list also has its open dashboard socket closed (4401 `session_ended`); the user's other sessions' sockets stay open.
- **AC-7** (ADR-005, ADR-014, ADR-020) `/me/*` acts only on the session's own user (another user's session ID is 404); `email_changes` and `users` are unreadable by the dashboard and visitor zones; audit entries for account events carry IDs only.
- **AC-8** (SCR-APP-055, NFR-19, NFR-09) My account shows the Profile, Email (default, pending, queued) and Devices cards with loading, error with Try again and saving states, plus the confirm dialogs; `/verify-email` shows confirming, confirmed, expired, used, invalid, taken and error; axe reports no serious or critical issues at 1280 and 375, light and dark.

## 7. Decisions

- **D1 — The display name lives on `users`, not on memberships.** AUTH-05 says "their profile name": one person, one name across workspaces. It is optional; screens fall back to the email for the team, and FEAT-042 decides the visitor-facing fallback (§8).
- **D2 — Email change is a request row, not a sign-in link.** `email_changes` keeps the new address apart from `users` until it is confirmed, so "until verified, sign-in still uses the old email" holds by construction; the magic-link retry pattern carries both emails.
- **D3 — Requesting an email change needs a fresh re-authentication**, although AUTH-03's list doesn't name it. Moving the sign-in address is how a stolen session becomes a stolen account; the re-auth dialog already exists, and this is stricter than the SRS, not in conflict with it. Name changes and signing devices out need none.
- **D4 — The confirmation link works without being signed in.** It proves control of the new address and is bound to the user by its row; requiring a session would break opening it on a phone. Single use, 24 hours, HMAC token stored as a hash (FEAT-005 D6).
- **D5 — The request never reveals whether an address has an account.** A taken address gets an "already in use" email with no link, matching AUTH-01's non-disclosure; the account can't be merged into another.
- **D6 — Devices are labelled from the User-Agent only; no IP address is stored.** The label is enough to recognise a device, and an IP is personal data we'd have to justify and purge (PDPA minimisation, ADR-015). Stored cut to 256 characters; old sessions show "Unknown device".
- **D7 — Email-change rows are purged 7 days after they end** (both addresses are personal data with no later use), by the sweep.
- **D8 — Confirming clears `google_sub`.** The Google account was tied to the old address; Google sign-in rebinds on its next use with the new one.
- **D9 — Other sessions stay signed in after an email change.** The notice to the old address tells the user how to sign out everywhere if they didn't ask; forcing a sign-out would also punish the legitimate case.
- **D10 — `/verify-email` is a state of SCR-APP-055, not a new screen ID.** It is the second half of the screen's "email pending" flow; a new ID would amend the signed-off ux-foundations inventory.

## 8. Escalations and open items

- **For FEAT-042 (takeover):** visitors see the staff member's name (J4). The dashboard and visitor zones can't read `users`, so FEAT-042 should snapshot the name (or "A team member" when unset) onto the takeover event when it happens, through the identity-zone session that takes over, rather than grant a cross-zone read. Recorded here so its design starts from it.
- Sign out of all devices keeps today's behaviour (this device too) and stays in the account menu; the Devices card offers it as well.
- Not here: avatars or photos, notification preferences (later features), operator accounts (FEAT-070).

## 9. Self-check

- Every AUTH-05 clause maps to an AC (AC-1–AC-4); AUTH-02's sign-out clauses → AC-5, AC-6; UC-02 6 → AC-5.
- No new tenant-scoped table; `email_changes` follows the identity-zone pattern of `magic_links` (no RLS, identity grants only), asserted in the RLS suite (AC-7). User ID only from the session; confirm takes the user from the token's row.
- Audit entries carry IDs and action codes only (ADR-014); emails follow the identity retry pattern, not the outbox (FEAT-005 §5.3).
- Module boundaries: identity owns everything; api, realtime and scheduler wire it; no model calls; the agent pipeline is unchanged.
- UI uses design.md's `card`, `field`, `text-input`, `button`, `alert`, `status-badge`, `list`, `confirm-dialog`, `toast`, `skeleton`, `error-state`; tokens only.

Traceability: AUTH-05 → AC-1, AC-2, AC-3, AC-4, AC-8; AUTH-02 (p) → AC-5, AC-6; UC-02 6 → AC-5; ADR-005, ADR-014, ADR-020 → AC-7; SCR-APP-055 → AC-8.
