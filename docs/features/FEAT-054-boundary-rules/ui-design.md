# UI Design: FEAT-054 — Boundary rules with safe defaults

> Screens: SCR-APP-042 (new: Settings → Rules and approvals, the rules part), SCR-APP-009 (adds the rules block) · Mode: per-feature · Status: Draft · Date: 2026-10-30

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `field`, `text-input`, `checkbox`, `button` (`primary`, `secondary`, `ghost`), `icon-button`, `card`, `alert`, `confirm-dialog`, `reauth-dialog` (FEAT-006, through `useReauthGuard`), `toast`, `skeleton`, `error-state`, `link`, `chip`. No new component or token. Copy follows design.md §6: calm, plain, "your assistant", never "the AI agent".

## Shared parts (`pages/rules-parts.tsx`)

- **`TopicListEditor`** (props: `id`, `label`, `help`, `items`, `onChange`, `other` (the opposite list, for the duplicate check), `max`). The widget's allowed-origins pattern: a `field` with `text-input` (placeholder an example, e.g. "e.g. Wedding cakes") and a `secondary` "Add" button on the same row (stacked full width below 480 px); Enter adds. Below it a `list` of the items, each row the text (body) and an `icon-button` "Remove {topic}" (× icon) on the right, 44 px rows on touch. Empty list: caption "None yet." Client errors from `topicError` show as the field's error under the input ("Already in the list", "This topic is blocked, so it can't also be allowed", "Use 2 to 80 characters", "You can add up to 25"); the input keeps its text. Count caption on the right of the label: "3 of 25".
- **`RulesForm`** (props: `data: BoundaryRulesResponse`, `variant: 'settings' | 'setup'`, `onSaved`). Holds a draft copy of `data.rules`; dirty when it differs. Sections, each a `card` with a `title-sm` heading and a one-line lede (body-sm, text-secondary):
  1. **Topics** — lede "Help your assistant know what to talk about." `TopicListEditor` "Topics your assistant helps with" (help "A guide for your assistant. Questions about your business outside this list still get an answer if your facts cover it.") and "Topics your assistant won't discuss" (help "Visitors who ask get a polite 'I can't help with that here'.").
  2. **Discounts and quotes** — `field` "Maximum discount" with a numeric `text-input` (`inputmode="numeric"`, width 96, a "%" suffix inside the field), help "0% means your assistant never offers a discount. Until approvals are set up, your team confirms every discount." (FEAT-055 changes the second sentence); error "Enter a whole number from 0 to 100". `checkbox` "Quotes need your approval before your assistant sends them" with help "Recommended. Your assistant tells the visitor the team will confirm."
  3. **Never promise** — lede "Your assistant won't say any of these, even if a visitor asks." Checkboxes: "Delivery guarantees or exact arrival times", "Refunds or money back", "Legal advice" and "Medical advice" (both checked and disabled, with a `chip` neutral "Always on" after the label, and `aria-describedby` pointing at a caption "Your assistant never gives legal or medical advice."). Then `TopicListEditor` "Other things never to promise" (placeholder "e.g. Same-day delivery", max 10).
  4. **Approvals** (`variant: 'settings'` only) — caption "Approval times and who can approve arrive with approvals." No controls (D8).
- **Prefill notice** (top of the form, when `data.source !== 'saved'`): `alert` info. `template`: title "Suggested rules for food and beverage businesses", body "Check them and save. Until you save, your assistant uses the safe defaults: no discounts, quotes need approval, nothing promised." `default`: title "Safe defaults", body "Your assistant offers no discounts, asks for approval on quotes and makes no promises. Save to confirm or change them."
- **Footer:** `primary` "Save rules" (disabled while saving; in the settings variant also disabled when not dirty and `source === 'saved'`; always enabled when never saved, so the defaults can be confirmed). Meta caption to its right (body-sm, text-secondary): "Saved {d MMM yyyy, h:mm a}" from `savedAt` (SGT), or "Not saved yet".
- **Save sequence** (design.md §4.10): Save → `confirm-dialog` → `useSaveRules` (re-auth dialog if the server asks) → server acknowledgement → toast. Never optimistic: the form takes the response as its new base (`setQueryData(['rules'])`).
  - Confirm title "Save these rules?"; body "They apply from your assistant's next reply." then a `list` of `diffRules` lines (body-sm), e.g. "Won't discuss: added Competitors' prices", "Maximum discount: 0% → 10%", "Refunds: no longer forbidden"; never saved and nothing changed: "You're confirming the safe defaults." Buttons `secondary` "Cancel", `primary` "Save rules"; busy "Saving…", Esc and scrim don't close while busy.
  - Success: dialog closes, toast "Rules saved. They apply from the next reply." Focus returns to the Save button.
  - `ReauthCancelled`: the confirm dialog closes, nothing else; the draft stays.
  - 400 `invalid_rules`: dialog closes; `alert` danger above the footer "Some rules need fixing" listing the issues (`ErrorSummary` from `privacy-parts.tsx`), each linking to its field; field errors inline.
  - 409 `rules_stale`: dialog closes; `alert` warning "Someone else saved the rules while you were editing." with a `secondary` "Reload" that refetches (the draft is discarded; caption "Your changes will be lost.").
  - Other failure: `alert` danger "We couldn't save the rules. Check your connection and try again." in the dialog; it stays open, confirm re-enabled.

## SCR-APP-042 — Rules and approvals

- **Strategy and source:** code-native (this section). Route `/settings/rules`. Roles: Owner, Admin (`settings.manage`); an Agent gets the `no-permission` page (403 on GET).
- **Contract bindings:** `GET /api/v1/settings/rules`, `PUT /api/v1/settings/rules`.
- **Layout:** settings page shell (as Assistant settings): breadcrumb not shown (depth 2); `page-title` "Rules and approvals"; lede "Set what your assistant may talk about and promise. Changes need you to confirm it's you, and they're recorded in the audit log." Then `RulesForm variant="settings"`. Single column, max width as the other settings forms; cards stack with the standard section gap.
- **States:** loading (`skeleton` of three cards), error (`error-state` "We couldn't load your rules." [Try again]), never saved (prefill alert, "Not saved yet"), saved, dirty, saving, re-auth, validation errors, conflict, permission.
- **Settings index:** the "Rules and approvals" row links here (purpose stays "What your assistant may say and promise").
- **Responsive:** at 375 px, cards full width with 16 px padding; the Add buttons stack under their inputs; the dialog becomes a bottom sheet with buttons stacked, confirm on top.
- **A11y:** each `TopicListEditor` list is a `ul` with `aria-label` equal to its label; adding or removing announces through a polite live region ("Added Wedding cakes", "Removed Wedding cakes"); after Remove, focus moves to the next row's Remove or, if none, to the input. The percent suffix is `aria-hidden` and the input's label reads "Maximum discount (percent)". Disabled locked checkboxes stay in the tab order via `aria-disabled` rather than `disabled`, so screen-reader users hear "Always on".

## SCR-APP-009 — Wizard · Rules and privacy (adds the rules block)

- **Strategy and source:** code-native (this section); the privacy part is unchanged from FEAT-058's spec.
- **Route:** `/setup/rules`, step 4. **Contract bindings:** FEAT-058's plus `GET`/`PUT /api/v1/settings/rules`.
- **Layout:** lede becomes "Set what your assistant may talk about and promise, and tell visitors how you use their details. You can change these any time in Settings." Then `h2` "Rules" and `RulesForm variant="setup"` (sections 1–3, no Approvals section); then `h2` "Privacy" and FEAT-058's forms. The rules block loads independently: its loading and error states are its own and don't hide the privacy forms.
- **Footer:** `primary` "Continue" (always enabled), caption "You'll need saved rules, a privacy notice and a purpose statement before you go live." hidden once all three are done.
- **States:** as SCR-APP-042 for the rules block; permission as FEAT-058's step.

## Gaps and escalations

- Approval SLA and approver rights on SCR-APP-042 are FEAT-055 (APR-04, D3); the page shows a caption meanwhile.
- Persona and disclosure on the setup step and the wizard frame stay with FEAT-035.
- No new design.md component, value or token; no escalation.
