# UI Design: FEAT-023 — Language and register, out-of-scope handling, after-hours behaviour

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-WGT-002 (p) · Mode: per-feature · Status: Verified · Date: 2026-10-21

No design tool is connected and the manifest policy is `code-native`, so this section is the design. SCR-WGT-002 already has an anchor entry with supplements from FEAT-022. This feature designs one of its listed gaps, **after-hours**, and adds the language-of-parts rule for Chinese replies. Out-of-scope and "check with the team" replies are ordinary bot bubbles (the FEAT-022 `fallback` state covers their look), so they need no new state. No dashboard screen changes: the hours editor is SCR-APP-044 (FEAT-009) and the editable after-hours message is SCR-APP-041 (FEAT-024).

## SCR-WGT-002 — Chat panel

- **Strategy and source:** code-native. The anchor spec ([anchor-screens.md](../../02-design/anchor-screens.md#scr-wgt-002--chat-panel)) and the FEAT-022 supplements stay the reference; this section specifies the after-hours state and the language rule.
- **Composition (added now):** a `system-notice` (design.md §4.9: "after hours with the return time") in the log, above the reply it belongs to. Not built here: the lead form that follows the notice in the anchor's F8 flow (FEAT-049), and the "Talk to a person" chip (FEAT-044).
- **Content and data mapping:**
  - after-hours notice ← `Message.notice` (technical-design §3), present on the first reply of a closed period; the text is server-rendered in the reply's language with the return time already formatted (for example "We're closed right now. The team will be back tomorrow at 9:00 am. I can still answer your questions in the meantime.").
  - language of parts ← each message's own text: a bubble whose text contains Han characters gets `lang="zh-Hans"`; others inherit the panel's `lang`.
- **Conformance:** pass. Reuses the existing `.notice` style (`--kaki-muted` on `--kaki-subtle`, 12/16 px, pill, centred), so no new token or component. Contrast is the pair already checked for the slow-reply notice.

### after-hours
Order in the log for a reply that carries a notice: the disclosure row (if this is the first reply), then the notice, then the reply bubble. The notice is a list item with `class="notice"` and no `role="status"` (it is part of the conversation record, announced once by the log's `aria-live="polite"` region, like the reply). It is never dismissible, so a visitor who scrolls back sees why nobody answered until morning. It appears once per closed period: later replies in the same night carry no notice, and the server decides this, not the widget. While the reply is still streaming (the growing bubble), the notice isn't shown yet; it arrives with the stored message and is placed above the replaced bubble, so the bubble doesn't jump: the notice is inserted above content the visitor is already reading, which is acceptable because it is short (one to three lines at 12 px).

### language
Every bubble (visitor, agent, system, and the growing bubble) whose text contains a Han character carries `lang="zh-Hans"` (WCAG 3.1.2). The panel's own chrome language is unchanged (FEAT-033 adds 中文 chrome by host page language; strings.ts already has both). A Chinese notice row gets the same attribute.

- **Responsive notes:** the notice wraps within the log's width with 10 px side padding; at 390 px a three-line English notice stays readable without truncation.
- **Decisions:** the notice sits above the reply, not below it (driver: it explains the reply's context, "we're closed, but here's the answer"; rejected: below, which reads as an afterthought and can fall under the composer on a phone).

## Cross-screen decisions

None: one screen.

## Escalations and open items

- None filed. The manifest gap `after-hours` is now covered; `rate-limited`, `waiting-for-approval` and `attachment` remain gaps for the features that produce them.
