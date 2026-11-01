# Acceptance report: FEAT-052 — Owner alerts by email, quiet hours, digest, notification preferences

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-11-01 by an independent verify session · Branch `feat/FEAT-052-owner-alerts` · PR #46

## Verdict summary

**Accepted.** LED-04 is met for email (Telegram with FEAT-037, web push with FEAT-048) and DSH-09 for the email channel; NFR-18 is written in Terraform and tested, live at MD (pending environment). UC-22 step 4 and UC-23 step 2 have their alert pipeline; no producer exists yet (FEAT-044, FEAT-050, FEAT-055 call `notify`). Every criterion has a test that asserts what it says; no test was weakened, skipped or deleted. Every local result below was produced in this session; E2E (`notifications.e2e.ts`, with axe at 1280 and 375 px) and `terraform test` ran in GitHub CI (CI).

## Audit standard

Re-derived from SRS v0.4 LED-04 ("alert arrives within 1 minute"; "quiet hours are respected, except for urgent items (§1.4)"; "alerts held during quiet hours are sent as one digest when quiet hours end"; default quiet hours 22:00–08:00 SGT), DSH-09 ("each user chooses which events they are notified about, on which channels … and their quiet hours"; "preferences take effect on the next alert"), NFR-18 (SPF, DKIM, DMARC; bounce rate alerted above 5%), NFR-17 (nothing lost: retries), UC-22 4, UC-23 2, ADR-005, ADR-012, ADR-015, and technical-design §6 AC-1..AC-11, D1–D15. Every clause maps to an AC (§9 holds). D3 (preferences applied at send time) is what makes "takes effect on the next alert" true even for an alert already waiting. "Within 1 minute" is met by design: `notify` writes the row in the producer's transaction and the scheduler sweeps every `NOTIFY_SWEEP_MS` = 5 s (default and `.env.example`), sending due rows in the same tick.

## Audit table

| AC | Source | Tests | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | LED-04 1 min; UC-22 4, UC-23 2 | platform `notifications.int` "AC-1: sends outside quiet hours…" (one email to the member, subject `[business] event`, link to `/inbox/<id>`, no resend); `templates.test` "carries nothing but the event, business, time and links (D12)" (3 text lines only); E2E test alert reaches Mailpit | Yes; the minute bound is the 5 s sweep plus same-tick send, and the E2E waits on Mailpit through the real sweep | Pass (CI E2E) |
| AC-2 | LED-04 quiet hours | `notifications.int` "AC-2, AC-3" (`held: 1`, only the urgent one emailed); `quiet.test` (window crossing midnight, start inside, end outside) | Yes | Pass |
| AC-3 | LED-04 urgent; §1.4 | same test: urgent approval at 23:00 sent at once, subject `^Urgent: ` | Yes | Pass |
| AC-4 | LED-04 digest | three AC-4 cases: one digest at 08:00 (not 07:59), cancelled excluded, no second digest; quiet hours off releases the digest next tick; all cancelled → no email; `templates.test` digest oldest first | Yes, "exactly one" is asserted (`sent` length 1, `digests` 0 on the next tick) | Pass |
| AC-5 | DSH-09 events, next alert | `notifications.int` AC-5 (muted → `skipped`/`muted`, others unaffected); prefs merge case; api "defaults…", "PUT persists…", "approval alerts only for members who can approve (D9)"; dashboard `notifications.test` | Yes | Pass |
| AC-6 | DSH-09 quiet hours | api "422 for the same start and end…"; contracts "may cross midnight, same start and end refused"; db check `notification_prefs_quiet_ck`; E2E sets 12:00–14:00, refuses same time, turns off | Yes | Pass |
| AC-7 | UC-23 2; producers | "a retried producer with the same key alerts once"; "cancel stops pending and held alerts…"; "an alert for a member who was deactivated is not sent" (`inactive`) | Yes; "left" is the same path, since removal deactivates the membership (memberships are never deleted) | Pass |
| AC-8 | NFR-17 | "retried with backoff…" (attempt 1, next at +10 s, sent on recovery, once); "still failing 24 hours… failed and logged" (log keys carry no PII); "two senders in parallel email each alert once" (13 of 13) | Yes | Pass |
| AC-9 | ADR-005, AUTH-04 | db `rls.int` FEAT-052 block (4 cases: cross-tenant, column grants, identity scan, checks); api isolation (2 cases, incl. per-business prefs); platform "tenant B's dashboard context can't notify into or cancel tenant A"; both tables in `TENANT_SCOPED_TABLES` | Yes; routes read tenant and user only from `sessionFrom` | Pass |
| AC-10 | NFR-18 | `envs/prod/tests/profiles.tftest.hcl` run "mail": DKIM RSA 2048, MAIL FROM `mail.<domain>`, exact DMARC record, alarm `Reputation.BounceRate` > 0.05 | Yes | Pass (CI terraform); live at MD |
| AC-11 | SCR-APP-056; NFR-09, NFR-19 | E2E: page states, switch saves and keeps focus, quiet-hours validation focuses "To", test alert in Mailpit, 429 text; axe at 1280 and 375 px; `scrollWidth ≤ 375`; rollback in `notifications.test` "turns one event off and undoes only that change" | Yes; the rollback on a failed PUT is asserted at the hook's pure helpers, not in E2E (no failure injection in E2E) | Pass (CI E2E) |

## Corrected tests

None.

## Independent execution

`scripts/test-env.sh` (Postgres 16 + pgvector, no Docker), 2026-11-01, at `e49bb31`: `pnpm format:check`, `pnpm lint` (ESLint + dependency-cruiser), `pnpm typecheck`, `pnpm test` all green. `test:coverage` green with thresholds for db (178 tests), contracts, scheduler-worker, dashboard; platform (295) and api (309) green with thresholds when the two Docker-only suites are excluded (`rate-limit.int` needs Valkey, `uploads.int` needs S3 with Object Lock; neither touched by this feature; both run in CI). Feature suites verbose: platform notifications 29/29, api notifications 7/7, db RLS FEAT-052 4/4. Test diff: only additions to `rls.int.test.ts`; no `skip`, `only` or removed assertions anywhere in the diff.

## Direct verification

- No PII: `notifications` holds IDs, codes and status only; templates carry event, business, time and links (D12, ADR-015); the failure log is `kind`, `notificationId`, `tenantId`.
- The side effect follows commit: `notify(tx, …)` inserts in the producer's transaction; the sender takes rows `for update of n skip locked` in the identity zone (ADR-012, D10).
- Preferences are read at send time from a `left join`, so a change applies to the next and any waiting alert (DSH-09).
- NFR-18 SPF/DKIM/DMARC and the bounce alarm: pending environment (DNS records and SES identity at MD).

## Findings

- None blocking. Note for FEAT-044/050/055: producers must pass recipients and call `cancelNotifications` on resolution (§8). A hard-deleted membership would leave its alerts pending until purge; no code deletes memberships today.

## RTM

Test ref appended: LED-04 (partial: email only; Telegram FEAT-037, web push FEAT-048), DSH-09 (email channel; others with those features), NFR-18 (partial: Terraform tested; live at MD and with FEAT-036's email channel).

## CI

GitHub CI run 93 on `feat/FEAT-052-owner-alerts`: see below.
