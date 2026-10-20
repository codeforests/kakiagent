# Acceptance Report: FEAT-005 — Sign up, sign in and sessions

> Verdict: **Accepted** (first verification; live Google check pending environment) · Date: 2026-10-20
> Standard: technical-design.md §6 (AC-1..AC-16) @ `ae1f5ca` · Sources: SRS.md v0.4 (ONB-01, AUTH-01, AUTH-02, AUTH-08; NFR-05, NFR-07, NFR-17), use-cases.md v0.4 (UC-01, UC-02)
> Repo state audited: `ae1f5ca` on `claude/project-thread-hebmom`

## Verdict summary

Every criterion holds and was seen to hold in this run. Magic links are stored as a SHA-256 only, work once, expire after 15 minutes and are rate-limited per address and per IP. Sessions are opaque, hashed, `HttpOnly`/`SameSite=Lax`/`Secure`, and are refused at once after sign-out, sign-out everywhere, idle or absolute expiry, deactivation or a disabled user. A new user names a workspace, accepts the three documents at their current versions, and becomes its Owner. This is recorded with versions, timestamps and a verifying audit chain. Every suite is green: format, lint with boundaries, typecheck, unit, coverage (unit and integration), realtime integration, build, size, bundle grep, eval, Terraform and E2E (15/15 in Chromium).

The tests left part of AC-16 unexercised: five SCR-APP-001/-002/-003 states had no rendering or axe check. I added `e2e/tests/auth-states.e2e.ts` to cover them, and it passes. The findings are minor: design drift in two small details, the client-IP open item, and pending-environment items. The feature is **verified**, and the RTM Test ref is appended for ONB-01, AUTH-01, AUTH-02 (partial) and AUTH-08.

## Standard re-derived (Phase 2)

- **ONB-01** (M): "Sign up with an email magic link or Google." Acceptance: "A new user can create a tenant and land in the wizard within 1 minute." → AC-5, AC-6, AC-15. The wizard is FEAT-009, so "land in the wizard" means `/setup`, the wizard's entry route (design §5.7). That is faithful for this feature's scope.
- **AUTH-01** (M): single use, 15-minute expiry, rate limits per email and per IP. Acceptance: "Expired or reused links are rejected with an option to request a new one. More than 5 link requests per email in 15 minutes are refused. The sign-in response does not reveal whether an email is registered." → AC-1 (same response), AC-2 (reuse and expiry), AC-3 (6th refused), AC-15 and AC-16 ("Send a new link"). Google → AC-5.
- **AUTH-02** (M, partial per plan: the sessions list is FEAT-008): 12-hour idle and 30-day absolute expiry; sign-out and sign-out of all devices. Acceptance: "After sign-out, or after a role change or deactivation (DSH-03), the old session cannot call any API." → AC-9, AC-10, AC-11. AC-11 reads "role change" as the new role applying on the next request, so the old role's grants stop at once. That is the meaningful reading for a session that keeps a valid membership.
- **AUTH-08** (M): acceptance of ToS, AUP and DPA at sign-up, recorded with version and timestamp. Acceptance: "No tenant can go live without a recorded acceptance of the current versions." → AC-6 and AC-7. Here, a tenant cannot be created without that acceptance, which is stronger than the go-live gate. Re-acceptance after material changes is FEAT-073 (plan, AUTH-08 (p) there).
- **UC-01**: the main flow and 2a, 2b, 2c, 3a map to AC-2, AC-3, AC-4 and AC-7. 1a ("already has an account") maps in part to AC-8. **UC-02**: steps 1, 2, 5 and 6, plus 2a and 6a, map to AC-1, AC-2, AC-8, AC-9 and AC-10. MFA (FEAT-006) and the switcher (FEAT-007) are out of scope, as the design states.
- **NFRs.** NFR-05 maps to AC-9 and AC-12. NFR-17 maps to AC-4, under the interpretation D8 records in design §8 item 4: a sign-in link is retried for its own 15-minute life, not 24 hours. That is reasonable, because a link that arrives after it expires is useless, and §8 already raises it for the next SRS amendment. NFR-07: the identity tables live in the same Postgres as every other table. Terraform's region was not changed by this feature, and `terraform validate`/`test` pass.
- **Gaps in the standard:** none. Every FR has at least one criterion, and every consequential UC path is represented.

## Audit table

| AC | Encodes | Test(s) | Audit | Observed |
| :- | :------ | :------ | :---- | :------- |
| AC-1 | AUTH-01; UC-01 1–2, UC-02 1 | `apps/api/test/auth.int.test.ts` "answers the same…"; `packages/identity/test/identity.int.test.ts` "stores only the token hash…" | faithful (identical body for registered and unknown; email sent to each; stored hash = SHA-256 of the emailed token; row JSON contains no token) | green; live: 202 `{"delayed":false}` for both kinds of address, Mailpit received the email, stored `token_hash` equals `sha256(token)` |
| AC-2 | AUTH-01; UC-01 2a, UC-02 2a | api "signs in once…"; identity "signs in once; a reused, expired or made-up link creates no session"; concurrent-verify race test | faithful (error codes and messages; session count unchanged after the failures; no `Set-Cookie`) | green; live: second verify → 400 `link_used` |
| AC-3 | AUTH-01; UC-01 2b | api "refuses the 6th link…" (registered and unregistered), "refuses the 21st link from one IP"; `platform` rate-limit unit and Valkey integration tests; new `auth-states.e2e.ts` rate-limited test on the real Valkey limiter | faithful | green |
| AC-4 | UC-01 2c, NFR-17 | identity "retries a failed send…", "purges links older than 24 hours"; api "says the link may be delayed…" | faithful (derived-token re-send signs in; an expiring or expired link is never sent; purge) | green; live: Mailpit stopped → 202 `{"delayed":true}`, `send_attempts=1`; the link arrived 13 s after Mailpit restarted, `sent_at` set |
| AC-5 | AUTH-01, ONB-01 | `packages/identity/test/google.int.test.ts` (local OIDC provider: S256 PKCE, scope, wrong state, missing or tampered cookie, wrong nonce, unverified or absent `email_verified`, mismatched `sub` both ways); api Google cases (`/welcome` vs `/`, `/sign-in?error=google`, no cookie) | faithful | green; **the live check against Google is pending environment** |
| AC-6 | ONB-01, AUTH-08; UC-01 3–5 | identity "creates the tenant, owner membership, acceptances and audit entries"; api "a new user creates a workspace…" | faithful (three acceptances with version, user and timestamp; `tenant.created` and `terms.accepted`; `verifyChain` ok; `/me` shows `owner`) | green; live: tenant `5401107a-…` got three acceptance rows, an owner membership, and audit seq 1–2; `pnpm audit:verify` → `ok: true, checked: 2` |
| AC-7 | AUTH-08; UC-01 3a | identity "outdated terms create nothing…"; api 409 and 400 cases; new `auth-states.e2e.ts` terms-updated test (real 409 through the UI) | faithful | green; live: 409 `terms_outdated` |
| AC-8 | UC-02 2, 5; UC-01 1a (p) | api "an existing member lands in the app…", 403 `no_workspace` case; identity AC-8 case; realtime 4403 | faithful | green; live 403 `no_workspace` |
| AC-9 | AUTH-02; UC-02 6a; NFR-05 | api cookie attributes (`HttpOnly`, `Lax`, `Secure`, `Path=/`, 30-day max-age), 401 `unauthorized` vs `session_expired` with cookie cleared; identity idle at 12 h + 1 s, 11 h still active, 30-day absolute, hash-only storage | faithful | green; live with `COOKIE_SECURE=false`: `HttpOnly; SameSite=Lax`, no `Secure` (as designed) |
| AC-10 | AUTH-02; UC-02 6 | api sign-out and sign-out-everywhere across `/me`, `/conversations`, `/kb/facts`, with another user's session unaffected; `apps/realtime/test/ws.int.test.ts` 4401 after revocation; E2E "signing out of all devices…" | faithful | green |
| AC-11 | AUTH-02 (role change, deactivation) | api "deactivation and role changes apply on the next request"; identity AC-11 case (including a disabled user unable to start a new session) | faithful | green |
| AC-12 | NFR-05 | api "refuses a state-changing request from a foreign origin" (tenant count unchanged; sign-out refused and the session still works) | faithful | green; live: verify with `Origin: https://evil.example` → 403, and the link was still usable afterwards |
| AC-13 | plan §2 | api `/api/dev/sign-in` → 404; CI bundle grep | faithful | green; live 404; `git grep KAKI_DEV_AUTH` finds only design and notes prose describing its removal; the grep over the fresh `pnpm build` bundles is clean |
| AC-14 | GOV-03, ADR-005 | `packages/db/test/rls.int.test.ts` (schema guard over `TENANT_SCOPED_TABLES`, which includes `memberships` and `terms_acceptances`; identity zone denied conversations, messages, facts, kb_chunks, audit_entries, audit_pii, outbox; dashboard, visitor and outbox zones denied users, sessions, magic_links; insert-only acceptances) | faithful | green (db 55) |
| AC-15 | ONB-01, UC-01, UC-02 | `e2e/tests/auth.e2e.ts` | faithful (the email is read from Mailpit; `/setup` reached in < 60 s, measured; sign-out then `/inbox` → `/sign-in`; bakery owner reaches `/inbox`; used link page → "Send a new link") | green; the sign-up test took 6.8 s |
| AC-16 | ONB-01, AUTH-01, AUTH-08, NFR-09 | `auth.e2e.ts` (default, validation, sent, used, invalid, welcome default and validation, account menu, session-expired, Google error) **plus `auth-states.e2e.ts` (added)** | was incomplete → completed | green |

## Corrected and added tests

- **Added: `e2e/tests/auth-states.e2e.ts`** (AC-16). The existing E2E rendered and axe-checked only some of the states that ui-design.md and the manifest claim as covered. These five had no test:
  - SCR-APP-001 rate-limited: the 5 requests before the 6th go to the real api, and the warning alert and kept field value come from the real limiter.
  - SCR-APP-001 error.
  - SCR-APP-002 sent with `delayed: true`.
  - SCR-APP-002 expired, and the verify error state with "Try again".
  - SCR-APP-003 terms-updated: the page is shown an older version once, the **real** api answers 409, the checkbox is cleared, the versions are refetched, and agreeing again reaches `/setup`.
  - SCR-APP-003 error, with the input kept.

  Where a state can't be produced on demand locally (an expired link, a failing provider, a 5xx), the api's answer is substituted with its design §3 shape and only the screen is under test. The api half of each is already covered by AC-2 and AC-4's integration tests. Each test runs axe with no serious or critical violations. All 5 pass.
- **Corrected:** none.
- **Anti-fake-green review** (test diff `93a2520..ae1f5ca`):
  - Removed: `identity.test.ts`'s dev-session round-trip, which tested deleted code (`dev-session.ts`). This is the declared removal, AC-13.
  - `facts.int.test.ts` and `widget-pii.int.test.ts`: only the setup moved to real sessions, through `test/support.ts`. Each still has the same number of tests (facts 7/7). The cross-tenant `asB` case remains, and no assertion was loosened.
  - The E2E specs swapped the dev-button click for the Mailpit `signIn` helper, with the same assertions on landing in `/inbox`.
  - `rls.int.test.ts` only widened the role lists to include `app_identity`.
  - No skips or `.only`. No coverage configuration changed in the range.
  - The E2E helper clears `rl:ml:*` Valkey keys before each link request. This is declared in T8's note, touches only test state, and the limit itself is asserted in the api tests and in the new rate-limited E2E.
- **Mutation check:** not performed. The environment's permission policy refused a temporary edit of production files (origin guard, idle predicate), even though it would have been reverted. The assertions in question read the criterion directly (status code plus state unchanged; the reason `idle` at 12 h + 1 s next to 11 h still valid), so I rate this low risk. Recorded as M5.

## Independent execution

All runs were made by me at `ae1f5ca` (plus the added spec), with turbo `--force` where applicable. Logs are in `/tmp/claude-0/-home-user-kakiagent/2be3a18f-abb5-57f8-a2cc-a78621812d10/scratchpad/av/`.

| Check | Command | Result |
| :- | :- | :- |
| Format | `pnpm format:check` | pass |
| Lint and boundaries | `pnpm lint` | pass; no dependency violations (232 modules, 546 dependencies) |
| Typecheck | `pnpm turbo run typecheck --force` | 26/26 |
| Unit | `pnpm turbo run test --force --concurrency=2` | 21/21 tasks |
| Coverage (unit + integration, thresholds) | `pnpm test:coverage --concurrency=2 --force` | 15/15 tasks; identity 30 (unit 9, `identity.int` 13, `google.int` 8), api 28, db 55, platform 265, governance 93, agent 142, kb 9, inbox 5, llm-gateway 15, channels 2 |
| Realtime integration | `pnpm --filter @kaki/realtime test:integration` | 4/4 |
| Build / size | `pnpm turbo run build --force`, `pnpm size` | 9/9; loader 1.75 kB gz (≤ 14), panel 9.34 kB gz (≤ 35) |
| Bundle check (CI step) | `grep -rlE "dev/sign-in\|kaki_dev_session" apps/api/dist/main.js apps/realtime/dist/main.js apps/dashboard/dist/assets` | no match |
| Eval | `pnpm eval --fast` | groundedness 8/8, prices 44/44 |
| Terraform | `terraform init -backend=false`, `validate`, `test` (with `TF_CLI_CONFIG_FILE=/tmp/tfrc`) | valid; 2 passed, 0 failed |
| E2E | `E2E_REUSE_SERVERS=true … npx playwright test --project=chromium` | 15/15 (10 existing + 5 added) |

- **Migrations.** Every integration suite starts a fresh Testcontainers Postgres and applies 0000–0007, so 0006–0007 applied cleanly many times over. Migrations are forward-only (design §4).
- **Flakiness.** None seen.
- **Server freshness.** Per this run's brief, E2E reused the `pnpm dev` already running (`tsx watch` and Vite, started 10:45). The working tree matched HEAD and has been unchanged since the last code commit, and watch mode reloads on change. The live api showed the FEAT-005 behaviour: `/api/dev/sign-in` returns 404 and `/auth/options` answers. So the served code is the audited code.
- **Browsers.** Only Chromium ran here; Firefox and WebKit run in CI.

## Direct verification

- **Magic link, live** (api :3000, Mailpit, Postgres):
  - Both kinds of address got 202 `{"delayed":false}`.
  - The email arrived in Mailpit with `/auth/verify#token=…`.
  - `magic_links.token_hash` equals `sha256(token)`, and the row's JSON does not contain the token. `expires_at − created_at` is 15 minutes.
  - Verify with a foreign `Origin` → 403, and the link stayed unconsumed.
  - Verify with the app origin → 200 `{"next":"create-workspace"}` and `Set-Cookie: kaki_session=…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`.
  - Verify again → 400 `link_used`.
- **Workspace, live:**
  - `/me` before: `tenant: null`.
  - `/conversations` → 403 `no_workspace`.
  - Stale DPA version → 409 `terms_outdated`.
  - Current versions → 201. Postgres then holds three `terms_acceptances` rows (`2026-10-20` each, with `accepted_at`), an `owner`/`active` membership, and audit entries 1 `tenant.created` and 2 `terms.accepted` (payload is the three versions; actor `user`; no PII).
  - `pnpm audit:verify --tenant 5401107a-8718-4a4a-b95a-35bc406aa208` → `ok: true`.
- **NFR-17 / UC-01 2c, live:**
  - With `docker compose stop mailpit`, a request → 202 `{"delayed":true}`, with `send_attempts=1` and `next_attempt_at` 10 s out.
  - After `docker compose start mailpit`, the scheduler-worker sweep delivered the link 13 s later. Its row shows `sent_at` set and `send_attempts=2`.
- **Contracts:** request, response and error shapes as observed match design §3 (`AuthOptions`, `{ delayed }`, `{ next }`, `Me`, the error envelope and codes).
- **Screens:**
  - Manifest entries SCR-APP-001, -002, -003 and -059 exist with `code-native` strategy and FEAT-005, and their covered states match ui-design.md.
  - Every claimed state except the transient ones (sending, verifying, saving, and "declined", which has no UI) now renders under E2E with axe clean.
  - The new CSS uses `var(--…)` tokens; the only raw values are 1–2 px border and outline widths, the existing convention.
- **Pending environment:**
  - The **live Google sign-in** against accounts.google.com (design §8 item 5). Verified by: real OAuth client credentials at MD and one sign-in on the deployed stack.
  - The **per-IP limit behind CloudFront/ALB**: `trustProxy: true` takes a client-settable `X-Forwarded-For` entry (design §8 item 6). Verified by: setting the hop count at MD and a spoofed-header test there.
  - **SES SMTP delivery** at MD.

## Findings

### Rework
None.

### Design defect
None.

### Minor
- **M1: design drift, the sweep's 30-second hold-off.** `packages/identity/src/magic-link.ts:35` (`nextAttemptAt: now() + 30 seconds`, explained in the doc comment at line 22) and the test "a new link is left to the requester for 30 seconds" (`identity.int.test.ts`) differ from design §4, which gives `next_attempt_at` a default of `now`. The hold-off is sound: it stops the sweep sending a duplicate while the api's immediate send is in flight. But it isn't recorded in the design. Suggest a one-line note in §5.3.
- **M2: UI drift, verifying spinner timing.** ui-design SCR-APP-002 "verifying" shows the spinner after 300 ms. `apps/dashboard/src/pages/verify.tsx:88` shows it at once. This is cosmetic.
- **M3: per-IP limit and `trustProxy`.** `apps/api/src/server.ts:25` uses `trustProxy: true`. This is already design §8 item 6, which must be done before MD; it is listed here so it isn't lost.
- **M4: transient states are not under E2E.** sending, verifying and saving were inspected in code only (`aria-busy`, read-only fields). This is a test-coverage note.
- **M5: no mutation check** (see Corrected and added tests).
- **Process note.** An early mistyped log redirect in this run wrote a stray `/format.log` (a prettier summary, 126 bytes) at the container's filesystem root. It is outside the repository and I could not remove it under this environment's safety policy; it is safe to delete.

## RTM

Test ref appended (Test ref column only, append-only):
- ONB-01: `features/FEAT-005-sign-in/acceptance-report.md`
- AUTH-01: `features/FEAT-005-sign-in/acceptance-report.md`
- AUTH-02: `features/FEAT-005-sign-in/acceptance-report.md (partial)`. The plan gives FEAT-005 `AUTH-02 (p)`; the sessions list is FEAT-008.
- AUTH-08: `features/FEAT-005-sign-in/acceptance-report.md`. FEAT-005's plan touchpoint has no `(p)`. AUTH-08 becomes fully verified only once FEAT-073 (`AUTH-08 (p)`, re-acceptance) also has an accepted report, as the RTM computes.

## Routing

Feature verified. M1 and M2 are optional doc touch-ups for detailed-design and ui-design. M3 and the pending-environment items belong to milestone MD (initial deployment). Next in the plan's build order is the loop's next feature after FEAT-005.
