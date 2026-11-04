# Handoff: FEAT-049 — Consent and lead capture
Branch: feat/FEAT-049-lead-capture · PR: none · Updated: 2026-11-04 by design
Stage done: design
Next: build (backend, T1–T7) — kickoff: "Build FEAT-049 (backend) on branch feat/FEAT-049-lead-capture. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- The lead is written only by the widget's form submit (`/lead`, `/contact`); the `capture_lead` handler returns a card and writes nothing (D1). Consent is the dispatcher's existing `needsConsent` check; its `consent` refusal becomes the consent card in the turn (§5.3).
- Consent is per conversation (D2); duplicates match by email then phone (D4); `leads_one_open_uq` is the LED-09 guard.
- The visitor zone reads wordings only through `visitor_privacy()`: replace it in 0048 (same owner `kaki_tenant_state`) to add the marketing wording and lead fields.
- Inbox must not import leads (dependency-cruiser): the api passes a contact/lead lookup into the sidebar and search, like `OwnerNames`.
- `SearchMatch.messageId`/`author` become nullable: check the dashboard's `lib/search.ts` and `ThreadLog` `matchId` still typecheck (T2's dependants typecheck).
- Seed needs a saved purpose statement and notice for both dev tenants, or no dev widget captures leads (§5.9).
- The widget has no `--kaki-danger`/`--kaki-success`; T8 adds them via `tokens.json` and the generator (ui-design Tokens).

## Left to CI or later
- E2E (T12) and screen renders run in the verify stage's GitHub CI (no Docker here).
- Scoring and the hot-lead alert (UC-21 5–6) are FEAT-050 (D8).

## Pending for Ken
- None. D3 decided 2026-11-04: marketing opt-in off until the owner turns it on.
