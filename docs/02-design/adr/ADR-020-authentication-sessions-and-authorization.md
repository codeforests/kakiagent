# ADR-020: Authentication, sessions and authorisation

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-08, ONB-01, DSH-03, DSH-06, APR-03, NFR-05, NFR-06, GOV-13, UC-01, UC-02, UC-06, UC-07, UC-33

**Context**
Sign-in by magic link (single-use, 15-minute expiry, rate-limited, non-enumerating) or Google (AUTH-01); sessions that expire after 12 hours idle or 30 days absolute and stop working immediately after sign-out, a role change or deactivation (AUTH-02, DSH-03); TOTP MFA with tenant-enforced MFA, MFA mandatory for operators, and re-authentication within 10 minutes for sensitive actions (AUTH-03); one person in many tenants (AUTH-04); verified email change (AUTH-05). Data must stay in Singapore.

**Decision**
- **Self-hosted authentication inside the `identity` module**, built on a maintained TypeScript authentication library (Better Auth is the candidate, to be confirmed in detailed design) with all state in Aurora (ap-southeast-1). Google sign-in via OIDC (authorisation code + PKCE).
- **Magic links:** a 256-bit random token, stored hashed with `expires_at = now + 15 min` and `used_at`; consumed atomically. Requests are rate-limited per email (5 per 15 minutes) and per IP in Valkey; the response is identical whether or not the email exists.
- **Sessions:** opaque random token in an `HttpOnly; Secure; SameSite=Lax` cookie, stored hashed in `sessions` with `last_seen_at`, `created_at`, `reauth_at`, `mfa_at`. Every request validates the session against the database (cached ≤ 30 s in Valkey and invalidated on change), so deactivation, role change and "sign out everywhere" take effect at once.
- **Authorisation:** a central policy table maps (role, capability) per SRS §2.1, plus per-user grants (D3 approval rights). Checks happen in the API and the tenant is enforced again by RLS (ADR-005). The active tenant is chosen by the tenant switcher and stored on the session; membership is re-checked on every request.
- **MFA:** TOTP (RFC 6238) with hashed recovery codes; tenant flag `mfa_required`; sensitive endpoints declare `requireReauth(10 min)`, satisfied by a fresh magic link, Google re-prompt or TOTP.
- **Operators:** a separate operator app on its own subdomain, a separate `operators` table (not tenant members), mandatory TOTP, shorter sessions (8 hours absolute), and tenant data access only through `support_grants` (ADR-005).
- **Terms acceptance (AUTH-08):** `terms_acceptances(user, tenant, document, version, accepted_at)`; go-live checks the current versions.

**Options considered**
- **Self-hosted library on our Postgres (chosen)** — exact control over the SRS's session and re-auth rules, data in Singapore, no extra sub-processor. Con: we own security-critical code; mitigated by using a maintained library, ASVS L1 checks (NFR-05) and the external penetration test (NFR-15).
- **Amazon Cognito** — managed, in-region. Lost: no native magic links (email OTP only), immediate session revocation and re-auth windows need custom work around its token model, and multi-tenant membership lives in our database anyway.
- **Auth0 / Clerk** — feature-rich. Lost: another sub-processor holding user data, likely outside Singapore.

**Consequences**
Authentication is part of the penetration-test scope. The session check on every request costs a cache lookup. The library choice is confirmed in detailed design, against its support for magic links, TOTP and database-backed sessions.
