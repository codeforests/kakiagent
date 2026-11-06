# Handoff: FEAT-056 — Signed mobile approval links
Branch: feat/FEAT-056-approval-links · PR: none · Updated: 2026-11-06 by design
Stage done: design
Next: build (backend, T1–T5) — kickoff: "Build FEAT-056 (backend) on branch feat/FEAT-056-approval-links. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- ADR-013 §5 is the design: a stateless HMAC token `{v,t,a,u,e,n}` minted per recipient at alert send time; the nonce is stored only on first use (`used_link_nonces`, PK `(tenant_id, nonce)`, insert `on conflict do nothing` decides races).
- Key = HMAC(`MAGIC_LINK_SECRET`, 'kaki/approval-link/v1') (D2): no new env variable.
- Platform must not import approvals: the scheduler injects `SendOptions.linkOf`; only `approval_pending` gets the signed link (D3).
- The open route never answers 401 for "not signed in" (the dashboard's query cache routes any 401 to /sign-in without a return path): `sign_in`/`two_step`/`two_step_setup` are 200 states.
- Order of checks (D6, D7): signature → expiry → used → session → same user → active member → consume + audit → switch workspace. Wrong account consumes nothing.
- The sign-in continuation is server-side for email links (`magic_links.approval_link`, D1) and `sessionStorage` + `next=approve` for Google.
- UI session: `/approve` outside the shell, one `AuthLayout` keyed by state; T6's stubbed Playwright check is worth running.

## Left to CI or later
- E2E (T7) and screen renders run in the verify stage's GitHub CI (no Docker in cloud sessions).

## Pending for Ken
- None.
