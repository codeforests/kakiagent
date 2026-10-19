# UI Design: FEAT-002 — Audit chain

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 · Pairs with: [technical-design.md](technical-design.md)
> Screens: none · Mode: per-feature · Status: Verified · Date: 2026-10-19

FEAT-002 has no screen. The plan lists its screens as "— (verify CLI; viewer is FEAT-060)", and the Owner/Admin audit viewer with the "Verify audit chain" action is SCR-APP-050, which FEAT-060 designs and builds on top of `verifyChain` (technical design §3.2). `docs/design-manifest.json` is unchanged.

The only user-facing surface is the operator CLI's output (technical design §3.4): one JSON object, `VerifyResult`, on stdout, and the exit code. It is for operators and support, not for tenants, so design.md does not apply to it.
