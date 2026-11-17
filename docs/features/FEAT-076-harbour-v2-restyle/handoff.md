# Handoff: FEAT-076 — Harbour v2 restyle
Branch: feat/FEAT-076-harbour-v2-restyle · PR: none · Updated: 2026-11-17 by design
Stage done: design (mockup published, waiting for Ken's approval)
Next: build (one session, UI only) once Ken approves — kickoff: "Build FEAT-076 on branch feat/FEAT-076-harbour-v2-restyle. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Mockup: `mockup/harbour-v2-mockup.html` in this folder, also at https://claude.ai/artifact/WgAeQihNXNs5HmZ1DsMz4Y (private to Ken). Screens: Source (processing/ready/failed), Home, Inbox, operator Tenants, phone 375 px, v1 → v2 sheet.
- Record Ken's answers to questions 1–3 as D9–D11 in technical-design §7 before T1; question 3 decides whether T8 builds the ready-state success alert (D4).
- No endpoint, contract or schema change. The widget must not import `@kaki/ui` or change (`pnpm size`).
- Source page E2E texts must stay unique: 'Ready' (exact, now only the meta-grid Status badge), 'Facts found', 'Pages read', 'Checked for malware: none found', '1 read with OCR', 'No pages were read.', `.source-figures`, `data-testid="page-table"` (technical-design §2).
- Timeline labels and times: technical-design §5.8 (no per-stage timestamps exist, D2).
- Alerts get icons and lead styling from CSS only (D3); don't edit alert copy.
- Operator chrome colours via `color-mix` of tokens (D7); no new tokens.
- `check-rtm` treats NFR ownership "Every UI feature" as not matching (`/\bevery\b/` is case-sensitive), so NFR-09 is listed in the plan §4 row instead.

## Left to CI or later
- All E2E (including the new `harbour-v2.e2e.ts`) and axe run in the verify stage's GitHub CI (no Docker in cloud sessions).
- WCAG 1.4.11 for fill-only selection: M6 manual audit (technical-design O1).

## Pending for Ken
- Approve the mockup: (1) the v2 look on Source, Home, Inbox, operator Tenants and phone; (2) inbox selected row: keep teal tint (design.md rule) or grey fill; (3) add a success alert on a ready source ("Finished reading 38 pages. 6 of the 41 facts need your review." + Review facts)?
- /mnt/project-files wasn't mounted in this session, so this ask and the token log weren't written to `pending-actions.md` / `reviews/feat-076-token-use.md`; add them from here.
