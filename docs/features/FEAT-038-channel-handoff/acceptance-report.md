# Acceptance report: FEAT-038 — Continue on another channel with the history

> Verifies: [technical-design.md](technical-design.md) §6 (AC-1..AC-12) · Implements: CHN-07, AGT-06 (p: `handoff_channel`) · UC-26 · Verified 2026-11-11, fresh session, branch `feat/FEAT-038-channel-handoff` from `9617d6d`; fixes `e0aed05`, `4ea42f4`

## Verdict summary

**Accepted** after one defect fixed in this stage (Findings). All twelve criteria hold against the SRS and UC-26; the feature's unit and integration suites and the full local checks pass in this run; GitHub CI (E2E on three browsers, including the new `handoff.e2e.ts`) is recorded under CI. CHN-07 is complete; AGT-06 gains `handoff_channel` (still partial overall). Three copy differences on the hosted confirm page are recorded as non-blocking findings.

## Audit standard

Re-derived from SRS CHN-07 ("from the widget, the visitor can continue on Telegram or email (deep link or form); the conversation history and context follow"; acceptance: "the new channel's thread is linked to the same Contact and conversation"), AGT-06 (the `handoff_channel` tool), AGT-12's carried-over history clause, and UC-26 (main flow, 1a email, 3a group, 4a expired link). Every requirement in the `> Implements:` line has a criterion. D2 (the same conversation moves channel) is the literal reading of CHN-07's acceptance test. AC-8's "reopening the widget" is read as reopening the panel on the page: the widget has never resumed a conversation across page reloads (no stored conversation ID since FEAT-001), so no criterion can require it here; recorded, not a defect.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | CHN-07, UC-26 precondition | api `handoff.int` (config flags follow live state and bot username; 409 `channel_unavailable`); widget `chat.test` (`menuItems`, `handoffOptions`); E2E Telegram (menu names only the live channel) | Yes: offline and bot-less channels are off in config, refused by the route and absent from menu and card | Pass |
| AC-2 | UC-26 steps 1–2 | channels `token.test` (round-trip, wrong tenant/prefix/length/MAC → null, ≤ 64 chars, never `link-…`); api `handoff.int` (deep link `t.me/<bot>?start=c-…`, 30 min expiry, audit without PII) | Yes | Pass |
| AC-3 | CHN-07 acceptance; UC-26 step 4; AGT-12 | api `handoff.int` (verified `link` identity on the conversation's contact, chat linked, same conversation ID now `telegram`, recap delivery row, merge keeps the older contact, follow-up appends); agent `handoff.int`; E2E Telegram (recap `sendMessage`, follow-up joins the same conversation) | Yes: same conversation ID asserted, history intact | Pass |
| AC-4 | UC-26 4a | api `handoff.int` (expired, used, forged, other-tenant, closed → expired reply + greeting, no contact or conversation change, next message is a new conversation) | Yes | Pass |
| AC-5 | UC-26 3a; CHN-05 | api `handoff.int` (group `/start c-…` → private-only reply, leave, link still redeems privately) | Yes | Pass |
| AC-6 | UC-26 1a | channels `handoff.int` (three rate limits, outbox row carries `linkId` only); api `handoff.int` (masked address, 422, 429; worker sends one mail from the reply address, skips a used link); E2E email (Mailpit message) | Yes | Pass |
| AC-7 | UC-26 1a | channels `handoff.int` (`confirmEmailHandoff`: verified identity, display email, conversation `email`, thread row, recap; second and expired → no change); api `handoff.int` (GET doesn't consume, foreign `Origin` 403, done, expired, CSP); E2E email (confirm page GET/POST, expired on reuse, recap email) | Yes | Pass |
| AC-8 | SCR-WGT-002/-004 | api `handoff.int` (messages POST after a move → 409 `moved`); widget `chat.test`/`api.test` (`movedView`, `MovedError`); E2E both paths (moved bar over SSE without reload, "Start a new chat here" → new conversation) | Yes, in-session (see Audit standard) | Pass |
| AC-9 | AGT-06 p; ADR-025 | agent `dispatch.test` (live-only card, `handoff_none`, coaching refused `scope`, replay excludes it, writes nothing); agent `handoff.int` (card stored, no reply model); `pnpm eval --fast` multi-task with 6 new cases | Yes | Pass |
| AC-10 | ADR-005, ADR-015 | db `rls.int` (B can't read A's links, `link` needs `verified_at`, purge deletes only rows 7 days past expiry, app roles can't execute); channels `handoff.int` (purge from the outbox zone only); api `handoff.int` (A's token fails on B's bot and confirm page); FK `on delete cascade` from contacts | Yes | Pass |
| AC-11 | SCR-APP-015 | dashboard `inbox.test` (`eventText` "Moved to Telegram · 2:31 pm", `recapView`); inbox `move.int` (`threadEvents` returns `moved`); E2E both paths (divider and recap in the thread) | Yes | Pass |
| AC-12 | SCR-WGT-004; design.md §4.9 | widget `chat.test` (strings `en`/`zh-Hans`, error texts); E2E axe on the widget at 1280 and 375×5000, the confirm page and the thread | Yes | Pass (CI) |

## Changed existing tests (reviewed, not weakened)

- `agent/dispatch.test.ts`: the "unhandled task" case used `handoff_channel` as its example of a kind with no handler; now that it has one, the case uses `correct` (coaching-only in visitor scope) and keeps the PII assertion. The registry list gains `handoff_channel`.
- `widget/api.test.ts`: import list widened for `MovedError`; no assertion removed.
- `coach.test`, `lead.test`, `plan.test`: test doubles gain `handoffOptions`; no assertion changed.

## Corrected tests

- api `handoff.int` "confirm page … CSP": now also asserts `referrer-policy: same-origin`, the header that made a browser's POST fail (AC-7).
- approvals `approvals.int` (FEAT-055): decisions and timers on the drafts' fixed clock (Findings).

## Independent execution

Fresh clone, this session, through `scripts/test-env.sh scripts/check-summary.sh`:

- PASS `pnpm format:check`, `pnpm lint` (incl. dependency-cruiser and `check-rtm`), `pnpm typecheck`, `pnpm test` (159 files, 1840 tests).
- PASS integration: `channels` 62, `agent` 136, `inbox` 97, `db` 235. `api` 453 passed, 1 file failed: `uploads.int` "the S3 presigner" needs LocalStack through Testcontainers (no Docker in cloud sessions; unrelated to this feature, runs in CI). `handoff.int` passed within it.
- PASS `pnpm eval --fast`; widget build and `pnpm size`: loader 4.47 KB gz (≤ 14), panel inside its 35 KB budget.

## Direct verification

- Invariants read in the diff: tenant ID comes from the widget token, the bot's hook route, or `handoff_link_tenant()` followed by the tenant-bound MAC check, never a body. `handoff_links` has forced RLS, its policy and RLS cases. The visitor zone still can't update `conversations.channel` directly; only the definer `conversation_move_channel()` (widget → telegram/email, compare-and-set on `version`). Side effects go through the outbox (`handoff-email` carries `linkId` only) and the existing delivery trigger. The recap copies sent messages (no model text, ADR-008). Verified identity only from a proven link (CHN-08). Module boundaries pass dependency-cruiser.
- Confirm page: GET never consumes; POST requires same origin; CSP `default-src 'none'`, `form-action 'self'`, `no-store`, `no-referrer`; all interpolations escaped.

## Findings

Fixed in this stage (feature-stage verify step 3: fix anything red on the branch):

- **AC-7 failed in a real browser (CI run 125, `handoff.e2e` email test on Chromium and Firefox).** The confirm page sent `Referrer-Policy: no-referrer`; under it a browser's form POST carries `Origin: null` (reproduced locally with Chromium), so the POST's same-origin check refused every confirm with 403. The integration test set `Origin` by hand and missed it. Fix `e0aed05`: the page's policy is `same-origin` (still no referrer to other sites), and `handoff.int` now asserts it.
- **Not this feature's: FEAT-055's `approvals.int` date bomb.** Its drafts are dated 2026-11-04 10:00 SGT and expire 2026-11-11 10:00, while `decide()` and the timers used the wall clock, so five cases fail from that hour on (run 125). Fix `4ea42f4`: those calls take a fixed `now` on the drafts' clock; no assertion changed.

Non-blocking (copy on the hosted confirm page differs from ui-design SCR-WGT-004's page spec; the criteria don't fix copy, and the confirmation email already carries "If you didn't ask for this, ignore this email"):

1. The confirm page lacks the caption "If you didn't ask for this, you can close this page." and its heading/button read "Continue by email" rather than "Continue your chat with {business}" / "Continue".
2. The done page omits "Reply to that email to carry on."
3. The expired page doesn't name the business when the code is known.

Also: the page styles use the app tokens (`--color-*`, as the hosted privacy notice does) rather than the spec's `--kaki-*` mapping; consistent with design.md for pages outside the widget. Items 1–3 are listed in pending actions as a small follow-up.

## RTM

CHN-07 Test ref `features/FEAT-038-channel-handoff/acceptance-report.md`; AGT-06 `… (partial: \`handoff_channel\`)`.

`node scripts/check-rtm.mjs FEAT-038 --stage verify`: RTM check passed (FEAT-038).

## CI

CI_LINE
