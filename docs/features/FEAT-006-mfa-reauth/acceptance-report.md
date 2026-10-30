# Acceptance Report: FEAT-006 — Two-step verification and re-authentication for sensitive actions

> Verdict: **Accepted** (GitHub CI run 76 green at `b93d8f8`, 2026-10-30, incl. E2E `two-step.e2e.ts` in Chromium, Firefox and WebKit) · Date: 2026-10-30
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-12) · Sources: SRS v0.4 (AUTH-03), use-cases v0.4 (UC-02 steps 3, 3a, 3c), ADR-005, ADR-014, ADR-020, NFR-08
> Repo state audited: `053d369` (implementation head); one test strengthened (see Corrected tests)

## Verdict summary

FEAT-006 is accepted. Each of AC-1..AC-12 has tests that assert what the criterion says, and the criteria encode AUTH-03's tenant-user half faithfully: TOTP enrolment with ten recovery codes, Owner-enforced two-step that blocks every tenant route and `/ws` until the member enrols, and `requireReauth` with its 10-minute window. Partial by design and not claimed: operator MFA (FEAT-070) and the wiring of each AUTH-03 sensitive action to `requireReauth`, which arrives with the feature that builds each action (D9). Google re-prompt as a re-auth method is deferred (D4, design §8 item 1); the emailed link stands in.

The test diff adds files and cases only (one import line changed in `ws.int.test.ts`); no assertion was loosened, skipped or deleted.

## Audit standard

AUTH-03 (M): tenant users can enrol a TOTP authenticator; the Owner can require MFA; sensitive actions are refused without a fresh re-authentication within 10 minutes; recovery codes are issued at enrolment; enforced MFA blocks dashboard access until the user has enrolled. UC-02 3 (code challenge after sign-in), 3a (forced enrolment), 3c (five wrong codes lock for 15 minutes; a recovery code still works). Design §9's trace was checked against these; the operator and per-action halves are deferred in D9.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 | AUTH-03, UC-02 3a | identity `mfa.int` "confirms one code…", api `mfa.int` "runs the whole flow", identity `mfa.test` (RFC 6238 vectors, codes) | Yes: wrong code confirms nothing, ten distinct codes once, ciphertext contains neither the base32 nor the raw secret and opens with the sealer, 32-byte hashes, 409 on restart | Pass |
| AC-2 | UC-02 3 | identity `mfa.int` "a new session must pass a code…", api whole flow, realtime 4401/4403 case | Yes: `next: 'mfa'`, 401 `mfa_required` on tenant routes and `/me`, sign-out works, ±1 step, replay refused | Pass |
| AC-3 | UC-02 3c | identity `mfa.int` lock case, api lockout and recovery-limit cases | Yes, after correction: TOTP re-auth while locked was not asserted; added | Pass |
| AC-4 | AUTH-03 | api `mfa.int` workspace requirement, identity `mfa.int` workspace case, realtime 4403 | Yes: Owner only, stale 403, not enrolled 409, one audit entry and no-op repeat, existing sessions 403 `mfa_enrolment_required`, counts per tenant | Pass |
| AC-5 | AUTH-03 | identity `mfa.int` re-auth cases, api whole flow | Yes: 11-minute-old `reauth_at` refused with methods, TOTP and link refresh, `link_other_session` with no or another session and the link stays usable | Pass |
| AC-6 | AUTH-03 | identity `mfa.int` "new codes invalidate…", "other sessions…", workspace case | Yes | Pass |
| AC-7 | ADR-014 | identity lock case (per-tenant entries, payload `{}`, `verifyChain`), api policy case | Yes | Pass |
| AC-8 | ADR-005 | db `rls.int` "two-step verification (FEAT-006)" | Yes: zones, own-tenant `mfa_required`, SECURITY DEFINER counts per tenant, link check | Pass |
| AC-9 | SCR-APP-005 | E2E `two-step.e2e.ts` (setup, wrong then right code, copy/download, gated Continue, challenge, locked, recovery) | Yes; forced-enrolment variant needs a second member (FEAT-007), not in E2E | Pass (run 76) |
| AC-10 | design.md `reauth-dialog` | dashboard `lib/reauth.test.ts`; E2E stale actions by link and by TOTP | Yes: retries once, cancel rejects, other errors pass through | Pass (run 76) |
| AC-11 | SCR-APP-055 p, SCR-APP-045 p | E2E My account and Team | Yes for the Owner; Admin/Agent read-only not in E2E (needs FEAT-007 members) | Pass (run 76) |
| AC-12 | NFR-08 | E2E axe light and dark, 375 px, `inputmode`/`autocomplete` asserted | Yes | Pass (run 76) |

## Corrected tests

- `packages/identity/test/mfa.int.test.ts` (AC-3): the lock case asserted the challenge was locked but not that TOTP re-auth was. Added: a session that has passed the challenge gets `MfaLockedError` from `reauthenticate` with the right code while locked. Commit `FEAT-006 acceptance: correct test for AC-3`.

## Independent execution

This session, through `scripts/test-env.sh`: `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser), `pnpm typecheck`, `pnpm test` all pass. `test:coverage`: identity 52 passed (30 integration after the correction), db 149, channels 49, realtime integration 5. Api 286 passed and platform 266 passed, each failing only on a Docker-only suite (`uploads.int.test.ts` "the S3 presigner"; `rate-limit.int.test.ts` needs Valkey): no container runtime in cloud sessions, unrelated to this change. E2E, `terraform validate` and those two suites run in GitHub CI.

## Direct verification

- `authenticate` computes the two-step state in its one query (D2); `authFrom` refuses any state a route doesn't `allow`, so every existing route is closed to pending sessions without edits. `passChallenge` sets `mfa_at`; `reauthenticate` sets only `reauth_at`, so re-auth can't skip the challenge.
- Lockout lives on the factor row, so it survives new sessions; the counter and lock commit even on a wrong code (error thrown after the transaction).
- Re-auth link: the session check runs before the atomic claim, so a wrong browser leaves it unclaimed; a revoked session rolls the claim back.
- RLS: new tables have no `tenant_id`, RLS forced with `app_identity` policies only; both SECURITY DEFINER functions pin `search_path` and are owned by NOLOGIN `kaki_mfa_count`; `app_dashboard` has only a column grant on `tenants.mfa_required`.
- Audit payloads are `{}` for user events and `{ required }` for the policy change: IDs and a boolean only (ADR-014). Secret sealed with AAD `mfa:<factor id>`; recovery codes SHA-256 (D5).

## Findings

- Partial (recorded, not blocking): operator MFA (FEAT-070); per-action `requireReauth` wiring (FEAT-054, -010, -050/-060, -061, -063); Google re-prompt (D4).
- Not in E2E (covered by the build's stubbed Chromium smoke only): forced enrolment and Admin/Agent read-only Team; both need a second member (FEAT-007). Worth adding to `two-step.e2e.ts` with FEAT-007.
- Observation: `user_mfa_required_by(uuid)` lets the identity zone list the requiring workspaces of any user ID. That zone already reads users and memberships for sign-in, so it adds no new exposure.
- Already pending for Ken: lost authenticator and all recovery codes has no self-service reset until an operator tool exists (design §8 item 2).

## RTM

Test ref appended: AUTH-03 (partial: operator MFA with FEAT-070; each sensitive action's re-auth with its feature, D9).

## CI

Dashboard, realtime and a new E2E spec changed, so GitHub CI (`ci.yml`, workflow_dispatch on `feat/FEAT-006-mfa-reauth`) decides the E2E and axe rows above.

GitHub CI run 76, `b93d8f8`, 2026-10-30: all 11 jobs green, including E2E (`two-step.e2e.ts` with axe light and dark and 375 px) in Chromium, Firefox and WebKit, `terraform validate`, and the S3 and Valkey suites. Run 75 before it (`5edfe2f`) failed in integration on `@kaki/tenancy` `profile.int.test.ts` (FEAT-009, untouched here): it saves a closed exception at today + 10 days, which on 2026-10-30 is the Deepavali day off, so the rule drops it as redundant. `b93d8f8` makes the test pick the first non-holiday day from +10, with its assertions unchanged; run 75 was cancelled once the cause was clear.
