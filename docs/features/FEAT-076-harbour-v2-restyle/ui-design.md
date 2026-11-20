# UI design: FEAT-076 — Harbour v2 restyle

> Spec: `docs/02-design/design.md` v2 (§2.2 Inter, §4.1 button, §4.3 alert, §4.4 card, chip, table, tabs, `meta-grid`, `event-timeline`, §4.5 nav-item, tab-bar-item, §4.9 OPS, §9 change list). Contracts: [technical-design.md](technical-design.md) §5.
> Visual reference: [mockup/harbour-v2-mockup.html](mockup/harbour-v2-mockup.html) (also published to Ken as a private claude.ai artifact, link in [handoff.md](handoff.md)). Screens: SCR-APP-024 Source (processing, ready, failed), Home, Inbox + Conversation, operator Tenants, two 375 px phone views, and a v1 → v2 component sheet.
> Status: designed · 2026-11-17 · **waiting for Ken's approval of the mockup** (questions 1–3, technical-design §8 E1); the build starts only after it.

## Layout and shell (every SCR-APP screen)

| Width | Change |
|---|---|
| ≥ 1024 | Sidebar 240 px on `--color-bg-canvas`, no border; padding `--space-5` `--space-4`; items 32 px with `--space-1` between. Top bar on canvas with a bottom `--color-border-default` rule (unchanged otherwise). |
| 768–1023 | Collapsed 64 px sidebar: icon-only items, the active one on `--color-bg-fill`. |
| < 768 | Tab bar 64 px: icon in a 48 × 28 `--radius-md` pill (`--color-bg-fill` when active), caption label; active label text-primary, idle text-secondary. Count pill top-right of the icon (`--radius-chip`). |

- Nav item: idle text-secondary · hover `--color-bg-subtle` + text-primary · active `--color-bg-fill` + text-primary (icon too) · focus ring `--color-focus`. Count badges `--radius-chip` with the existing tones.
- Page title: `--type-heading-*` (28/34, 500) with `--type-heading-tracking`, balanced; 20 px below (16 on phone).

## Components (all screens)

- **Tabs** (Radix tabs, Knowledge tabs, inbox views, Leads tabs, Assistant language tabs, widget-install platform tabs, Source page filters): segmented, 32 px (44 touch), `--radius-md`, 4 px apart; selected `--color-bg-fill` + text-primary; counts in a `--radius-chip` neutral pill. Horizontal scroll at 375 px, never wrap.
- **Alert**: `--radius-lg`, padding 16, 1 px `--color-border-default`, gradient `--color-<tone>-soft` → `--color-bg-surface` at 40 %, 20 px tone icon (info i, success ✓ circle, warning △, danger ⊗) in `--color-<tone>-default`. Lead (`.alert__title` or a one-sentence alert) text-primary 500; body text-secondary. A trailing action sits right at ≥ 640 and below the text under 640. Copy unchanged everywhere.
- **Status badge / chip**: 24 px, padding 0 × 8, `--radius-chip`, caption 500, soft background + `-fg` alias (neutral: `--color-bg-fill` + text-secondary). Icons and dots as today.
- **Buttons**: primary unchanged; secondary surface + 1 px border-default, hover subtle, active fill; ghost text-primary, hover subtle, active fill; danger-ghost unchanged.
- **Cards**: small cards `--radius-lg` 16; section cards (`.card--section`: a page section holding a table or a form group) `--radius-2xl` 24, padding 24 (16 below 640).
- **Tables**: header row without fill, caption 500 text-secondary, one border-default rule under it; rows unchanged (48 px, hover subtle, selected accent-soft).

## SCR-APP-024 — Source (extended: `meta-grid`, `event-timeline`)

Order top to bottom: back link "Sources" · `h1` title · website URL sub-line (websites) · `meta-grid` · Progress section card · zero-facts info alert (unchanged) · Pages section card · footer (Delete, unchanged).

### Meta-grid (labels are overlines; values body)

| Label | Value | Shown for |
|---|---|---|
| Status | `SourceState` badge (Queued, Processing with spinner, Ready, Failed, Map columns) | all |
| Type | "Website · up to {pageLimit} pages" · "{file type} · {size}" · chat type label · spreadsheet type + size | all |
| Added | `updatedLabel(createdAt)` | all |
| Finished | `updatedLabel(finishedAt)`, "Not yet" while queued or processing | all |
| Ownership | "Confirmed by you on {date}" (existing text) | websites with `attestedAt` |
| Safety | "Checked for malware: none found" (exact existing text, check icon in success colour) | files with `scannedAt` |

### Progress section (`h2` "Progress", `card--section`, keeps class `source-status` and `aria-label`-free heading)

1. Failed: the danger alert first (existing copy and Retry / Upload again), `role="alert"`.
2. `event-timeline` labelled "Steps", steps per technical-design §5.8.

| Kind | Steps (badge text) |
|---|---|
| Website | Added · Read pages · Find facts · Save facts · Finished |
| File | Added · Malware check · Read file · Find facts · Save facts · Finished |
| Chat export | Added · Malware check · Remove personal data · Find questions · Save facts · Finished |
| Spreadsheet | Added · Malware check · Read file · Map columns · Import rows · Save facts · Finished |

| Step state | Node | Badge | Caption |
|---|---|---|---|
| done | surface, step icon text-secondary | neutral + ✓ | "Done" (Added: its time) |
| current | info border, spinner | info | "In progress · 18 of 38", "Waiting to retry", "Waiting for you" (map) |
| waiting | surface, step icon | neutral | "Waiting" |
| success (last) | success check-circle | success "Finished" | finished time |
| failed (stage) | danger x-circle | danger | "Stopped here" |
| failed (last) | danger x-circle | danger "Failed" | finished time |

3. While busy: the stage line and progress bar (unchanged). When ready: `dl.source-figures` (Facts found, Need review, Pages/rows read, OCR note; unchanged copy, values in `--type-display-*` with tracking).

### Pages section (`h2` "Pages", `card--section`)
Filter tabs segmented with counts; table header without fill; result badges 24 px; the reason text in caption beside the badge (unchanged copy); `data-testid="page-table"` kept.

### States

| State | What shows |
|---|---|
| loading | skeleton: title bar, a 4-cell meta-grid skeleton, the well with 4 grey nodes; `aria-busy` (existing label "Loading source") |
| processing / queued | Status Processing/Queued; timeline current step; stage line + progress bar |
| waiting to map (spreadsheet) | Status "Map columns" (info); Map columns step current "Waiting for you"; the existing mapping card below (FEAT-016) |
| waiting to retry | current step "Waiting to retry" |
| ready | all steps done, Finished success with time; figures; zero-facts info alert when no facts |
| failed | danger alert + Retry or Upload again; failing stage "Stopped here", Failed last; "No pages were read." when none |
| error / not found / no permission | unchanged (FEAT-012) |
| delete confirm, toast | unchanged |

Phone (< 640): meta-grid two columns; timeline stacked (node left, badge and caption right, vertical connector); well padding 20; section padding 16.

Accessibility: one `h1`; `h2` per section; `<ol aria-label="Steps">` with `aria-current="step"`; polite live text "Step N of M: {label}, in progress" only on change; decorative icons `aria-hidden`; spinner static under reduced motion.

## Home, Inbox, other dashboard screens

No layout or copy change. They pick up the shell, tabs, alerts, badges, buttons, section cards, table headers and title tracking above. Inbox: view tabs segmented (D5); selected row keeps `--color-accent-soft` (D6, question 2). Home KPI tiles in the mockup show the v2 look for FEAT-065; today's Home (setup card as a section card + empty state) is what changes now.

## SCR-OPS (operator console shell)

Dark sidebar kept (design.md §4.9). Items 32 px, `--radius-md`, 18 px icon + label; idle muted, current item lighter fill + surface text (token `color-mix`, technical-design D7). "Operator console" label: `--radius-chip` pill on `--color-bg-fill`, text-secondary. `h1.page-title`. The tenant table drawn in the mockup is FEAT-070's and only shows the target look.

## Tokens used
`--color-bg-{canvas,surface,subtle,fill}`, `--color-border-{default,strong}`, `--color-text-{primary,secondary,on-accent,link}`, `--color-accent-{default,hover,active,soft}`, `--color-{success,warning,danger,info,pending}-{default,soft}`, `--color-focus`, `--space-1..9`, `--radius-{sm,chip,md,lg,xl,2xl,full}`, `--type-{caption,body-sm,body,title-sm,title,heading,display}-*` incl. `--type-heading-tracking`, `--type-display-tracking`, `--size-control-{sm,md,lg}`, `--size-sidebar`, `--size-bottom-nav`, `--font-family-sans`. No new tokens.

## Gaps and escalations
- Questions for Ken at mockup review: (1) approve the v2 look; (2) inbox selected row teal tint (design.md rule) or grey fill; (3) success outcome alert on a ready source.
- Per-stage timestamps aren't available (technical-design D2).
- WCAG 1.4.11 for fill-only selection goes to the M6 manual audit (technical-design O1).
