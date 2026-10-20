# UI Design: FEAT-003 — PII masking at the edge

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-WGT-002 (p) · Mode: per-feature · Status: Verified · Date: 2026-10-20

No design tool is connected and the manifest policy is `code-native`. FEAT-003 adds no component, state or copy to SCR-WGT-002, so `docs/design-manifest.json` is unchanged; this note records how the existing screen shows the feature's result.

## SCR-WGT-002 — Chat panel

- **Content and data mapping:** the visitor's bubble already renders the stored `Message.body` returned by `POST /widget/v1/conversations/:id/messages` (FEAT-022 ui-design, "visitor and stored replies ← `Message`"). That body is now masked, so a visitor who types `My IC is S1234567D` sees `My IC is [NRIC ••••567D]` in their bubble once the send returns. The token is plain text in the bubble, styled as the rest of the message; no highlight, badge or tooltip.
- **No notice.** The panel does not tell the visitor a number was hidden. GOV-04 asks for masking, not a notice, and the token itself shows what happened. Adding a system notice would be a new state for a later widget feature to design if pilots ask for it.
- **States:** unchanged. The composer keeps no copy of the raw text after a successful send (existing behaviour: it clears); on a failed send the typed text stays in the composer, in the visitor's own browser only.
- **Accessibility:** the bullets are read as "bullet" by screen readers, followed by the visible digits; acceptable, and noted for FEAT-033's widget accessibility pass (technical design §8).
- **Conformance:** pass. No new styles or tokens.
