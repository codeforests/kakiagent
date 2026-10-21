# UI Design: FEAT-025 — Prompt-injection resistance, harmful content, crisis replies, flagged conversations

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-WGT-002 (p) · Mode: per-feature · Status: Verified · Date: 2026-10-21

No design tool is connected and the manifest policy is `code-native`, so this document is the design. SCR-WGT-002 keeps its anchor entry; this feature adds one state, **chat-ended**. The injection, impersonation, advice, illegal, crisis and abuse-warning replies are ordinary bot bubbles with fixed text (the FEAT-022 `fallback` look), so they need no new state. No dashboard screen changes: the inbox's flagged filter and the conversation view's flag chip are SCR-APP-014/015 (FEAT-042), which read the `flaggedAt`/`flagReasons` contract added here.

## SCR-WGT-002 — Chat panel (p)

- **Strategy and source:** code-native. The anchor spec ([anchor-screens.md](../../02-design/anchor-screens.md#scr-wgt-002--chat-panel)) and earlier supplements stay the reference.
- **Content and data mapping:**
  - ended notice ← `Message.notice` where `Message.noticeKind === 'chat_ended'` (technical-design §3), server-rendered in the reply language ("This chat has ended." / "本次对话已结束。").
  - closed composer ← any message in the log with `noticeKind === 'chat_ended'`.
  - composer placeholder when closed ← chrome string `ended` ("This chat has ended." / "本次对话已结束。"), in the panel's chrome locale.
- **Conformance:** pass. Reuses the `.notice` pill (`--kaki-muted` on `--kaki-subtle`) and the existing disabled send button (`.send:disabled`, opacity .6). The disabled textarea uses `--kaki-subtle` as its fill so it reads as inactive; that pair (`--kaki-muted` text on `--kaki-subtle`) is already contrast-checked for the notice. No new token or component.

### chat-ended
After repeated abuse (AGT-13) the AI's last message ("I'm ending this chat now. Our team can see this conversation.") arrives as a normal bot bubble, then the ended notice row **below** it (the only notice placed after its bubble: it closes the conversation rather than explaining the reply). The composer stays in place so the panel doesn't jump, but the textarea is `disabled` with the placeholder "This chat has ended.", and Send is disabled. Focus: if focus was in the textarea when the ended message arrives, it moves to the panel's close button so keyboard users aren't stranded on a disabled control; the log's `aria-live="polite"` region announces the bubble and the notice. The header's close button and Escape still close the panel. Reloading the host page starts a new conversation (the widget keeps no conversation across loads), which is acceptable: the ended one stays flagged for staff, and GOV-13 rate limits (FEAT-070) cover repeat abuse.

- **Responsive notes:** identical at 390 px and desktop; the notice wraps like the after-hours notice.
- **Decisions:**
  - **Keep the composer visible but disabled, rather than removing it.** Driver: removing it shifts the log and hides why typing stopped; the placeholder says why. Rejected: a "Start a new chat" button, which would invite the abuser straight back.
  - **Crisis contacts stay plain text in the bubble, not tappable links.** Driver: bubbles render text only (no markup parsing in the panel, ADR-016 budget and XSS surface). Rejected for now: `tel:` links, which would need a safe linkifier; noted for FEAT-031/033's widget polish.

## Escalations and open items

- None filed. The manifest gains the `chat-ended` covered state and supplement, and the `Message.noticeKind` binding.
