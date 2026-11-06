# Handoff: FEAT-056 — Signed mobile approval links
Branch: feat/FEAT-056-approval-links · PR: see below · Updated: 2026-11-06 by build (UI)
Stage done: build (T1–T8 of 8), developer-done
Next: verify — kickoff: "Verify FEAT-056 on branch feat/FEAT-056-approval-links. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Landing: `apps/dashboard/src/pages/approval-link.tsx` at `/approve` (outside the shell, `router.tsx`); helpers and unit tests in `lib/approval-link.ts`/`.test.ts`; `verify.tsx` sends a sign-in link carrying `approvalLink` back to `afterSignIn(next)`.
- `AuthLayout` gained `focusOnMount` (the sign-in and wrong-account states mount their own layout, so `focusKey` alone wouldn't move focus there).
- E2E `e2e/tests/approval-link.e2e.ts` (one test, phone 375×5000): Mailpit alert link → sign-in state (axe) → landing's sign-in link → `/approvals/:id` → edit a price, approve → reopen "already used" (axe) → tampered "isn't valid". `support.ts`: `resetSignInLimits` exported, `magicLinkFor(…, 'approve')`.
- Wrong account, expiry, not-member and switched-business are integration-only (`apps/api/test/approval-links.int.test.ts`); the UI states were checked with a stubbed Playwright run (tasks.md T6 evidence).

## Left to CI or later
- E2E (never run: no Docker here); `uploads.int` (LocalStack) and `rate-limit.int` (Valkey) need containers.
- Watch in CI: the alert email must reach Mailpit within `magicLinkFor`'s 30 s.

## Pending for Ken
- None.
