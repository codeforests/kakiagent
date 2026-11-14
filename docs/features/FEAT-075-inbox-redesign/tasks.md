# Tasks: FEAT-075 — Inbox redesign

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: `designed` · 2026-11-14
> One build session (UI only: no contract, schema or package change). Visual reference: the approved prototype canvas named in ui-design.md.

- [ ] T1 — `lib/inbox.ts`: `inView(summary, filter, meId)` mirroring `viewFilter` in `packages/inbox/src/views.ts` plus the channel and assignee rules; `VIEW_SHORT_LABEL`; visitor author label helper (contact name, else `PARTY_LABEL[channel]`) (design §5.1, §5.3; D2, D5; AC-3, AC-8)
      Done when: `pnpm --filter @kaki/dashboard test` passes with new `inbox.test.ts` cases: each view × each status (incl. `waiting_approval`, flagged + closed), channel match/mismatch, assignee `me`/`none`/user against owner and escalation assignee, unknown summary → false; author label per channel and with a contact name.
- [ ] T2 — Layout: full-height `.inbox` flex row under the top bar and banners, independent pane scroll, list 400/360 px, thread header and dock `flex: none`, log scrolls; empty state with the escalated card (`counts.escalated`, Show escalated), no details pane when nothing is selected (design §5.2; ui-design Layout, Empty state; D6; AC-1, AC-2)
      Done when: typecheck passes; a stubbed-API Playwright script at 1440 × 900 with a banner logs `document.scrollingElement.scrollHeight <= innerHeight` and the dock's bottom ≤ innerHeight; at `/inbox` logs no `aside[aria-label="Conversation details"]`.
- [ ] T3 — List header: "Connected" badge copy; search field padding fix and new placeholder; Filters button + panel (existing selects moved in, testid kept) + active filter chips + Clear all (design §5.3; ui-design Header, Filters panel; D4; AC-5, AC-7, AC-9)
      Done when: typecheck passes; script at 375 and 1440 px logs the input's padding-left ≥ icon right edge + 8 px; opening Filters, choosing Email adds chip "Channel: Email", removing it restores `/inbox`.
- [ ] T4 — Views: short labels with `title`, count pill colours, no overflow at ≥ 1024; below 640 the More menu (Radix `DropdownMenu`) with Flagged and Closed and Flagged's count on the trigger (design §5.3; ui-design Views; D5; AC-4)
      Done when: script at 1024, 1280, 1440 logs `nav.scrollWidth <= nav.clientWidth`; at 375 the More menu opens and links to `?view=flagged` / `?view=closed`.
- [ ] T5 — Rows: new four-line layout in `inbox-row.tsx` and CSS; `StateChip` `urgent` prop → merged "Escalated · Urgent" chip; search results keep using `Row` with the excerpt as line 3; remove `UrgentChip` if it has no other caller (design §5.3; ui-design Row; AC-6)
      Done when: typecheck passes; `pnpm --filter @kaki/dashboard test` passes; script logs one chip with text "Escalated · Urgent" on an urgent row and the preview's width equals the content column width.
- [ ] T6 — Selection rule: `to(f)` in `InboxList` keeps `/:id` only when `inView(cachedSummary, f, meId)`; filter selects, chips, Clear all and Show escalated go through it; live events don't deselect (design §5.1; D2; AC-3)
      Done when: script: open an AI-handling conversation in Open, click Escalated → URL `/inbox?view=escalated` and the empty state shows; open an escalated one in Open, click Escalated → URL keeps the id; set Channel to a different channel → empty state.
- [ ] T7 — Conversation header (one row ≥ 640, two-line phone header with 44 px Back/details/More, Close in More below 640), thread restyle (day dividers, bubble radii and widths, fact chips, Visitor saw box, event pills), visitor author label from T1, dock row/stacked layout (ui-design SCR-APP-015 Header, Thread, Dock; AC-8, AC-10)
      Done when: typecheck passes; script on an email conversation logs the visitor label "Email customer" (or the contact name); at 375 the header text block is ≤ 2 lines (height ≤ 48 px) and every header button is ≥ 44 × 44.
- [ ] T8 — Details panel: Contact · Channel/Lead two-column · Intent (web context first, then tags) · Approval · Facts used, collapsible as before; drawer and sheet keep focus handling (ui-design Details panel; AC-11)
      Done when: typecheck passes; existing sidebar testids unchanged (`grep -n data-testid` diff shows none removed).

## E2E and verify

- [ ] T9 — E2E: update the copy and control changes only — `live-state` "Live" → "Connected" in `inbox.e2e.ts` (l. 74, 224, 237) and `skeleton.e2e.ts` (l. 22, 53); `takeover.e2e.ts` l. 104 opens Filters before `selectOption`. Add to `inbox.e2e.ts`: no details pane at `/inbox`; view switch clears a selection not in the new view and keeps one that is; filter chip add/remove; no page scroll at 1440 × 900 with the dock visible; axe at 1440 × 900 and 375 × 812 on `/inbox` and `/inbox/:id` (AC-1–AC-6, AC-9, AC-12)
      Done when: `pnpm test:e2e --project=chromium e2e/tests/inbox.e2e.ts e2e/tests/takeover.e2e.ts e2e/tests/skeleton.e2e.ts` passes where a stack is available.
      Note: without Docker, E2E runs in the verify stage's GitHub CI run (STATE.md, Environment). Every other inbox-related spec (escalation, suggested-reply, inbox-search, lead-capture, approvals, consent-withdrawal, email-channel, telegram-channel, handoff, web-context) must pass unchanged (AC-11).
- [ ] T10 — Verify: full `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @kaki/dashboard test:coverage`, `node scripts/check-rtm.mjs FEAT-075`; status `developer-done`; draft PR.

## Verification evidence
