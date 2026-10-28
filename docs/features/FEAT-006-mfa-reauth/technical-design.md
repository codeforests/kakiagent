# Technical Design: FEAT-006 — Two-step verification and re-authentication for sensitive actions

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E1) · Milestone: M2
> Implements: AUTH-03 (p: TOTP enrolment with recovery codes, Owner-enforced MFA, the 10-minute re-auth window and `identity.requireReauth`. Operator MFA is FEAT-070; each AUTH-03 sensitive action is wired to `requireReauth` by the feature that builds it, D9) · Realizes: UC-02 steps 3, 3a, 3c · Screens: SCR-APP-005 (new), the `reauth-dialog` (design.md §4.3), SCR-APP-055 (p: the two-step section), SCR-APP-045 (p: "Require two-step verification") (see [ui-design.md](ui-design.md))
> Status: Designed · Date: 2026-10-28

## 1. Intent

Tenant users can turn on two-step verification with any TOTP authenticator app. Enrolment shows a QR code and a manual key, confirms one code, then shows ten single-use recovery codes once. After a magic link or Google sign-in, an enrolled user's session can do nothing but answer the code challenge; five wrong codes lock the code challenge for 15 minutes, and a recovery code still gets the user in. The Owner can require two-step verification for the whole workspace: from the next request, every member without it can only reach enrolment. Sensitive actions call `requireReauth`, which refuses a session whose last fresh authentication is older than 10 minutes; the dashboard's `reauth-dialog` then asks for a TOTP code (enrolled users) or sends a confirmation link (everyone else) and retries the original action on its own.

## 2. Codebase context

- **Identity module** (`packages/identity`, FEAT-005): `authenticate(idDb, token)` (`sessions.ts`) is one query per request returning `AuthContext` or a failure reason; `startSession(tx, userId, method)` (`users.ts`) mints every session and decides `next`; `consumeMagicLink` (`magic-link.ts`) claims a link atomically; links are HMAC(secret, link ID) so the sweep can re-send them (FEAT-005 D6). Exports in `src/index.ts`.
- **Sessions:** `sessions.reauth_at` already exists (= sign-in time) and is unused; no `mfa_at` yet (ADR-020 names it). `app_identity` may update `last_seen_at`, `active_tenant_id`, `revoked_at` only (0007).
- **API:** `registerAuth` (`apps/api/src/auth.ts`) returns `authFrom` (any signed-in session) and `sessionFrom` (tenant routes); errors are mapped in `app.ts`'s `setErrorHandler`; the CSRF Origin hook covers every `/api/` POST. Realtime's `/ws` calls `authenticate` and closes with 4401/4403.
- **Dashboard:** `main.tsx` `routeAuthError` sends 401 `unauthorized`/`session_expired` and 403 `no_workspace` to their pages from the query and mutation caches; out-of-shell pages use `AuthLayout` (`pages/auth-layout.tsx`); `/auth/verify` posts the fragment token (FEAT-005 D4); the account menu is `shell/account-menu.tsx`; Settings rows without `to` are unbuilt (`pages/settings.tsx`, "Team").
- **Sealing:** `localSealer`/`SecretSealer` (AES-256-GCM with AAD) live in `packages/channels/src/secrets.ts` (FEAT-034 D5), not yet wired into any role.
- **Capabilities:** `can(role, capability)`; no Owner-only capability exists yet.
- **No sensitive action exists yet:** AUTH-03's list (delete tenant, transfer ownership, support access, exports, PDPA deletion, boundary rules) arrives with FEAT-010, -054, -050/-060, -062 and others; FEAT-054 (boundary rules) is next in the order.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: two-step verification and re-auth (AUTH-03; FEAT-006 §3)`)

All under the existing session cookie and CSRF hook. "Pending" means a session whose `mfa` state is `challenge` or `enrol` (§5.2); every route not marked as allowing it refuses a pending session.

| Route | Allowed for | Body → response | Errors |
|---|---|---|---|
| `GET /api/v1/auth/mfa` | any session, pending too | → `MfaStatus { state: 'ok'\|'challenge'\|'enrol', enrolled, enrolledAt: iso\|null, recoveryCodesLeft: int, requiredBy: { tenantId, name }[], lockedUntil: iso\|null, email }` | — |
| `POST /api/v1/auth/mfa/challenge` | `challenge` | `MfaCode { method: 'totp'\|'recovery', code }` → 204; sets `mfa_at` and `reauth_at` | 400 `code_invalid` `{ attemptsLeft }` (TOTP) / `{}` (recovery) · 429 `mfa_locked` `{ until }` (TOTP only) · 429 `too_many_attempts` (recovery, 10 per 15 min per user) |
| `POST /api/v1/auth/mfa/enrolment` | `ok`, `enrol`; **re-auth** | → 201 `MfaEnrolmentStart { secret (base32), otpauthUri }`; replaces any unconfirmed factor | 409 `mfa_already_enrolled` · 403 `reauth_required` |
| `POST /api/v1/auth/mfa/enrolment/confirm` | `ok`, `enrol` | `{ code }` → `RecoveryCodes { codes: string[10] }`; sets `mfa_at`, `reauth_at` | 400 `code_invalid` · 404 `no_enrolment` |
| `POST /api/v1/auth/mfa/recovery-codes` | `ok`; **re-auth** | → `RecoveryCodes` (old codes deleted) | 409 `mfa_not_enrolled` |
| `DELETE /api/v1/auth/mfa` | `ok`; **re-auth** | → 204 (factor and codes deleted) | 409 `mfa_required_by_workspace` `{ workspaces: string[] }` · 409 `mfa_not_enrolled` |
| `GET /api/v1/auth/reauth` | `ok`, `enrol` | → `ReauthStatus { fresh, until: iso\|null, methods: ('totp'\|'recovery'\|'email')[] }` | — |
| `POST /api/v1/auth/reauth` | `ok`, `enrol` | `MfaCode` → 204; sets `reauth_at` | as the challenge; 409 `mfa_not_enrolled` |
| `POST /api/v1/auth/reauth/email` | `ok`, `enrol`; not enrolled only | → 202 `MagicLinkResponse { delayed }` | 409 `use_authenticator` (enrolled) · 429 `rate_limited` (the sign-in link limits, per email) |
| `GET /api/v1/team/mfa` | tenant session, any role | → `TeamMfa { required, members, enrolled }` (active members of the session tenant) | — |
| `PUT /api/v1/team/mfa` | Owner (`security.manage`); **re-auth** | `{ required: boolean }` → `TeamMfa` | 403 `forbidden` · 409 `mfa_not_enrolled` (turning on while the Owner isn't enrolled) |

**Changed:**
- `MagicLinkVerifyResponse.next` gains `'mfa'` (go to the challenge), `'mfa-enrol'` (forced enrolment) and `'reauthed'` (a re-auth link was confirmed; the page shows "go back to your tab"). New `LinkError` code `link_other_session` (400): a re-auth link opened where its session's cookie isn't.
- `GET /api/v1/auth/google/callback` redirects to `/two-step` or `/two-step/setup` for those two `next` values.
- **New error shapes on every route that needs a full session:** 401 `mfa_required` (state `challenge`), 403 `mfa_enrolment_required` (state `enrol`); and on routes that call `requireReauth`: 403 `reauth_required` `{ methods }`. `ReauthRequired` is exported as a contract so later features' tests use one shape.

## 4. Schema changes (migrations `0036_mfa.sql` generated by drizzle-kit, `0037_mfa_rls.sql` hand-written)

| Table | Columns | Keys and indexes |
|---|---|---|
| `mfa_factors` (new) | `id uuid` default random; `user_id uuid` → users not null; `kind text` (`totp`) default `totp`; `secret_ciphertext bytea` not null; `key_ref text` not null; `created_at`; `confirmed_at` null; `last_used_step bigint` null (replay guard); `failed_attempts int` default 0; `locked_until timestamptz` null | PK `id`; unique `(user_id) where confirmed_at is not null`; unique `(user_id) where confirmed_at is null`; check `kind in ('totp')` |
| `recovery_codes` (new) | `id uuid`; `user_id uuid` → users not null; `code_hash bytea` not null; `created_at`; `used_at` null | PK `id`; unique `code_hash`; index `(user_id) where used_at is null` |
| `sessions` | + `mfa_at timestamptz` null (second factor passed on this session; ADR-020) | — |
| `magic_links` | + `purpose text` (`sign_in`, `reauth`) default `sign_in`; + `session_id uuid` null → sessions | check: `purpose = 'reauth'` ⇔ `session_id is not null` |
| `tenants` | + `mfa_required boolean` not null default false | — |

- `mfa_factors` and `recovery_codes` belong to a person, not a tenant (FEAT-005 D3): no `tenant_id`, RLS enabled with policies for `app_identity` only, so every other role reads nothing even with a stray grant. Grants to `app_identity`: `mfa_factors` SELECT, INSERT, DELETE, UPDATE (`confirmed_at`, `last_used_step`, `failed_attempts`, `locked_until`); `recovery_codes` SELECT, INSERT, DELETE, UPDATE (`used_at`).
- `sessions`: `app_identity` gains UPDATE on `mfa_at` and `reauth_at`.
- `tenants`: `app_identity` gets a policy `identity_read FOR SELECT USING (true)` and a column SELECT on `mfa_required` beside its existing `(id, name, status)`, because `authenticate` reads the active tenant's requirement before any tenant context exists (as for `memberships`, 0007). `app_dashboard` gains a column UPDATE on `mfa_required` (like `ai_paused`, FEAT-057 D5), under `tenant_isolation`.
- **`tenant_mfa_enrolment()`** returns `(members int, enrolled int)` for `current_setting('app.tenant_id')`: SECURITY DEFINER, owned by a new NOLOGIN role `kaki_mfa_count` with SELECT on `memberships`, `mfa_factors (user_id, confirmed_at)`; EXECUTE to `app_dashboard` only (the pattern of `kb_stale_scan`, 0029). The dashboard zone never reads `mfa_factors` itself.
- **RLS suite** (`packages/db/test/rls.int.test.ts`): `app_dashboard` and `app_visitor` read nothing from `mfa_factors`/`recovery_codes` and can't insert; `app_dashboard` in tenant B can set B's `mfa_required` and A's stays; `tenant_mfa_enrolment()` in tenant B counts only B; `app_identity` can't update `tenants.mfa_required`. The new tables aren't in `TENANT_SCOPED_TABLES` (no `tenant_id`), like `users`.
- **Rollback:** forward-only as before; new columns have defaults, so existing rows and sessions are unaffected (`mfa_at` null on a user with no factor means nothing).

## 5. Component design

### 5.1 Sealing moves to `@kaki/platform` (D3)

`packages/channels/src/secrets.ts`'s `SecretSealer`, `localSealer`, `SealError` move to `packages/platform/src/secrets.ts` (export `@kaki/platform/secrets`); channels re-exports them, so FEAT-034's code and tests don't change. The api builds `localSealer(MFA_SECRET_KEY)` (32 bytes, base64url) at start-up; the KMS envelope sealer replaces it for both users at FEAT-037/MD. AAD for a factor is `mfa:{factorId}`.

### 5.2 `@kaki/identity`

| File | Responsibility |
|---|---|
| `totp.ts` (new) | RFC 6238: SHA-1, 6 digits, 30 s step; `newTotpSecret()` (20 random bytes), `base32Encode/Decode` (RFC 4648, no padding), `totpAt(secret, step)`, `verifyTotp(secret, code, now, lastUsedStep)` → `{ ok, step }` accepting steps −1..+1 and refusing `step <= lastUsedStep` (replay); constant-time compare; `otpauthUri(secret, email, issuer)` with issuer `APP_NAME` from config (D4 placeholder name) |
| `recovery.ts` (new) | `newRecoveryCodes()` → 10 codes of 10 characters from a 32-letter alphabet without `0 O 1 I`, shown as `xxxxx-xxxxx`; stored as SHA-256 of the normalised code (lower-case, no hyphen or spaces); 50 bits each, so no slow hash (D5) |
| `mfa.ts` (new) | `startEnrolment(idDb, sealer, auth)`, `confirmEnrolment(idDb, sealer, auth, code)` → codes, `passChallenge(idDb, sealer, auth, input)`, `reauthenticate(idDb, sealer, auth, input)`, `regenerateRecoveryCodes`, `removeFactor`, `mfaStatus`, `requestReauthLink(idDb, links, auth)`, all audited per §5.5 |
| `reauth.ts` (new) | `REAUTH_WINDOW_MINUTES = 10`; `requireReauth(auth)` throws `ReauthRequiredError(methods)` unless `auth.reauthFresh` — the `identity.requireReauth` block named in the plan |
| `sessions.ts` | `authenticate` also reads (same query, two left joins and an `exists`): the user's confirmed factor, the active tenant's `mfa_required`, `s.mfa_at`, and `s.reauth_at > now() - interval '10 minutes'`. `AuthContext` gains `mfa: 'ok' \| 'challenge' \| 'enrol'`, `mfaEnrolled`, `reauthFresh` |
| `users.ts` | `startSession`'s `next` adds `mfa` (confirmed factor) before `mfa-enrol` (no factor, earliest active tenant requires) before `app`/`create-workspace` |
| `magic-link.ts` | `consumeMagicLink(idDb, token, currentSessionId)`: a `reauth` link is claimed only if `session_id = currentSessionId` and that session is live (else `link_other_session`, the link stays unclaimed), then sets that session's `reauth_at`; `sign_in` links as before. The sweep and `magicLinkEmail` pick subject and text by purpose ("Confirm it's you" vs "Sign in") |
| `capabilities.ts` | new `security.manage`, Owner only (ux-foundations: "require MFA" is Owner-only) |

**State rule** (computed in `authenticate`, re-read every request, so it applies to existing sessions at once):
1. a confirmed factor and `mfa_at is null` → `challenge`;
2. else the active tenant has `mfa_required` and the user has no confirmed factor → `enrol`;
3. else `ok`.

**Challenge and lockout** (UC-02 3c): one transaction locks the factor row (`for update`). If `locked_until > now()` → `mfa_locked`. A wrong TOTP increments `failed_attempts`; the 5th sets `locked_until = now() + 15 min`, resets the count and audits `mfa.locked`. A right one resets the count, stores `last_used_step`, and sets the session's `mfa_at` and `reauth_at` (challenge) or just `reauth_at` (re-auth). The counter belongs to the factor, not the session, so a new sign-in link doesn't reset it. A recovery code is claimed with `update recovery_codes set used_at = now() where user_id = $1 and code_hash = $2 and used_at is null returning id`, works while locked, clears the lock, and audits `mfa.recovery_code_used`; recovery failures go to the rate limiter (`rl:mfa:rc:{userId}`, 10 per 15 min).

**Enrolment:** `startEnrolment` deletes any unconfirmed factor, inserts a sealed new secret and returns it with the URI. `confirmEnrolment` verifies against the unconfirmed factor (no lockout before it is confirmed; the rate limiter `rl:mfa:en:{userId}` allows 10 tries per 15 min), then in one transaction sets `confirmed_at`, `last_used_step`, deletes old codes, inserts ten new hashes, sets this session's `mfa_at` and `reauth_at`, and audits `mfa.enrolled`. Other live sessions of the user drop to `challenge` on their next request (D7).

**Removal:** refused with `mfa_required_by_workspace` while any active membership's tenant requires MFA; otherwise deletes the factor and codes and audits `mfa.removed`.

### 5.3 API (`apps/api/src/auth.ts` and a new `apps/api/src/mfa.ts`)

- `authFrom(req, opts?: { allow?: ('challenge' | 'enrol')[] })`: after `authenticate`, a pending state not in `allow` throws `MfaChallengeError` (401 `mfa_required`) or `MfaEnrolmentError` (403 `mfa_enrolment_required`). `sessionFrom` uses no `allow`, so every tenant route refuses pending sessions with no change to those routes. `TenantSession` gains `reauthFresh` and `mfaEnrolled` so a route calls `requireReauth(s)`.
- `/api/v1/me` keeps refusing pending sessions (the dashboard routes on the error); sign-out and sign-out-everywhere work for pending sessions (they read the cookie directly, unchanged).
- `registerMfaRoutes(app, deps, { authFrom, sessionFrom })` holds §3's `mfa`, `reauth` and `team/mfa` routes; wired beside `registerAuth` in `app.ts`. `PUT /team/mfa` runs in the dashboard zone: `can(role, 'security.manage')`, `requireReauth`, the Owner's own `mfaEnrolled` when turning on, a conditional `update tenants set mfa_required` and an audit entry in the same transaction (no-op and no audit when unchanged).
- `setErrorHandler` maps `MfaChallengeError`, `MfaEnrolmentError`, `ReauthRequiredError` (with `methods`), `MfaCodeError` (`attemptsLeft`), `MfaLockedError` (`until`), `MfaStateError` (the 409 codes) and `link_other_session`.
- Config: `MFA_SECRET_KEY` (secret, 32 bytes base64url) and `APP_NAME` (default `KakiAgent`) in `apps/api` config and `.env.example`; `scripts/gen-local-env.mjs` writes a random key; `infra/terraform/envs/prod` adds the `mfa-secret-key` secret to the api task (never applied until MD).
- **Realtime** `/ws`: a pending state closes with 4401 (challenge) or 4403 (enrol), like the existing failures.

### 5.4 Dashboard (detail in ui-design.md)

- **Routes outside the shell:** `/two-step` (SCR-APP-005: challenge, recovery, locked) and `/two-step/setup` (SCR-APP-005: enrol, forced or voluntary, then recovery codes). `/auth/verify` handles `next: 'mfa' | 'mfa-enrol' | 'reauthed'` and `link_other_session`.
- **Routing:** `routeAuthError` (main.tsx) also sends 401 `mfa_required` → `/two-step` and 403 `mfa_enrolment_required` → `/two-step/setup`; `UnauthorizedError.code` gains `mfa_required`; both count as auth errors (no retry, no toast).
- **Re-auth guard** (`lib/reauth.ts`, `shell/reauth-dialog.tsx`): a `ReauthProvider` in `AppShell` (and around `/two-step/setup`) exposes `useReauthGuard()` → `guard(fn)`. `guard` runs `fn`; on `ApiError` `reauth_required` it opens the dialog with the returned `methods`, waits for success, then runs `fn` once more; cancel rejects with `ReauthCancelled` (callers show nothing). Sensitive mutations wrap their `mutationFn` in `guard`. This is the pattern later sensitive actions use (code-map).
- **In the shell:** `/account` (SCR-APP-055 p: the two-step card; FEAT-008 adds the rest of My account), linked as "My account" in the account menu; `/settings/team` (SCR-APP-045 p: the Owner's "Require two-step verification" card; FEAT-007 adds members and invitations), linked from the Settings "Team" row.
- `lib/mfa.ts`: queries and mutations (`useMfaStatus`, `useTeamMfa`, …), `formatRecoveryCode`, `normaliseCode` (strip spaces and hyphens), `recoveryCodesFile(codes, email)` (the downloadable text), with `lib/mfa.test.ts`.
- QR: `uqr` 0.1.3 (`renderSVG`, MIT, ~6 KB gz, dashboard only, loaded on `/two-step/setup`), D6.

### 5.5 Audit (ADR-014: IDs only)

User-level events are appended to the chain of every tenant where the user is an active member (the tenant's security record), actor `user:{id}`, subject `user:{id}`, payload `{}`: `mfa.enrolled`, `mfa.removed`, `mfa.recovery_codes_regenerated`, `mfa.recovery_code_used`, `mfa.locked`. The policy change appends `tenant.mfa_policy_changed` `{ required }` to the session tenant. Re-auth successes and wrong codes aren't audited (noise; the lock is).

### 5.6 E2E (`e2e/tests/two-step.e2e.ts`)

A fresh user per run (new email → `/welcome` → new workspace), so the seeded owners never get a factor and other specs are unaffected. A `totp(secret)` helper in `e2e/tests/support.ts` (node:crypto, same algorithm). Flow: enrol from My account (re-auth by email link from Mailpit, the original action continuing on its own) → save codes → sign out → sign in → challenge → code → inbox; sign out → five wrong codes → locked → recovery code → in; Owner turns on "Require" (re-auth with TOTP) and the count shows; turning off two-step on My account is refused while required. axe light and dark on each SCR-APP-005 state and the dialog; 375 px for the challenge and setup.

## 6. Acceptance criteria

- **AC-1** (AUTH-03 "enrol a TOTP authenticator", "recovery codes are issued at enrolment"; UC-02 3a) Starting enrolment returns a base32 secret and `otpauth://totp/…` URI; a valid code confirms the factor and returns ten distinct recovery codes exactly once; a wrong code confirms nothing; the database holds only the sealed secret (no plaintext base32 in any column) and SHA-256 hashes of the codes. Starting again while enrolled is 409.
- **AC-2** (UC-02 step 3) After a magic link or Google sign-in, an enrolled user's session gets `next: 'mfa'`; until a valid code, every tenant route, `/me` and `/ws` refuse it (401 `mfa_required` / 4401) while `/auth/mfa*` and sign-out work; a valid TOTP (current step or ±1) opens the session; the same code is refused the second time (replay).
- **AC-3** (UC-02 3c) Five wrong TOTP codes lock the code challenge and TOTP re-auth for 15 minutes (429 `mfa_locked` with `until`, even for a right code, across new sign-ins); a recovery code still passes while locked, only once, and its use is audited; ten wrong recovery codes in 15 minutes are 429.
- **AC-4** (AUTH-03 "the Owner can require MFA", "enforced MFA blocks dashboard access until the user has enrolled") `PUT /team/mfa` works for the Owner only (Admin and Agent 403), needs re-auth and the Owner's own factor to turn on, and is audited once per change; from the next request, a member without a factor (existing sessions included) gets 403 `mfa_enrolment_required` on every tenant route and `/ws`, can enrol, and then has full access; `GET /team/mfa` counts only the session tenant's active members.
- **AC-5** (AUTH-03 "sensitive actions are refused without a fresh re-authentication") `requireReauth` refuses a session whose `reauth_at` is older than 10 minutes with 403 `reauth_required` and the methods the user has (`totp`, `recovery` when enrolled; `email` otherwise); TOTP or recovery re-auth, or opening the emailed link in the same browser, makes the next attempt succeed; a re-auth link opened without that session's cookie is refused (`link_other_session`) and stays usable; re-auth links follow the sign-in link limits and expiry. FEAT-006's own sensitive routes (start enrolment, new recovery codes, turn off, change the policy) use it.
- **AC-6** (AUTH-03, recovery codes) New recovery codes invalidate all old ones; turning two-step off is refused while any of the user's workspaces requires it and otherwise deletes the factor and codes; after enrolment the user's other sessions must pass the challenge.
- **AC-7** (ADR-014) Each event in §5.5 appends one entry per relevant tenant with IDs only (no email, secret or code), and `verifyChain` holds.
- **AC-8** (ADR-005, FEAT-005 D3) The RLS cases in §4 pass: only `app_identity` reads or writes `mfa_factors` and `recovery_codes`; `mfa_required` is set only by `app_dashboard` in its own tenant; tenant B's sessions and policy are unaffected by tenant A's.
- **AC-9** (SCR-APP-005; ux-foundations F1/UC-02) The challenge, recovery, locked, forced-enrolment and voluntary-enrolment states render per ui-design with errors that name the fix; the recovery codes can be copied and downloaded, and Continue needs "I've saved these codes".
- **AC-10** (design.md `reauth-dialog`, §4.10) A sensitive action with a stale session opens "Confirm it's you" with the user's methods; on success the original action continues without a second click; Cancel leaves everything unchanged.
- **AC-11** (SCR-APP-055 p, SCR-APP-045 p) My account shows the two-step state with set up, new recovery codes and turn off (with the reason when refused); Team shows the Owner's toggle with the member counts, read-only for Admin and Agent.
- **AC-12** (NFR-08/INB-06) No serious axe violations on SCR-APP-005's states, the dialog, My account and Team in light and dark; the challenge and setup work at 375 px; codes use `inputmode="numeric"` and `autocomplete="one-time-code"`.

## 7. Decisions

- **D1 — TOTP written on `node:crypto`, no library.** RFC 6238 with SHA-1 and 6 digits is about 40 lines and is the part every authenticator app agrees on; FEAT-005 D1 already keeps auth code ours and in the pen-test scope. Tested against the RFC 6238 Appendix B vectors. *Rejected:* `otplib` (its v13 rewrite is recent and pulls a plugin set for one function).
- **D2 — Two-step state is computed per request, not stored on the session.** The rule in §5.2 reads the factor and the tenant flag in the existing `authenticate` query, so "Owner requires" and "user enrolled elsewhere" apply to live sessions at once (AUTH-03 "blocks dashboard access"), with no session rewrite on policy change.
- **D3 — Sealing moves to `@kaki/platform`.** Identity needs the same AES-GCM sealer as channels and must not depend on channels; one implementation, one future KMS swap. Channels re-exports, so FEAT-034 is untouched.
- **D4 — Re-auth methods: TOTP or recovery code when enrolled, an emailed link otherwise; no Google re-prompt yet.** An enrolled user proves the second factor again (an email link alone would let a mailbox stand in for the phone). Google users have a verified email, so the link covers them; a Google `prompt=login`/`max_age` redirect would leave the page mid-action and can't be tested live until real Google credentials exist (FEAT-005 §8 item 5). ADR-020 lists the three as alternatives ("satisfied by … or …"), so this is within it; recorded in §8.
- **D5 — Recovery codes hashed with SHA-256, not a slow hash.** 50 random bits per code plus the 10-per-15-minute limit make offline and online guessing impractical; a slow hash buys nothing at that entropy and costs a CPU spike per attempt.
- **D6 — QR rendered in the browser with `uqr`.** The secret is already in the enrolment response (the manual key needs it), so rendering server-side adds no protection; `uqr` is tiny, dependency-free and outputs SVG that scales cleanly. Loaded only on the setup route, so the main bundle doesn't grow.
- **D7 — Enrolling sends the user's other sessions through the challenge.** Those sessions never passed a second factor; enrolment usually follows a scare.
- **D8 — Owner-only and self-enrolled first.** "Require" is `security.manage` (Owner only, ux-foundations IA), and the Owner can't require what they haven't set up, so they can't lock the workspace into enrolment they can't finish themselves.
- **D9 — Where each AUTH-03 action gets `requireReauth`.** None of AUTH-03's listed actions exists yet; each is wired by its feature (boundary rules FEAT-054, delete/transfer FEAT-010, support access FEAT-063, exports FEAT-050/FEAT-060, PDPA deletion FEAT-061) with the shared `ReauthRequired` contract and the dashboard `guard`. AUTH-03's RTM Test ref stays `(partial)` until the last of them and FEAT-070 (operators) land.
- **D10 — Partial screens before their features.** SCR-APP-045 (Team, FEAT-007) and SCR-APP-055 (My account, FEAT-008) are where ux-foundations puts "require MFA" and the user's two-step setting. This feature builds only those cards on their real routes, with the rest of each screen a placeholder naming its feature, rather than inventing a Security screen.

## 8. Escalations and open items

1. **ADR-020 re-auth methods:** Google re-prompt deferred (D4); add it with live Google credentials (MD), or note on ADR-020 at its next revision that the emailed link stands in.
2. **Lost authenticator and all recovery codes:** no self-service path (by design). Recovery is a support action for the operator console (FEAT-070 or later: reset a user's factor, audited); until then, a platform admin deletes the factor by hand. Added to pending-actions.
3. **ADR-005 trust zones:** `kaki_mfa_count` (NOLOGIN, owner of `tenant_mfa_enrolment()`) joins the list beside `kaki_stale_scan`; recorded, not edited.
4. **KMS:** `MFA_SECRET_KEY` is a local AES key until the KMS envelope sealer (FEAT-037/MD) replaces it for channels and MFA together.
5. **Not here:** operator MFA (FEAT-070), the rest of Team (FEAT-007) and My account (FEAT-008), the re-auth wiring of each sensitive action (D9).
6. E2E, renders and axe run in the verify stage's GitHub CI (no local stack in cloud sessions).

## 9. Self-check

- Every AUTH-03 criterion maps to an AC: refused without fresh re-auth (AC-5), enforced MFA blocks access (AC-4), recovery codes at enrolment (AC-1, AC-6); UC-02 3, 3a, 3c are AC-2, AC-1/AC-4, AC-3. Operators are FEAT-070 (partial, D9).
- New tables have no `tenant_id` and fail closed (RLS on, `app_identity` policies only); the new tenant column has a column grant and RLS cases (AC-8); the dashboard zone reads enrolment only through a SECURITY DEFINER count.
- Tenant ID only from the session; secrets sealed, codes hashed, audit IDs only (ADR-014).
- No agent pipeline change; the `sessionFrom` change protects every existing route without touching them.
- Only `var(--…)` tokens; components from design.md (`reauth-dialog`, `dialog`, `field`, `text-input`, `toggle`, `alert`, `card`, `button`); no new token.
