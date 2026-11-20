# Handoff: FEAT-076 — Harbour v2 restyle
Branch: feat/FEAT-076-harbour-v2-restyle · PR: (draft, see below) · Updated: 2026-11-20 by build
Stage done: build (T1–T9 of 9)
Next: verify — kickoff: "Verify FEAT-076 on branch feat/FEAT-076-harbour-v2-restyle. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage verify."

## What the next stage needs
- Ken approved the mockup 2026-11-20 (D9); inbox selected row stays teal-tinted (D10); ready sources get the success alert (D11).
- Deviations from the design, each noted in tasks.md: section cards are any `section.card` (D12, no markup sweep); alert actions stay under the text (absolute `::before` icon, no reflow); the Source page filter stays a `<select>`; the timeline shows on website and file sources only, since spreadsheets and chats render SCR-APP-025/026; files label the date "Uploaded".
- Inbox view tabs use 2 px padding so FEAT-075's fit check holds (21 px slack at 1440, 8 px at 1024 with stubbed counts). Watch `inbox.e2e.ts` "views fit" on Firefox/WebKit.
- `fonts.css` is a declared `@kaki/ui` entry point in `.dependency-cruiser.cjs`.
- New tests: `apps/dashboard/src/lib/sources.test.ts`, `timeline.test.ts`, `e2e/tests/harbour-v2.e2e.ts` (stubs three Source details by route; operator at http://localhost:5174).

## Left to CI or later
- All E2E and axe (AC-9, AC-10): not run here (no Docker). The stubbed-API scripts used per task covered the styles.
- WCAG 1.4.11 for fill-only selection: M6 manual audit (technical-design O1).

## Pending for Ken
- Nothing blocks verify. /mnt/project-files wasn't mounted again, so the token log and pending-actions entries weren't written.
