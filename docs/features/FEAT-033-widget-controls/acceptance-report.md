# Acceptance Report: FEAT-033 — Widget visitor controls and EN / 中文 chrome

> Verdict: **Accepted** (E2E `widget-controls.e2e.ts`, axe and Firefox/WebKit pending Ken's local CI) · Date: 2026-10-26
> Standard: [technical-design.md](technical-design.md) §6 (AC-1..AC-9) · Sources: SRS v0.4 (CHN-13, CHN-02 (p), GOV-14, NFR-02), use-cases v0.4 (UC-20 steps 2, 8), ADR-013, ADR-014, ADR-016, ADR-025
> Repo state audited: `57b9a1e` (implementation head); no test corrections

## Verdict summary

FEAT-033 is accepted. Each of AC-1..AC-9 has tests that assert what the criterion says, and the criteria encode CHN-13's privacy link and "way to end the chat" and CHN-02's chrome language faithfully. CHN-13's "talk to a person" is partial by design (D2): the control is built behind `controls.talkToPerson`, always false until FEAT-044 adds escalation (INB-05), so its SRS acceptance ("triggers escalation") is not claimed here. The privacy link renders only once FEAT-058 stores GOV-14's notice (D1).

The feature's test diff adds cases only, with one design-mandated change: `packages/agent/test/safety.int.test.ts` no longer runs a turn for a message posted to an abuse-ended chat, because D5 now refuses that message (409); the gate's silence for a message stored before the close is asserted instead in `language-hours.int.test.ts` (AC-2). Nothing was loosened, skipped or deleted. An unused import was removed from `apps/api/test/widget.int.test.ts`.

## Audit standard

CHN-13 (M): "talk to a person" option, link to the tenant's privacy notice (GOV-14), a way to end the chat. CHN-02 (M, partial): WCAG 2.1 AA, ≤ 30 KB gz; chrome in the visitor's language (design.md §4.9, UX-Q4). UC-20 step 2 (controls visible) and step 8 (visitor ends). Design §9's trace was checked against these rows; every AC cites its source and none reinterprets it.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Observed |
|---|---|---|---|---|
| AC-1 end chat, one audit, inbox notify, cancel changes nothing | CHN-13, UC-20 8, ADR-014 | `widget-controls.int.test.ts` "closes the chat once"; `inbox.int.test.ts` endVisitorConversation; E2E end by keyboard (Keep chatting, Escape) | Yes: status `closed`, one `conversation.visitor_ended` row, notify payload with closed summary | Green (E2E pending CI) |
| AC-2 AI silent after end; 409 `chat_ended`; retry 200 | CHN-13, ADR-013, D5 | `language-hours.int.test.ts` "stores no reply when the visitor ended"; `widget-controls.int.test.ts` 409 case; `inbox.int.test.ts` D5 case | Yes: no segments, no non-visitor rows; 409 body exact; retry returns same id; count 1 | Green |
| AC-3 idempotent; 404 other visitor/tenant/malformed; 401 origin | CHN-13 | `widget-controls.int.test.ts` cases 1–2; `inbox.int.test.ts` refusal case | Yes, status stays `ai` after refusals | Green |
| AC-4 done card, new chat; abuse end keeps FEAT-025 notice | SCR-WGT-006 | E2E end-and-new-chat; `chat.test.ts` chat-ended (FEAT-025) | Yes; abuse-end path by unit + code review (`visitorEnded` vs `chatEnded`) | Unit green; E2E pending CI |
| AC-5 privacy URL in config, menu + footer, new tab, rel | CHN-13, GOV-14 | `widget.test.ts` (contracts) URL parse; `chat.test.ts` menuItems; `widget.int.test.ts` null in config; E2E privacy test (`target`, `rel`) | Yes | Unit/int green; E2E pending CI |
| AC-6 talk to a person only with flag, not ended; config false | CHN-13, D2 | `chat.test.ts` menuItems; `widget.int.test.ts` | Yes | Green |
| AC-7 strings from table, parity, locale follows reply language; `messages.language` | CHN-02, §4.9 | `api.test.ts` parity; `chat.test.ts` chromeLocale; `language-hours.int.test.ts` en/zh stored; `inbox.int.test.ts` D3 check; E2E 中文 chrome | Yes | Green (E2E pending CI) |
| AC-8 menu-button keyboard, focus, 44 px, axe light/dark | CHN-02 WCAG | E2E keyboard + `toBeFocused` + axe (dark host fixture); CSS review (`.mi`, `.btn` min-height 44px) | Yes | Pending CI |
| AC-9 size budget, loader unchanged, `--kaki-*` only | NFR-02, ADR-016 | `pnpm size`; diff review | Yes | loader 4.39 KB, panel 11.92 KB gz (limits 14 / 35); no loader change; new CSS uses only `var(--kaki-*)` |

## Corrected tests

None.

## Independent execution

All in this session at `57b9a1e`, through `scripts/test-env.sh` (no Docker):
- `pnpm format:check`, `pnpm lint` (ESLint + depcruise, 0 violations), `pnpm typecheck` (26/26), `pnpm test` (24/24): green.
- `test:coverage`: `@kaki/inbox` 14/14, `@kaki/agent` 399/399, `@kaki/db` 129/129 green; `@kaki/api` 254 passed, 1 skipped, 1 failed: `uploads.int.test.ts` "the S3 presigner" needs Docker or `KAKI_TEST_S3_ENDPOINT` (fails on `main` the same way; unrelated).
- Unit: `@kaki/widget` 23/23, `@kaki/contracts` 5/5, `@kaki/realtime` 2/2.
- `pnpm build` + `pnpm size`: within budget (AC-9).

## Direct verification

- Migration `0032_message_language.sql` applied by the integration databases; the check rejects a language outside en/zh (inbox D3 test).
- Audit entry has actor `visitor` and the visitor ID only, no message text, matching the existing visitor audit rows (ADR-014).
- Panel source: every new label, aria-label and placeholder reads `t.*`; privacy links set `target="_blank"` and `rel="noopener noreferrer"`; Escape in the menu and confirm card stops propagation.

## Findings

- Observation (not blocking): `appendVisitorMessage` reads the status without a row lock, so a message posted in the same instant as End could still be stored; the send gate keeps the AI silent on it (ADR-013), so the visitor-visible outcome holds. Worth a `for update` when FEAT-042 replaces the status writes.
- D4 open item for FEAT-042: no "Visitor ended the chat" row in the staff conversation.

## RTM

Test ref appended: CHN-13 (partial: privacy link, end chat; talk to a person with FEAT-044), CHN-02 (partial: chrome language, visitor controls a11y).

## CI

The feature touches the widget, so Ken's local CI (E2E incl. Firefox/WebKit, axe, size) is due before merge. A red result there goes back to a build fix before merge.
