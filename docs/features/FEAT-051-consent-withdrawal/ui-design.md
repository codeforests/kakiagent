# UI design: FEAT-051 — Consent withdrawal in any channel

> Screens: SCR-WGT-003 (partial: withdrawn), SCR-APP-033 (partial: consent withdrawn, record withdrawal), SCR-APP-032 (partial: withdrawn chip, export note), SCR-APP-014 (partial: sidebar line), SCR-APP-056 (partial: alert toggle) · Contracts: [technical-design.md](technical-design.md) §3 · Design system: `docs/02-design/design.md` (§4.9 widget `consent-card` styling, `system-notice`; §4.1 `button`; §4.2 `radio`; §4.3 `alert`, `toast`; §4.4 `card`, `chip`; `confirm-dialog`) · Strategy: code-native (no design tool connected) · 2026-11-07

Widget copy is given in English; every widget string also has a `zh-Hans` entry in `strings.ts`. `{business}` is the tenant's business name.

## SCR-WGT-003 — Consent and details (withdrawn)

The withdraw card sits in the message log under the agent message that carries it (`card.kind === 'withdraw'`), styled like the consent card: full log width, `--kaki-surface` fill, 1 px `--kaki-border`, `--kaki-radius`, padding 16, `role="group"` with `aria-labelledby` its title. Only the active card is interactive (`activeCard`: the latest card in the log); an earlier unanswered one collapses to "Not answered".

**Asked**
- Title (body, weight 600): "Stop using your details?"
- Body: "{business} will stop using your contact details and won't contact you about your enquiry or send you offers."
- Buttons, right-aligned, wrapping on narrow panels, 44 px targets: primary "Yes, stop"; when `offers` is true, secondary "Just stop offers"; ghost "Keep my details".
- When `offers` is true, a caption under the body: "Just stop offers: {business} can still reply about your enquiry."
- Focus: stays in the composer when the card arrives; the log's live region announces "{bot} asks you to confirm".

**Sending:** all buttons disabled; the pressed one shows the spinner with its label kept (`aria-busy`).

**Withdrawn (`all`):** the card collapses to one line, success icon (`--kaki-success`) + "You withdrew consent · 2:31 pm"; the stored system notice follows: "Done. {business} will stop using your contact details and won't contact you." Focus moves to the notice.

**Offers stopped (`marketing`):** collapses to "You stopped offers · 2:31 pm"; notice "Done. {business} won't send you offers. They can still reply about your enquiry."

**Already withdrawn** (a second press, or staff recorded it meanwhile): collapses as Withdrawn, with no second notice.

**Nothing held** (`nothing_held`, e.g. the contact was deleted meanwhile): collapses to "{business} has no contact details from you in this chat." (local text, not stored).

**Kept:** "Keep my details" collapses to "You kept your details with {business}." (local, nothing sent). Focus returns to the composer.

**Failed** (network, 5xx): inline danger `alert` inside the card (`--kaki-danger`, icon and text, never colour alone): "Couldn't save your answer. Try again." Buttons enabled again.

The agent's fixed replies (`withdraw_none`, `withdraw_already`, `data_request`) are ordinary agent messages without a card.

## SCR-APP-033 — Lead (consent withdrawn, record withdrawal)

- **Withdrawn alert:** when `consentWithdrawnAt` is set, a danger `alert` (not dismissible) directly under the header: title "Consent withdrawn", text "On 18 Nov 2026, 2:31 pm this person withdrew consent. Don't contact them or use their details. They're left out of exports." The Status menu still works (so the team can mark it Lost).
- **Consent card entries:** besides FEAT-050's four, "Withdrew consent" (enquiry withdrawn) and "Stopped offers" (marketing withdrawn), each with the time and its channel: "Website chat" (with a link "See conversation" to `/inbox/:conversationId`) or "Recorded by {name}". Withdrawal entries have no wording disclosure.
- **Record withdrawal** (Owner, Admin; hidden for Agents and when already fully withdrawn): a secondary button at the foot of the Consent card, "Record withdrawal". It opens a `confirm-dialog`:
  - Title "Record a consent withdrawal"; text "Use this when {name or 'this person'} asked you directly to stop using their details. Only they can give consent again, in a later chat."
  - When the latest marketing answer is agreed: a `radio` group "What did they ask?" with "Stop all use of their details" (default) and "Only stop offers"; otherwise no radios (all).
  - Buttons: danger "Record withdrawal", secondary "Cancel". Sending: the primary shows "Recording…" and is busy.
  - Success: dialog closes, focus returns to the Consent card's heading, toast "Withdrawal recorded"; the page shows the new state from the response.
  - Errors: 403 → toast "You can't change leads."; other → inline `alert` in the dialog "Couldn't record it. Try again."
- Marketing flag (FEAT-050 `MarketingFlag`): with `marketing.withdrawn`, reads "Offers: stopped 18 Nov 2026".

## SCR-APP-032 — Leads (withdrawn chip, export note)

- A row whose `consentWithdrawnAt` is set shows a neutral `chip` "Consent withdrawn" (with a `--color-danger-fg` icon) in place of the marketing flag. Rows stay in their status tab (D4).
- Export dialog: one more caption line under the existing text, "Leads whose consent was withdrawn are left out."

## SCR-APP-014 — Inbox (sidebar Lead section)

- When `consent.withdrawnAt` is set: a line "Consent withdrawn · 18 Nov, 2:31 pm" with the danger icon, above "Open lead"; the marketing line reads "Offers: stopped" when `marketing.withdrawn`.

## SCR-APP-056 — My notifications (new toggle)

- A row after "New hot lead": label "Consent withdrawn", help "When a customer asks you to stop using their details." Same email toggle and quiet-hours behaviour as the others (from `lib/notifications.ts`).

## Tokens used

Dashboard: `--color-danger-soft`/`-fg`, `--color-surface`, `--color-border-default`, `--color-text-primary`, `--color-text-secondary`, `--space-2`…`--space-5`, `--radius-md`, `--size-control-md`. Widget: `--kaki-surface`, `--kaki-border`, `--kaki-text`, `--kaki-muted`, `--kaki-accent`, `--kaki-on-accent`, `--kaki-danger`, `--kaki-success`, `--kaki-radius`, `--kaki-font`. No new tokens.

## Gaps and escalations

- D1 (Just stop offers) awaits Ken; without it the widget card has two buttons and the dialog has no radios.
- Other channels render the `withdraw` card through their adapters when they land (FEAT-037 Telegram first).
- SCR-APP-016 (Contact) and SCR-APP-049 (Data request) are later features.
