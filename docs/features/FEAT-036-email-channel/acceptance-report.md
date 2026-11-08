# Acceptance report: FEAT-036 — Email channel (verified)

> Feature: FEAT-036 · Implements: CHN-04, CHN-10, CHN-12 (partial), NFR-17 (partial), NFR-18 (partial), CHN-01 (partial) · Realizes: UC-27 1–3, 2a, 3a, 3b, 3c; UC-25 (partial) · Screens: SCR-APP-038 (new), SCR-APP-036 (Connect entry), SCR-APP-014 (email in the inbox) · Verifier: independent verify session, 2026-11-08 · Branch: `feat/FEAT-036-email-channel` · PR #61

## Verdict summary

**Accepted** (2026-11-08), subject to the CI run recorded under CI. Every criterion AC-1..AC-11 has a test that asserts what it says; one part of AC-7 (the 11 MB file) had no test and now has one (Corrected tests). Full local checks are green apart from failures outside this feature: the time-of-day tests `language-hours.int` "closed today" and `escalation.int` (run at 23:00 SGT on a Sunday before the Deepavali holiday) and the container-only `uploads.int` and `rate-limit.int` (Testcontainers; CI runs them). E2E and screen renders ran only in GitHub CI.

## Audit standard

Re-derived from SRS v0.4: CHN-04 (email channel: forwarding address, threads correctly in Gmail and Outlook, attachments under KB-11, no sending from an unverified custom domain), CHN-10 (no AI reply to auto-replies, bounces, lists, bulk; per-thread AI cap, loop stops at the cap), CHN-12 (channel health and failed-send retry, partial), NFR-17 (no message lost: retried 24 h then shown failed, partial), NFR-18 (aligned sending, bounces, partial), CHN-01 (adapter contract, partial); UC-27 main flow and 2a/3a/3b/3c, UC-25 connect. The design's §6 criteria cover each FR clause (design §9 traceability checked); no misencoding found.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | CHN-04, UC-25 | api `email-channel.int` setup (Agent 403, offline+hidden with forwarding address, 409 again, tenant B sees none, unique address); channels `email-settings.int` | Yes | Pass |
| AC-2 | CHN-04, UC-27 1–3, NFR-18 | agent-worker `email-receive.int` first mail (conversation, contact, turn); `email-deliver.int` (From = forwarding address, `In-Reply-To`, `References`, `Re:`, `Auto-Submitted` on AI only, once); `email-channel.e2e` (Mailpit headers) | Yes | Pass (E2E: CI) |
| AC-3 | CHN-04 threading | `email-receive.int` Gmail/Outlook full and trimmed References, same-subject new; 7-day reopen vs 8-day new; `email.test` threadKey | Yes | Pass |
| AC-4 | CHN-10, UC-27 2a | `email.test` ignore table + echo + SES spam/virus verdicts; `email-receive.int` each ignored kind writes only an ignored event by reason, loop at 21; api ignored counts by reason; E2E OOO fixture | Yes | Pass |
| AC-5 | CHN-10 cap, UC-27 3b | agent `turn.int` cap (stops at cap, `reply_cap` once, silent after; 24 h window; widget unaffected); api reply cap 3 saved, 0 → 422, stale 409; contracts 51 rejected; rls cap 1–50 check | Yes | Pass |
| AC-6 | CHN-04 unverified domain, NFR-18, CHN-12 | api domain (six pending, forwarding still used, check verifies, 429, remove, tenant B, free-mail/platform 422); channels `email-domain.int` (pending → verified, lost record → failing + degraded once, recovery, revoked); `email-deliver.int` D4 sender; `identity.test`; E2E fixture domain | Yes | Pass |
| AC-7 | CHN-04 attachments, KB-11 | kb `attachment-scan.int` (PDF+PNG clean and stored; EICAR, renamed exe, encrypted PDF rejected, never stored; malware in image; scanner outage); `email-receive.int` quarantine + scan job, disguised exe rejected, **11 MB `too_large` (added)**; api download 5-min redirect, rejected 404 | Yes, after correction | Pass |
| AC-8 | NFR-17, UC-27 3c, CHN-12 | `email-deliver.int` backoff; 535 degrades at once; permanent → failed + escalation; 24 h timeout once with one escalation and Retry sends; bounce → bounced + escalation once; `email-receive.int` SES redelivery is `duplicate`; rls `channel_deliveries_due()`; api retry 202/409/404; dashboard `inbox.test` delivery text | Yes | Pass |
| AC-9 | D2, INB-02, CHN-01 | rls trigger (staff, agent and system rows get one delivery and job; widget and visitor rows none); `email-deliver.int` staff reply sent, `staff_joined` not sent but marked delivered; channels `shape.test` | Yes | Pass |
| AC-10 | ADR-005, ADR-015 | `email-receive.int` NRIC masked in `messages` (the model payload is built from the stored row) and no address/subject in the new rows, outbox or audit; rls cross-tenant cases for every new table | Yes | Pass |
| AC-11 | SCR-APP-038, SCR-APP-014 | dashboard `email-channel.test`, `inbox.test`; `email-channel.e2e` (page states, axe at 375 tall and 1280, Email filter, subject, delivery, attachments) | Yes | CI |

## Changed existing tests (reviewed, not weakened)

- `adapter-contract.test`, `channels.int`, `connections.int`: `connectable` now lists email (it has a connect flow); the empty-registry cases moved to a still-unregistered kind (`telegram`).
- `inbox-contract.test`: `channel: 'email'` became valid, so the invalid example is `telegram`.
- `rls.int` offline-mode check: email may now be `hidden` (D3); the rejected kind is `telegram`. `outbox.int` adds the `channel-send` queue URL. No skips, `.only` or deleted cases in the diff.

## Corrected tests

- `e2e/tests/email-channel.e2e.ts` (commit `67efa32`): the go-live step waited for `role=dialog`; `ConfirmDialog` renders `role=alertdialog`, so it timed out on every browser. It now names the dialog "Go live on Email?".
- `apps/agent-worker/test/email-receive.int.test.ts` (commit `f31548e`, "FEAT-036 acceptance: correct test for AC-7…"): AC-7 names an 11 MB file; no test sent one. The new case sends an 11 MB PDF and checks it is `rejected`/`too_large`, not in quarantine, with no scan job.

## Independent execution

Run fresh at `853f072` plus the correction, through `scripts/test-env.sh scripts/check-summary.sh`, 2026-11-08 ~23:10 SGT:

- PASS `pnpm format:check`, `pnpm lint` (incl. RTM), `pnpm typecheck`, `pnpm test` (1746), `@kaki/channels test:coverage` (105), `@kaki/inbox test:coverage` (124), `@kaki/db test:integration` (220), `@kaki/kb test:integration` (158), `@kaki/agent-worker test:integration` (18, incl. the new case), `@kaki/contracts test` (83), `@kaki/dashboard test` (256).
- `@kaki/agent test:coverage`: 532/533; `language-hours.int` "closed today" fails by time of day (F1).
- `@kaki/api test:integration`: 413 passed, 2 failed in `escalation.int` (after hours: "urgent" false and an after-hours notice, F1); `uploads.int` needs LocalStack (CI).
- `@kaki/platform test:integration`: `rate-limit.int` needs a container runtime (CI).

## Direct verification

- Tenant comes from `email_route()` (visitor zone, the SES recipient's local part) or the session, never the body (ADR-005); the topic ARN is checked before anything is written.
- Deliveries are created by the `messages_channel_delivery` trigger in the writer's transaction, the only `widget` test is that trigger (D2, ADR-011, ADR-012).
- Raw mail is deleted after commit; `inbound_events`, `message_deliveries` and audit carry IDs and codes only (ADR-015).
- The gate checks the reply cap before every email turn; offline+hidden stores nothing (ADR-013, D3).
- Terraform: `terraform test` cases cover the mail module's inbound wiring on mocked providers; not applied (MD).

## Findings

- **F1 (outside FEAT-036, FEAT-009 tests):** two tests fail only on a Singapore public holiday (8 and 9 Nov 2026 are Deepavali): `business-profile.e2e` "sets a closure for today" (a closure on a public holiday is dropped as redundant, `tenancy/src/profile.ts:116`, so no save toast) and agent `language-hours.int` "a closure today" (`closedBy()` reports it as `public_holiday`, `tenancy/src/hours.ts:89`). Locally, `escalation.int` "in hours" also failed by time of day (run at 23:00 SGT); it passed in CI. The specs need a non-holiday date; added to pending actions.
- **F2 (minor, follow-up):** the email footer (design §5.3, GOV-14) shows the privacy link only for a tenant with a link-mode notice; a tenant using the hosted template gets the business name only, because the visitor zone can't read the widget key the template URL needs. GOV-14 itself is about the widget and is met there; added to pending actions for Ken.

## RTM

Test ref appended 2026-11-08: CHN-04 (partial: live Gmail/Outlook threading at MD), CHN-10, CHN-12 (partial), NFR-17 (partial), NFR-18 (partial: DKIM/SPF/DMARC live at MD), CHN-01 (partial). `node scripts/check-rtm.mjs FEAT-036 --stage verify`: `RTM check passed (FEAT-036).`

## CI

- Run 117 at `f31548e`: `email-channel.e2e` timed out on all three browsers waiting for `role=dialog` (the confirm is an `alertdialog`); corrected in `67efa32` (Corrected tests). Also red: F1's two holiday-only tests.
- Run 118 (https://github.com/codeforests/kakiagent/actions/runs/42509704569) at `67efa32`: `email-channel.e2e` passes on Chromium, Firefox and WebKit; every other job green except F1's `business-profile.e2e` (all browsers) and agent `language-hours.int`. Failed jobs re-run after the Deepavali holidays: RERUN_LINE
