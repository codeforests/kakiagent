# UI Design: FEAT-033 — Widget visitor controls and EN / 中文 chrome

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E4) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-WGT-002 (extended), SCR-WGT-006 (new, partial: no rating until FEAT-031) · Mode: per-feature · Status: Draft · Date: 2026-10-26

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so these are code-native specs. The widget uses only `--kaki-*` variables inside its closed shadow root (design.md §4.9); sizes below are the panel's existing px scale. Components: `panel-header` (menu added), `system-notice`, `button`, and two widget-local parts, `menu` and `end-card`. No new token.

## Copy (string table, `strings.ts`)

| Key | en | zh-Hans |
|---|---|---|
| `menu` (menu button aria-label) | Chat options | 聊天选项 |
| `talkToPerson` | Talk to a person | 转人工客服 |
| `privacyNotice` | Privacy notice | 隐私声明 |
| `opensInNewTab` (sr-only suffix) | (opens in a new tab) | （在新标签页打开） |
| `endChat` | End chat | 结束对话 |
| `endConfirmTitle` | End this chat? | 结束本次对话？ |
| `endConfirmBody` | The assistant won't reply here any more. You can start a new chat any time. | 助手将不再在此回复。您可以随时开始新的对话。 |
| `keepChatting` | Keep chatting | 继续聊天 |
| `endChatConfirm` | End chat | 结束对话 |
| `ending` | Ending… | 正在结束… |
| `endFailed` | Couldn't end the chat. Try again. | 无法结束对话，请重试。 |
| `endedTitle` | Chat ended | 对话已结束 |
| `transcriptNotice` | The business keeps a record of this chat. | 商家会保存本次对话的记录。 |
| `newChat` | Start a new chat | 开始新的对话 |

Existing keys are unchanged. Tenant texts (greeting, disclosure, notices, bot name) are never translated.

## SCR-WGT-002 — Chat panel (extended)

- **Strategy and source:** code-native (this section); the anchor spec and earlier supplements are unchanged otherwise.
- **Header:** title · "AI assistant" label · menu button (44 × 44 `icon-btn`, three-dot icon, `aria-label` `menu`, `aria-haspopup="menu"`, `aria-expanded`) · Close. The menu button shows whenever `menuItems` returns at least one item (before the first message and with no privacy URL there is none, so it is hidden).
- **Menu (`role="menu"`):** absolutely positioned under the button, right-aligned to the header's 16 px padding, min-width 200 px, `--kaki-surface` background, 1 px `--kaki-border`, radius `--kaki-radius`, the panel's shadow, 4 px vertical padding, above the log (z-index within the shadow root only). Items (`role="menuitem"`, in order, as `menuItems` returns them): Talk to a person (button; flag only, FEAT-044) · Privacy notice (link, `target="_blank"`, `rel="noopener noreferrer"`, sr-only `opensInNewTab`, external-link icon 12 px `aria-hidden`) · End chat (button). Each 44 px min height, 0 16 px padding, 14 px text in `--kaki-text`; hover and keyboard focus fill `--kaki-subtle`, focus-visible also the 2 px `--kaki-accent` outline used elsewhere.
- **Keyboard:** Enter, Space or ArrowDown on the button opens the menu on the first item, ArrowUp on the last; ArrowDown/ArrowUp wrap; Home/End; Enter or Space activates; Escape closes the menu and returns focus to the button (stopping propagation so the panel stays open); Tab closes it and moves on; a click outside closes it. Activating End chat opens the confirm card (SCR-WGT-006).
- **Footer line:** when `privacyNoticeUrl` is set, a 12 px `--kaki-muted` line centred under the composer, padding 0 12px 8px: the `privacyNotice` link (underlined, `--kaki-text`, same new-tab rules). Absent otherwise; no empty space is left.
- **States added:**
  - `menu-open`: as above, over the log.
  - `locale-zh`: after a reply with `language: 'zh'` the mount's `lang` becomes `zh-Hans` and all chrome (placeholder, Send, aria-labels, menu, notices the widget renders) switches to the zh-Hans column; it switches back if a later reply is `en`. Before any reply, `navigator.language` decides. The switch is silent (no announcement); the log's existing per-bubble `lang` (FEAT-023) is unchanged.
  - `chat-ended (visitor)`: the composer is replaced by the SCR-WGT-006 done card.
- **Responsive notes:** below 480 px the menu keeps its anchor and width (the panel is full-screen); the footer line stays above the on-screen keyboard with the composer.
- **Decisions:** End chat is a plain menu item, not a danger style: ending is reversible by starting a new chat and is confirmed once (driver: a visitor shouldn't feel warned off; rejected: `danger` colour, which the widget has no clamped token for).

## SCR-WGT-006 — End of chat

- **Strategy and source:** code-native (this section). Rendered inside the panel in the composer's place (the log stays visible above it), not as a separate view or a modal over the host page.
- **confirm:** a card (`role="group"`, `aria-labelledby` its title) on `--kaki-subtle`, radius `--kaki-radius`, margin 12 px, padding 16 px: title `endConfirmTitle` (16 px, 600, receives focus with `tabindex="-1"`), body `endConfirmBody` (14 px, `--kaki-muted`), then two equal-width 44 px buttons side by side: `keepChatting` (surface background, 1 px `--kaki-border-strong`, `--kaki-text`) and `endChatConfirm` (`--kaki-accent` with `--kaki-on-accent`, like Send). Keep chatting or Escape returns to the composer and focuses the menu button.
- **ending:** the End chat button shows `ending` and both buttons are disabled; no spinner below 300 ms.
- **error:** `endFailed` in the panel's existing `.error` style above the buttons (`role="alert"`); the card stays so the visitor can retry or keep chatting.
- **done:** the card shows title `endedTitle` (focused), `transcriptNotice`, the privacy link line when set, and a full-width `newChat` button (accent). The log stays scrollable; the composer and the menu's End chat are gone. FEAT-031 inserts its rating above `newChat`.
- **AI-ended (FEAT-025):** unchanged: its notice row and the disabled composer, no done card, no Start a new chat.
- **Responsive notes:** the buttons stack below 320 px wide.
- **Decisions:** confirm in place rather than a dialog (driver: a modal inside a 380 px panel hides the conversation the visitor is deciding about, and a second focus trap inside the shadow root adds weight to `panel.js`).

## Gaps and escalations

- Talk to a person is designed above but not visible until FEAT-044; its escalation states ("Asking the team…", staff joined) are the anchor's `human` state, built by FEAT-044.
- Rating in the done card (FEAT-031). Privacy URL data (FEAT-058).
