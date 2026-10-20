# Tasks: FEAT-005 — Sign up, sign in and sessions

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: pending | in-progress | done per task · Last updated: 2026-10-20

- [x] T1 — Schema: `users`, `memberships`, `terms_acceptances`, `sessions`, `magic_links` (0006), the `app_identity` role, RLS, policies and grants (0007), the `identity` trust zone, seed users; RLS suite cases (design §4; AC-14)
      Done when: `pnpm db:setup` applies 0006–0007 on a fresh database; the cross-tenant suite passes with `memberships` and `terms_acceptances` listed, and new cases show the identity zone can't read conversations, messages, facts or audit entries and the dashboard and visitor zones can't read users, sessions or magic links.
- [ ] T2 — Platform: `createSmtpMailer` (nodemailer) and the rate limiter (`createRateLimiter` on Valkey, `memoryRateLimiter`) (design §5.3)
      Done when: unit tests show the memory limiter allows 5 hits and refuses the 6th in a window and resets after it; the mailer's message building is unit-tested; the Valkey limiter passes the same cases against a Valkey container in an integration test.
- [ ] T3 — Identity domain: tokens, users, magic links (request, consume, send, sweep, purge), sessions (create, authenticate, revoke, revoke all), terms, workspaces (design §5.1–§5.5; AC-1, AC-2, AC-4, AC-6, AC-7, AC-9–AC-11)
      Done when: identity integration tests on the real schema pass for: hashed storage only; single use; expiry; invalid tokens; derived-token re-send after a failing mailer, no send after expiry, 24-hour purge; idle and absolute expiry; revocation of one and all sessions; deactivated membership and disabled user; workspace creation with acceptances and a verifying audit chain; outdated terms creating nothing.
- [ ] T4 — Google sign-in on `openid-client` (design §3.3, §5.1, D1; AC-5)
      Done when: an integration test against a local OpenID provider (discovery, JWKS, token endpoint) passes the happy path and refuses a wrong state, a tampered cookie, an unverified email, a wrong nonce and a mismatched `sub`.
- [ ] T5 — API: contracts (`AuthOptions`, `MagicLinkRequest`, `MagicLinkVerify`, `CreateWorkspace`, the new `Me`), `src/auth.ts` routes, the Origin guard, `sessionFrom`/`authFrom` on the identity zone, config; delete `dev-auth.ts` and `dev-session.ts`; move the existing api tests to real sessions (design §3, §5.2, §5.6; AC-1–AC-3, AC-6–AC-13)
      Done when: api integration tests pass for every endpoint's success and designed errors (202 identical bodies, 429 per email and per IP, 400 link codes, 409 `terms_outdated`, 401 `unauthorized`/`session_expired`, 403 `no_workspace`, 403 foreign Origin, cookie attributes, sign-out and sign-out everywhere), and the fact and widget suites pass on real sessions.
- [ ] T6 — Wiring: realtime `/ws` on `authenticate`; scheduler-worker magic-link sweep; `.env.example` files, `gen-local-env.mjs`, `turbo.json`, Terraform secrets, the CI bundle check (design §5.6; AC-4, AC-10, AC-13)
      Done when: `pnpm dev` starts every role with the generated config; a revoked session's socket is closed with 4401; with Mailpit stopped a link request returns `delayed: true` and the link arrives after Mailpit restarts; `terraform validate` and `terraform test` pass; `pnpm build` bundles contain neither `dev/sign-in` nor `kaki_dev_session`.
- [ ] T7 — Dashboard: SCR-APP-001, -002, -003, -059 (session expired), `/legal/:document`, `/setup` placeholder, the account menu, `me` and 401 routing; delete `dev-sign-in.tsx` (design §5.7; ui-design.md; AC-16)
      Done when: each screen renders its ui-design states against the running api, and typecheck, lint and build pass.
- [ ] T8 — E2E: a Mailpit sign-in helper; `auth.e2e.ts` for sign-up → workspace → `/setup` (under one minute), sign-out, existing-owner sign-in, the used-link page, axe on the auth screens; move `skeleton`, `facts` and `pii-mask` specs to the helper (AC-15, AC-16)
      Done when: every spec passes in chromium against the local stack with `pnpm dev`.
- [ ] T9 — Docs: scaffold-notes §3/§4 (dev sign-in removed, identity zone, D1), AGENTS.md's dev-only convention line, `.env.example` comments (design §2, §8)
      Done when: no document describes the dev sign-in as current, and the stub row names what replaced it.
- [ ] T10 — Verify: every acceptance criterion (design §6) demonstrably passes; format, lint (with boundaries), typecheck, unit, integration, coverage, build, size, eval and E2E green
      Done when: the commands in AGENTS.md "Checks" pass and each AC is mapped to the test or run that shows it.
