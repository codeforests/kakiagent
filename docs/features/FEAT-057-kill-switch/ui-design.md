# UI Design: FEAT-057 — Kill switch

> Screens: SCR-APP-058 (new, with the top-bar `ai-status-pill` and the "AI paused" banner), SCR-WGT-005 (adds the paused state) · Mode: per-feature · Status: Draft · Date: 2026-10-28

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables (the widget only `--kaki-*`). Components: `ai-status-pill` + `kill-switch-dialog` (design.md §4.6), `confirm-dialog`/`dialog` (bottom sheet below 640 px), `button` (`primary`, `secondary`, `danger`), `alert`, `banner` #1, `toast`, `tooltip`; widget: `system-notice`, `link`. No new component or token. Copy follows design.md §6: *pause AI* / *resume AI*, calm, no alarm wording.

## AI status pill (top bar, every page)

- **Source:** `GET /api/v1/ai/status` via `useAiStatus` (30 s refetch, on focus, and on the Inbox's `ai_status` event). Replaces the static "Not live" pill in `app-shell.tsx`, same place at every width (design.md §5 top bar).
- **States** (`pillState`, D8), dot + text, never colour alone:
  - **Live** — success-soft fill, success dot, "AI live".
  - **Paused** — danger-soft fill, Lucide `circle-pause` 16 px (danger), "AI paused".
  - **Not live** — neutral (the existing `status-pill--off`), "Not live".
  - **Loading** — neutral pill with a 48 px `skeleton` bar, `aria-busy="true"`, label "AI status".
  - **Error** (status failed to load) — neutral, "AI status" with Lucide `circle-help`; still opens the dialog for Owners and Admins, where the pause action works without the status.
  - **Acting** — while a pause or resume is in flight the pill keeps its old state and shows a 12 px spinner in place of the dot (design.md: "the pill shows a spinner until then").
- **Owner, Admin:** the pill is a `button` (`aria-haspopup="dialog"`, accessible name "AI live. Pause or resume the AI" / "AI paused. …" / "Not live. …"), opens SCR-APP-058.
- **Agent:** a plain `span` with `role="status"` and a `tooltip` on focus/hover: "Only the Owner or an Admin can pause or resume the AI." (focusable with `tabindex="0"` so keyboard users get the tooltip).
- **< 768 px:** text shortens to "Live" / "Paused" / "Not live"; touch target 44 px high via padding.

## SCR-APP-058 — Pause AI dialog

- **Strategy and source:** code-native (this section). Route: none, a `dialog` over the current page opened by the pill or the banner. Roles: Owner, Admin (`killswitch.toggle`).
- **Contract bindings:** `GET /api/v1/ai/status`, `POST /api/v1/ai/pause`, `POST /api/v1/ai/resume`.
- **Pause mode** (status not paused) — `confirm-dialog`:
  - Title "Pause AI on all channels?"
  - Body: "Your assistant stops replying everywhere within 5 seconds, including any reply it's writing now. Your team can still answer from the Inbox."
  - "What visitors see" box (subtle fill, radius md, `aria-label` "What visitors see"): the English fallback in quotes, then caption "Change it in Assistant settings" `link` (`/settings/assistant`).
  - Not live (D8): an `alert` info above the buttons: "No channel is live yet. If you pause now, the AI stays off after you go live until you resume it."
  - Buttons: `secondary` "Cancel" (left), `danger` "Pause AI now" (right). Busy: "Pausing…", both disabled, Esc and scrim don't close.
  - Success: dialog closes, pill → Paused, banner appears, toast "AI paused on all channels." Focus returns to the pill (or to the page's `h1` when opened from a banner that no longer exists).
- **Resume mode** (status paused):
  - Title "Resume AI?"
  - Body: "Your assistant starts answering visitors again on every live channel." Meta line (body-sm, text-secondary): "Paused since {h:mm a, d MMM}" (SGT).
  - Not live: second sentence "No channel is live yet, so visitors won't get AI replies until you go live."
  - Buttons: `secondary` "Cancel", `primary` "Resume AI". Busy "Resuming…".
  - Success: pill → Live/Not live, banner gone, toast "AI resumed." Focus to the pill.
- **States:** live (pause mode), paused (resume mode), pausing, resuming (busy), action failed (`alert` danger inside the dialog: "We couldn't pause the AI. Check your connection and try again." / "…resume the AI…"; dialog stays open, confirm re-enabled), permission (a 403 → `alert` danger "Only the Owner or an Admin can do this." and the confirm hidden), already changed by someone else (the response says the state is already the target → close and toast as success; the server made no change).
- **Never optimistic:** the pill and banner change only from the server's response (`setQueryData`), per design.md §4.10.
- **Responsive:** below 640 px the dialog is a bottom sheet with the drag handle; buttons stack full width, confirm on top.
- **A11y:** `role="alertdialog"` for pause (destructive), `dialog` for resume; title is the accessible name, body the description; initial focus on "Cancel" (least destructive).

## Banner — AI paused (app shell, `shell/banners.tsx`)

- design.md `banner` #1: danger-soft, Lucide `circle-pause` 20 px, **not dismissible**, first in the list (at most two banners show; it always takes a slot).
- Text: "AI is paused on all channels. Visitors see your fallback message." Owners and Admins: `secondary` sm button "Resume AI" → opens SCR-APP-058 in resume mode. Agents: text plus " Your team can still answer from the Inbox." and no button.
- Shown on every page, including Settings and Channels, whenever `status.paused`. `role="region"`, `aria-label` "AI paused".
- Below 768 px the button wraps under the text, full width.

## SCR-WGT-005 — Fallback (adds: AI paused)

- **Contract binding:** `GET /widget/v1/config` → `aiPaused` (and `availability`; not live wins, D7).
- **Paused, widget live:** the launcher shows as usual. The panel opens with the normal `panel-header` (bot name, "AI assistant" label, menu). The log starts with one `system-notice` (paused variant), in place of the greeting and the disclosure row:
  - Lucide `circle-pause` 16 px (decorative), the fallback text in the panel language (zh when the browser locale starts with `zh`, else en; same rule as the not-live view).
  - Contact lines, each only when present, exactly as the not-live card: mail icon + `link` email (`mailto:`), phone icon + `link` phone (`tel:`), visually hidden "Email"/"Phone" ("电邮"/"电话").
  - `role="region"`, accessible name `pausedRegion` "Message from {business}" / "来自{business}的消息".
  - The **composer stays enabled**; the placeholder stays. Visitor messages appear as usual; staff replies arrive as normal messages. The agent posts the fallback once as a `system` message after the visitor's first message (D2); the panel adds nothing of its own.
- **Paused mid-chat:** no live push; the visitor's next message gets the fallback `system` message.
- **Resumed:** the next config load has `aiPaused: null`; an open panel isn't changed (the AI's next reply shows it's back).
- **Strings** (`strings.ts`): `pausedRegion` en/zh (or reuse `notLiveRegion` when identical); contact labels reused.
- **Out of scope:** the contact form (FEAT-049, UX-R4).
- **A11y:** the notice is a labelled region; links have visible focus; `--kaki-*` colours only, clamped like the rest of the panel; focus on open stays on the composer (the visitor can write).

## Gaps and escalations

- Lead capture on the paused notice is FEAT-049.
- No new design.md component, value or token; no escalation.
