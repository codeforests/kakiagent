# Tasks: FEAT-052 — Owner alerts by email, quiet hours, digest, notification preferences

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: accepted · Last updated: 2026-11-01 (verify)

## Build session 1 (backend)

- [x] T1 — Schema: `0044_notifications.sql` (`notification_prefs`, `notifications` with checks, unique dedupe key, partial due index, FKs to `memberships`; forced RLS and tenant policies; grants for `app_dashboard`, `app_agent_visitor`, `app_identity`; the `identity_lookup` policy on `notifications`) + Drizzle tables and `TENANT_SCOPED_TABLES`; RLS cases in `packages/db/test/rls.int.test.ts` (design §4; AC-9)
  Done when: `pnpm --filter @kaki/db test:integration` passes through `scripts/test-env.sh`, including tenant-B-can't-see-A for both tables, the dashboard zone refused an update of `kind`, and the identity zone's cross-tenant due scan.
- [x] T2 — Notifications core in `packages/platform/src/notifications/`: `kinds.ts`, `quiet.ts`, `prefs.ts`, `notify.ts` (`notify`, `cancelNotifications`), `templates.ts`, `links.ts`; `./notifications` in platform's `exports` (design §5.1; AC-3, AC-5–AC-7)
  Done when: unit tests for `inQuietHours`/`quietEndsAt` (wrap, non-wrap, boundaries, off), templates (subjects, urgent prefix, HTML escaping, no payload fields beyond kind/time/link), and an integration test for `notify` dedupe, `cancelNotifications` and `savePrefs` merge pass; `pnpm --filter @kaki/platform typecheck`.
- [x] T3 — Sender `send.ts` `sendDueNotifications` (pending → sent/held/skipped, retries with backoff, 24 h → failed, digests per member per business, purge after 30 days) + `packages/platform/test/notifications.int.test.ts` with a fake mailer and an injected `now` (design §5.2; AC-1–AC-4, AC-7, AC-8)
  Done when: cases pass for: sent outside quiet hours; held inside; urgent sent inside; digest of three (one cancelled) as one email when the window ends; quiet hours turned off releases the digest; all cancelled → no email; muted → skipped; test kind ignores mute and quiet; inactive member → skipped; provider failure retried then sent; 24 h → failed; two parallel senders send once; purge.
- [x] T4 — Scheduler wiring: `NOTIFY_SWEEP_MS` (Zod default 5000, `.env.example`), the chained timer and shutdown in `apps/scheduler-worker/src/main.ts` (design §5.3; AC-1)
  Done when: `pnpm --filter @kaki/scheduler-worker typecheck` and its unit tests pass.
- [x] T5 — Contracts and API: the notifications section in `packages/contracts/src/index.ts` (§3) with unit tests; `apps/api/src/notifications.ts` `registerNotificationRoutes` wired in `app.ts`; `apps/api/test/notifications.int.test.ts` (design §3, §5.4; AC-5, AC-6, AC-9, AC-11)
  Done when: cases pass for: GET defaults; PUT persists and GET reflects it; unlisted events kept; `same_time` 422; an Agent without approval rights doesn't see `approval_pending` and gets 403 setting it; an Agent with rights does; test alert 202 writes one `test` row and a second within 60 s is 429; tenant B's member can't read or change tenant A's row; the same user's prefs differ per business.
- [x] T6 — Terraform `infra/terraform/modules/mail` (SES identity, DKIM, MAIL FROM, configuration set, bounce-rate alarm, `dns_records` output), wired in `envs/prod` with `mail_domain` and `dmarc_report_address`, `EMAIL_FROM` from it; a `mail` run in `tests/profiles.tftest.hcl` (design §5.6; AC-10)
  Done when: `terraform fmt -check`, `validate` and `terraform test` pass where Terraform is installed.
  Note: if the cloud session has no Terraform, CI's `terraform` job runs these in the verify stage; record that here.
  Done (build, 2026-11-01): Terraform 1.16.6 with the providers from releases.hashicorp.com as a filesystem mirror (the registry is blocked in cloud sessions): `fmt -check`, `validate` and `terraform test` (launch_profile, full_profile, mail) pass. tflint left to CI.

## Build session 2 (UI)

- [x] T7 — Dashboard data: `lib/api.ts` calls (`getNotificationPrefs`, `putNotificationPrefs`, `sendTestAlert`); `lib/notifications.ts` hooks and pure helpers (`EVENT_TEXT`, `quietSummary`, `quietError`, `testErrorText`) with `lib/notifications.test.ts` (design §5.5; AC-5, AC-6, AC-11)
  Done when: `pnpm --filter @kaki/dashboard test` and typecheck pass.
- [x] T8 — SCR-APP-056 `pages/notifications.tsx` at `/account/notifications`; route in `router.tsx`; "Notifications" in the account menu; the Notifications card on My account (ui-design SCR-APP-056; AC-11)
  Done when: a stubbed-API Chromium run shows the default, saving, rolled-back switch, quiet-hours error, test sent and rate-limited states, with focus as specified.
  Evidence (2026-11-01, Chromium at 375 and 1280 against `vite` with `/api` stubbed): defaults (4 switches on, 22:00–08:00, "Overnight, …" help); saving = `aria-busy` + optimistic off, then toast "Saved.", focus on the switch; a 500 rolls the switch back with the card's danger alert, focus kept; the next save clears the alert; all off shows the info alert; same time → "Pick a different end time." on To with focus there; empty → "Enter a time."; daytime help starts "Singapore time."; "Quiet hours saved." and the button disables; quiet hours off hides the fields; test → toast "Test alert sent to …", focus on the button; 429 → "You just sent one. Try again in 60 seconds."; no horizontal scroll at 375; account menu lists "Notifications"; My account card links to `/account/notifications`.
- [x] T9 — E2E `e2e/tests/notifications.e2e.ts` (design §5.7; AC-1, AC-5, AC-6, AC-11)
  Note: runs in the verify stage's GitHub CI (no local stack in cloud sessions). Typecheck and ESLint pass on the spec.
- [x] T10 — Verify: full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for platform, db, api, contracts, scheduler-worker, dashboard through `scripts/test-env.sh`; tick tasks; status `developer-done`.
  Evidence (2026-11-01): `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (24/24 tasks) green through `scripts/test-env.sh`. `test:coverage` green for db, contracts, scheduler-worker, dashboard; platform and api pass their thresholds with only `test/rate-limit.int.test.ts` (Valkey) and `test/uploads.int.test.ts` (S3 presigner) excluded, both needing Docker containers this session doesn't have (unchanged by FEAT-052; they run in GitHub CI).

## Verification evidence

- AC-1 — Pass; see acceptance-report.md (audit table)
- AC-2 — Pass; see acceptance-report.md (audit table)
- AC-3 — Pass; see acceptance-report.md (audit table)
- AC-4 — Pass; see acceptance-report.md (audit table)
- AC-5 — Pass; see acceptance-report.md (audit table)
- AC-6 — Pass; see acceptance-report.md (audit table)
- AC-7 — Pass; see acceptance-report.md (audit table)
- AC-8 — Pass; see acceptance-report.md (audit table)
- AC-9 — Pass; see acceptance-report.md (audit table)
- AC-10 — Pass; see acceptance-report.md (audit table)
- AC-11 — Pass; see acceptance-report.md (audit table)
