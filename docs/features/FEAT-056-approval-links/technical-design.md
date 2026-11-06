# Technical design: FEAT-056 — Signed mobile approval links

> Implements: APR-03 · Realizes: UC-22 steps 4 and 5 (the link, sign-in, then the FEAT-055 decision) with 5b · Screens: SCR-APP-018 (p: the link landing at `/approve` and its states; see [ui-design.md](ui-design.md)) · Module: `approvals` (links), with identity (sign-in continuation) and platform (alert links), architecture §5.2 and §6.2, ADR-005, ADR-013 §5, ADR-014
> Status: designed · 2026-11-06

## 1. Intent

An approver gets the "A reply is waiting for your approval" alert on their phone and taps the button. The link is signed for that approver and that approval, works once, and lasts 24 hours. It opens a small landing page that asks them to sign in if they aren't, then puts them on the approval (SCR-APP-018), where FEAT-055's approve, edit and reject work as they do on a desktop. An expired, reused, tampered or forwarded link opens nothing: the landing says why and offers the Approvals queue (UC-22 5b). The link itself grants nothing: it only says where to go; the decision still needs a signed-in session with approval rights.

## 2. Codebase context

- **Alerts** (FEAT-052): `sendDueNotifications(idDb, mailer, { appUrl, now })` in `@kaki/platform/notifications` builds each email's link with `linkFor(kind, subject, appUrl)` (`links.ts`); `approval_pending` and `approval_undeliverable` go to `/approvals/{id}`. One alert row per recipient (`n.user_id`); digests list several items, each with its own link. The scheduler wires it (`apps/scheduler-worker/src/main.ts`, `linkConfig` with `MAGIC_LINK_SECRET` and `PUBLIC_APP_URL`). Platform can't import approvals.
- **Approvals** (FEAT-055): `approvals` rows (pending, decided, expired, undeliverable); the API's `/api/v1/approvals/:id` detail and decision routes, `approvals.decide` capability; SCR-APP-018 at `/approvals/:id` already shows pending, decided by someone else, expired and not delivered.
- **Sign-in** (FEAT-005/006/007): `POST /api/v1/auth/magic-link { email, invitation? }` stores the invitation on `magic_links.invitation_id` and `POST …/verify` returns `{ next: 'app' | 'create-workspace' | 'mfa' | 'mfa-enrol' | 'reauthed' }`; `pages/verify.tsx` maps `next` to a path. Google: `GET /api/v1/auth/google/start?next=invite` sets an allow-listed `OAUTH_NEXT_COOKIE`; the callback redirects. The two-step pages honour `?next=` (`safeNext`). `authenticate(idDb, cookie)` gives `ok` with state `ok | challenge | enrol`. `switchWorkspace(idDb, { sessionId, userId }, tenantId)` (FEAT-007) moves the session's active tenant for an active member.
- **Dashboard auth routing** (`main.tsx`): a 401 from any query or mutation goes to `/sign-in` without a return path, so the landing must never get a 401 for "not signed in" (§3).
- **Token in the fragment**: invitations (`/invite#token=`) and sign-in (`/auth/verify#token=`) keep tokens out of server logs and Referers; `invite.tsx` holds its token in `sessionStorage` across the Google round trip.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Approval links (APR-03; FEAT-056 §3)`)

```ts
export const ApprovalLinkBody = z.object({ token: z.string().min(1).max(1000) });
/** Not signed in, or two-step owed, is a state, never a 401 (the dashboard routes 401s itself). */
export const ApprovalLinkOpened = z.discriminatedUnion('state', [
  z.object({ state: z.literal('opened'), approvalId: z.uuid(), switched: z.boolean() }),
  z.object({ state: z.literal('sign_in') }),
  z.object({ state: z.literal('two_step') }),
  z.object({ state: z.literal('two_step_setup') }),
]);
export const APPROVAL_LINK_ERRORS = {
  link_invalid: 400,   // malformed, bad signature, unknown version
  link_expired: 410,   // exp passed (checked before sign-in)
  link_used: 409,      // nonce already consumed (also the loser of a race)
  wrong_account: 403,  // signed in as someone other than the link's recipient
  not_member: 403,     // the recipient is no longer an active member of that business
} as const;
```

- `POST /api/v1/approval-links/open` body `ApprovalLinkBody` → 200 `ApprovalLinkOpened`, or an error above as `{ error, message }`. Public route (reads the session cookie itself, like `…/magic-link/verify`); no tenant from the body, only from the verified token.
- `MagicLinkRequest` gains `approvalLink: z.string().max(1000).optional()` (the landing's token; the API checks its signature, else 400 `link_invalid`; invitation and approvalLink are never both set, else 400). `MagicLinkVerifyResponse` gains `approvalLink: z.string().optional()`, returned only for a sign-in link that carried one.
- `GET /api/v1/auth/google/start?next=approve`: `approve` joins `invite` in the allow-list; the callback redirects to `/approve` (or `/two-step?next=%2Fapprove`, `/two-step/setup?next=%2Fapprove` when owed).
- Token format (not a contract shape; `@kaki/approvals` owns it): `base64url(JSON {v:1, t: tenantId, a: approvalId, u: userId, e: expUnixSeconds, n: nonce}) + "." + base64url(HMAC-SHA256(key, payloadPart))`, nonce 16 random bytes base64url; ~230 characters. Link: `${PUBLIC_APP_URL}/approve#token=<token>`.

## 4. Schema changes (migration `0050_approval_links.sql`)

- **`used_link_nonces`** (ADR-013 §5's name; the plan's Data column calls it `approval_links`): `tenant_id uuid not null references tenants`, `nonce text not null`, `approval_id uuid not null` (composite FK `(tenant_id, approval_id)` → `approvals` as other approval children do, `on delete cascade`), `user_id uuid not null` (no FK into the identity zone, as `approvals.decided_by`), `expires_at timestamptz not null`, `used_at timestamptz not null default now()`, primary key `(tenant_id, nonce)`, check `length(nonce) between 16 and 64`. Forced RLS with the standard tenant policy; `app_dashboard`: select, insert, delete; no other zone. Name in `TENANT_SCOPED_TABLES`; cases in `rls.int.test.ts` (tenant B can't see or insert A's rows; a second insert of one nonce is refused).
- **`magic_links.approval_link text`** (nullable) with check `purpose = 'sign_in' or approval_link is null` and `invitation_id is null or approval_link is null`. Identity-zone grants as the table's other columns.
- No change to `approvals` or `notifications`.

## 5. Component design

### 5.1 `@kaki/approvals` `links.ts` (new, exported)

- `approvalLinkKey(magicLinkSecret: string): Buffer` = HMAC-SHA256(secret, `'kaki/approval-link/v1'`) (D2: a derived key, no new secret).
- `signApprovalLink(key, { tenantId, approvalId, userId }, now: Date): string`, exp = now + 24 h.
- `readApprovalLink(key, token, now)` → `{ ok: true, claims } | { ok: false, error: 'link_invalid' | 'link_expired' }`. Constant-time compare (`timingSafeEqual`), strict JSON shape (UUIDs, integer `e`, `v === 1`), anything else `link_invalid`; signature is checked before expiry so a forged exp is `link_invalid`.
- `approvalLinkUrl(key, appUrl, subject, now)` → `${base}/approve#token=…`.
- `openApprovalLink(deps: { dashboardDb, idDb }, who: { sessionId, userId, activeTenantId } | null | 'two_step' | 'two_step_setup', token, now)`:
  1. `readApprovalLink` → invalid/expired error.
  2. `withTenant(dashboardDb, claims.t, …)`: delete this tenant's rows with `expires_at < now` (D5); if the nonce row exists → `link_used`.
  3. No session → `{ state: 'sign_in' }`; two-step owed → the matching state (nothing consumed).
  4. `who.userId !== claims.u` → `wrong_account` (nothing consumed).
  5. The user's membership of `claims.t` is active (identity zone, as `switchWorkspace` checks) → else `not_member`.
  6. In one dashboard transaction: insert the nonce (`on conflict do nothing`; no row → `link_used`, the race loser, AC-5) and `audit.append` `approval.link_opened` `{ approvalId: auditId(a) }` with the user as actor (no token, no nonce, no PII; ADR-014).
  7. `who.activeTenantId !== claims.t` → `switchWorkspace` and `switched: true`.
  8. `{ state: 'opened', approvalId, switched }`. The approval's own state (decided, expired, undeliverable) is not checked here: SCR-APP-018 shows it (D4).
- Errors are a `ApprovalLinkError` class with the `APPROVAL_LINK_ERRORS` code.

### 5.2 Alerts (platform, scheduler)

- `SendOptions` gains `linkOf?: (item: { tenantId, userId, kind, subject }) => string | null`; `itemOf` uses it first and falls back to `linkFor` when it returns null. Platform stays free of approvals.
- The scheduler passes `linkOf` that returns `approvalLinkUrl(key, appUrl, …, now)` for `approval_pending` only; `approval_undeliverable` keeps `/approvals/{id}` (nothing to decide, D3). Each send attempt and each digest item mints a fresh token for that recipient; nothing is stored at mint time (ADR-013 §5: stateless token, nonce stored on use).
- `templates.ts` `approval_pending`: the button text becomes "Review and approve", and a line under it "This link works once, for 24 hours. You'll be asked to sign in." (digest items: the same line once, under the list, when any item is an approval).
- FEAT-037's Telegram alerts and FEAT-048's push take the same `linkOf`.

### 5.3 API (`apps/api/src/approval-links.ts`, `registerApprovalLinkRoutes(app, deps)`, wired in `app.ts`)

- `POST /api/v1/approval-links/open`: reads the cookie with `authenticate(identityDb, cookie)`: `ok` + state `ok` → `who`; `challenge` → `'two_step'`; `enrol` → `'two_step_setup'`; none → `null`. Calls `openApprovalLink`; maps `ApprovalLinkError` to its status. Rate-limit per IP as the magic-link route does (`rl:al:ip:`, 30 per 10 minutes) to keep it cheap to hammer.
- `auth.ts`: the magic-link route checks `approvalLink` with `readApprovalLink` (signature only, expiry ignored; the landing already refused an expired one) and passes it to `requestMagicLink(…, { approvalLink })`; the verify route returns it. Google start/callback per §3.
- identity `magic-link.ts`: `requestMagicLink` takes the optional `approvalLink` and stores it; `consumeMagicLink` returns it for `sign_in` links. Identity stays ignorant of its format.
- Config: no new variable (D2); the API derives the key from `MAGIC_LINK_SECRET` at start-up.

### 5.4 Dashboard

- Route `/approve` outside the shell (beside `/invite`), `pages/approval-link.tsx`, helpers in `lib/approval-link.ts`: `LINK_KEY = 'kaki.approval-link'` in `sessionStorage` (try/catch, memory fallback), `takeLinkToken()` (fragment first, then storage; strips the hash with `history.replaceState`), `linkState(result | error)` → the ui-design state, `afterSignIn(next)` → `/approve` or `/two-step?next=%2Fapprove` / `/two-step/setup?next=%2Fapprove`.
- The open call is a mutation posted once (a `useRef` guard, as `verify.tsx`, for StrictMode). `opened`: clear the token; when `switched`, `queryClient.clear()`; `navigate('/approvals/' + id, { replace: true })`. `two_step*`: navigate with `next=/approve` (token stays in storage). `sign_in`: show the sign-in state, whose email form calls `api.requestMagicLink(email, undefined, token)` and whose Google button goes to `/api/v1/auth/google/start?next=approve`. Terminal errors clear the token.
- `verify.tsx`: when the response has `approvalLink`, store it under `LINK_KEY` and go to `afterSignIn(next)` instead of `NEXT_PATH[next]` (the magic link may open in another browser than the landing, so the token travels with the link, D1).
- `lib/api.ts`: `openApprovalLink(token)`, `requestMagicLink(email, invitation?, approvalLink?)`.

## 6. Acceptance criteria

- **AC-1** (APR-03 "through a secure link in the alert … signed"; UC-22 4) An `approval_pending` alert email's button opens `/approve#token=…` whose token verifies for that recipient, that approval and that tenant, with exp 24 h after the send; two recipients get different tokens; a digest's approval items carry their own; `approval_undeliverable` and other kinds keep their plain links.
- **AC-2** (APR-03 "signed") A token with any changed character, another key, another version or a malformed payload is 400 `link_invalid`, and a forged expiry is invalid, not expired.
- **AC-3** (APR-03 "24-hour expiry"; "Expired … links are rejected"; UC-22 5b) After exp the route answers 410 `link_expired`, signed in or not, and consumes nothing.
- **AC-4** (APR-03 "needs login"; UC-22 5) With no session the route answers `sign_in` and consumes nothing; signing in from the landing by email link (in any browser) or Google lands back on the approval; a session owing two-step answers `two_step`/`two_step_setup` and continues to the approval after the code.
- **AC-5** (APR-03 "single-use"; "reused links are rejected"; UC-22 5b) The first open by the recipient answers `opened` and records the nonce and one `approval.link_opened` entry; every later open, signed in or not, is 409 `link_used`; of two concurrent opens exactly one is `opened`.
- **AC-6** (UC-22 5; ADR-013 §5 "authenticated session for that user") Signed in as another member: 403 `wrong_account`, nothing consumed, and the recipient can still use it; a recipient no longer an active member: 403 `not_member`.
- **AC-7** (UC-22 5) A recipient whose session is on another workspace is switched to the approval's business (`switched: true`) and sees the approval; approving it from the phone-width page works as FEAT-055 (an E2E from the alert email in Mailpit to "Quote sent to the visitor").
- **AC-8** (ADR-005, ADR-014) `used_link_nonces` is tenant-isolated (RLS cases); its tenant comes only from the verified token; no audit payload carries the token, the nonce or PII; expired nonce rows are deleted on the next open in that tenant.
- **AC-9** (screens) The landing's states (checking, sign in, check your email, link expired, already used, link not valid, wrong account, no longer on the team) render as ui-design.md says, pass axe at phone and desktop width (tall viewport), and work by keyboard.

## 7. Decisions

- **D1 — The token travels with the sign-in link.** A phone often opens an emailed sign-in link in another browser (an in-app view, or the default browser) than the one that opened the approval link, so `sessionStorage` alone would lose it. The landing's magic-link request carries the approval token, `magic_links.approval_link` stores it, and verify hands it back. Google is a same-tab redirect, so it uses `sessionStorage` and the allow-listed `next=approve`, as invitations do.
- **D2 — The signing key is derived from `MAGIC_LINK_SECRET`** (HMAC with a fixed label), which the API and scheduler already hold: key separation without a new secret, `.env` entry or Secrets Manager item. Rotating `MAGIC_LINK_SECRET` invalidates outstanding approval links, which the queue covers.
- **D3 — Only `approval_pending` gets the signed link.** `approval_undeliverable` has nothing to decide; it keeps `/approvals/{id}` behind normal sign-in.
- **D4 — The link opens; the page decides.** Opening consumes the link even if the approval was decided or expired meanwhile; SCR-APP-018 then shows "already approved by …" or "expired" (FEAT-055 states), which tells the approver more than a link error would. The decision route's capability and version checks are unchanged.
- **D5 — Stateless token, nonce stored on use** (ADR-013 §5). Nothing is written when an alert is sent; used nonces are kept until their token's expiry and deleted lazily on the next open in that tenant, so no cross-tenant sweep or new SECURITY DEFINER function is needed.
- **D6 — Invalid, expired and used are checked before sign-in**, so nobody is asked to sign in only to be told the link is dead. They reveal nothing an attacker lacks: an invalid token says nothing, and a valid one was already in their hands.
- **D7 — Wrong account doesn't consume.** A shared phone or a forwarded email shouldn't burn the recipient's link; the landing offers to sign out and sign in as the right person (the recipient's name isn't shown, only "the team member this was sent to").

## 8. Escalations and open items

- No architecture amendment: ADR-013 §5 describes this design; the table keeps ADR-013's name `used_link_nonces` (the plan's Data column says `approval_links`).
- FEAT-037 (Telegram alerts) and FEAT-048 (push) reuse `linkOf`. FEAT-070 (operators) has no approval links.
- SCR-APP-018's manifest entry gains the landing states and closes FEAT-055's gap "link expired, link already used (FEAT-056)".

## 9. Self-check

Traceability: APR-03 → AC-1 (secure link in the alert), AC-2 (signed), AC-5 (single-use), AC-3 (24-hour expiry), AC-4 (needs login); criterion "expired or reused links are rejected" → AC-3, AC-5; UC-22 4 → AC-1, 5 → AC-4, AC-6, AC-7, 5b → AC-3, AC-5; ADR-013 §5 → AC-5, AC-6, D5; ADR-005/014 → AC-8; screens → AC-9. IDs checked: APR-03, UC-22, SCR-APP-018, ADR-005, ADR-013, ADR-014, FEAT-005, FEAT-006, FEAT-007, FEAT-037, FEAT-048, FEAT-052, FEAT-055, FEAT-070 resolve. Invariants: tenant only from a verified token; forced RLS on the new table; no PII in audit; side effects (the audit append) in the same transaction; no channel branching; no model involvement.
