# Technical design: FEAT-052 — Owner alerts by email, quiet hours, digest, notification preferences

> Implements: LED-04 (p: email; Telegram with FEAT-037, web push with FEAT-048: alerts for new hot leads, escalations and pending approvals arrive within 1 minute, respect quiet hours except for urgent items, and what was held is sent as one digest when quiet hours end), DSH-09 (each user chooses which events reach them on which channel, and their quiet hours; preferences take effect on the next alert), NFR-18 (alert email authenticated with SPF, DKIM and DMARC; bounce rate alarm above 5%) · Realizes: UC-22 step 4 (p: the alert; the signed single-use link is FEAT-055's, APR-03), UC-23 step 2 (p: "notifies staff"; routing and reminders are FEAT-044's) · Screens: SCR-APP-056 · Module: notifications in `platform` (plan E6), ADR-012 (timers in Postgres), ADR-019 (SES)
> Status: designed · 2026-11-01

## 1. Intent

Any module that needs a person's attention (FEAT-044 escalations, FEAT-055 approvals, FEAT-050 hot leads) calls one function, `notify(tx, …)`, in the same transaction as the change that needs attention. Each recipient's alert is then emailed within a minute, unless that person turned the event off, or it falls in their quiet hours (default 22:00–08:00 Singapore time) and isn't urgent, in which case it is held and arrives in one digest email when their quiet hours end. A producer can cancel alerts that no longer matter (an escalation someone claimed), so a digest never lists them. Each user sets, per business they belong to, which events reach them by email and their quiet hours, on a new "Notifications" page under My account, and can send themselves a test alert. Telegram (FEAT-037) and web push (FEAT-048) later add a channel column to the same preferences and a sender to the same loop. In production the alert email is sent through SES from a domain with DKIM, a custom MAIL FROM (SPF) and a DMARC record, written in Terraform with a bounce-rate alarm.

No producer exists yet: escalations come next in FEAT-044, approvals in FEAT-055, hot leads in FEAT-050. This feature delivers the pipeline, the preferences and the test alert, and is demonstrated through the test alert and the integration suites.

## 2. Codebase context

- **Email today** (`packages/platform/src/mailer.ts`): `Mailer.send({ to, subject, text, html })` over SMTP (Mailpit locally, SES SMTP in AWS). Account email (sign-in links, invitations, email changes) follows one pattern: a row per email written by the request, a scheduler-worker sweep every `MAGIC_LINK_SWEEP_MS` (5 s) in the identity zone that sends unsent rows with `for update skip locked`, retries with `backoffSeconds`, and purges old rows (`packages/identity/src/invitations.ts` `sendPendingInvitations`, `deliver`). The identity zone reads members' email addresses; the cross-tenant scan is an `identity_lookup` SELECT policy (`0040_team.sql`).
- **Outbox** (`platform/src/outbox.ts`): topics `conversation-turns`, `ingest` only; no `notifications` SQS queue exists in LocalStack or Terraform (`infra/terraform/modules/queues`).
- **Scheduler** (`apps/scheduler-worker/src/main.ts`): one `setInterval` per job, chained through a promise so ticks don't overlap (`sweeping = sweeping.then(sweepLinks)`); config parsed with Zod at the top, every variable in `.env.example`.
- **Members and rights** (identity): `memberships` (PK `tenant_id, user_id`, `status`, `role`, `approval_rights`), `canApprove(m)`; `Me` carries `user.email` and `canApprove`. Rate limiting: `RateLimiter.hit(key, limit, windowMs)` (`platform/src/rate-limit.ts`).
- **Dashboard**: My account is `pages/account.tsx` with cards in `pages/account-parts.tsx`; the account menu is `shell/account-menu.tsx` (Radix dropdown, item "My account"). Switches are native `button role="switch"` (`pages/assistant.tsx`, `business-profile.tsx`); time inputs are `input type="time"` with "Times are Singapore time." help (`business-profile.tsx`).
- **Terraform**: modules under `infra/terraform/modules`, root `envs/prod` with `tests/profiles.tftest.hcl`; DNS is outside AWS (the root takes `origin_domain_name`), so DNS records are outputs to add by hand. CI's `terraform` job runs `validate`, `tflint` and `terraform test`.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: notifications (LED-04, DSH-09; FEAT-052 §3)`)

- `AlertEvent = z.enum(['escalation', 'approval_pending', 'hot_lead'])` (LED-04's three; the internal `test` kind is not an `AlertEvent`).
- `NotificationChannel = z.enum(['email'])` (FEAT-037 adds `telegram`, FEAT-048 `push`).
- `ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)`.
- `QuietHours = z.object({ enabled: z.boolean(), start: ClockTime, end: ClockTime }).refine(q => q.start !== q.end, { path: ['end'], message: 'same_time' })`.
- `EventPref = z.object({ event: AlertEvent, email: z.boolean() })` (one boolean per channel; FEAT-037 adds `telegram`).
- `NotificationPrefs = z.object({ channels: z.array(NotificationChannel), events: z.array(EventPref), quietHours: QuietHours, timeZone: z.literal('Asia/Singapore'), sendTo: z.object({ email: z.string() }) })`. `events` lists only the events this member can receive (D9), in the order escalation, approval_pending, hot_lead.
- `NotificationPrefsBody = z.object({ events: z.array(EventPref).max(3), quietHours: QuietHours }).strict()` with a refine that events are unique. Events not listed keep their stored setting.
- `TestAlertResult = z.object({ sentTo: z.string() })`; 429 body `ErrorBody.extend({ error: z.literal('rate_limited'), retryAfterSeconds: z.number().int() })`.

**Routes** (`apps/api/src/notifications.ts` `registerNotificationRoutes(app, deps, sessionFrom)`, wired at the end of `app.ts`; every route needs a workspace session; tenant and user from the session only):

| Method, path | Capability | Success | Errors |
|---|---|---|---|
| `GET /api/v1/me/notifications` | any member | 200 `NotificationPrefs` (defaults when no row, D4) | 401 |
| `PUT /api/v1/me/notifications` | any member | 200 `NotificationPrefs` (upsert of the caller's row; last write wins, D4) | 422 validation (`same_time`, duplicate event, unknown event); 403 `forbidden` for `approval_pending` from a member who can't approve |
| `POST /api/v1/me/notifications/test` | any member | 202 `TestAlertResult`; writes one `test` notification to the caller (D11) | 429 `rate_limited` (1 per 60 s per member) |

## 4. Schema changes (migration `0044_notifications.sql`; Drizzle DDL, then hand-written RLS, grants and checks in the same file)

- **`notification_prefs`** (one row per membership, D4): `tenant_id uuid`, `user_id uuid`, `email_muted text[] not null default '{}'` (events turned off for email; check `email_muted <@ array['escalation','approval_pending','hot_lead']`), `quiet_enabled boolean not null default true`, `quiet_start smallint not null default 1320` (minutes after midnight SGT, 22:00), `quiet_end smallint not null default 480` (08:00), `updated_at timestamptz not null default now()`; checks `quiet_start`/`quiet_end` between 0 and 1439 and `quiet_start <> quiet_end`; PK `(tenant_id, user_id)`; FK `(tenant_id, user_id) → memberships` on delete cascade.
- **`notifications`** (one row per recipient per alert; the durable timer, D2): `tenant_id uuid`, `id uuid default gen_random_uuid()`, `user_id uuid not null`, `kind text not null` (check in `escalation, approval_pending, hot_lead, test`), `urgent boolean not null default false`, `subject_type text not null` (check in `conversation, approval, lead, user`), `subject_id uuid not null`, `dedupe_key text not null`, `status text not null default 'pending'` (check in `pending, held, sent, skipped, cancelled, failed`), `skip_reason text` (check in `muted, inactive`; non-null iff status `skipped`), `digest boolean not null default false` (sent inside a digest), `attempts int not null default 0`, `next_attempt_at timestamptz not null default now()`, `created_at`, `held_at`, `sent_at` timestamptz; PK `(tenant_id, id)`; unique `(tenant_id, user_id, dedupe_key)`; partial index `(next_attempt_at) where status in ('pending', 'held')`; FK `(tenant_id, user_id) → memberships` on delete cascade.
- Both tables: forced RLS with the standard tenant policy, names in `TENANT_SCOPED_TABLES`, cases in `packages/db/test/rls.int.test.ts`.
- Grants: `app_dashboard` SELECT, INSERT, UPDATE `(email_muted, quiet_enabled, quiet_start, quiet_end, updated_at)` on `notification_prefs`; `app_dashboard` and `app_agent_visitor` SELECT, INSERT, UPDATE `(status)` on `notifications` (producers notify and cancel, D8). `app_identity` SELECT on both, UPDATE `(status, skip_reason, digest, attempts, next_attempt_at, held_at, sent_at)` and DELETE on `notifications`, and `CREATE POLICY identity_lookup ON notifications FOR SELECT TO app_identity USING (true)` for the sender's due scan (the invitations precedent, D10).

## 5. Component design

### 5.1 Notifications core (`packages/platform/src/notifications/`, exported as `@kaki/platform/notifications`)
- `kinds.ts`: `ALERT_EVENTS`, `NOTIFICATION_KINDS` (+ `test`), `CHANNELS = ['email']`, `URGENT` doc comment pointing at SRS §1.4 (the producer decides: a visitor-requested escalation; an approval within 30 minutes of its SLA).
- `quiet.ts` (pure): `TIME_ZONE = 'Asia/Singapore'` (UTC+8, no DST), `sgMinutes(now)`, `inQuietHours(q, now)` (window `[start, end)`, wrapping midnight when `start > end`), `quietEndsAt(q, now)` (the next end instant, for the digest's subject), `toClock(min)`/`fromClock('22:00')`. Unit tests: wrap, non-wrap, boundaries, off.
- `prefs.ts`: `DEFAULT_PREFS`, `getPrefs(tx, tenantId, userId)` (row or defaults), `savePrefs(tx, tenantId, userId, { events, quietHours })` (upsert; merges muted events: listed events set, unlisted kept).
- `notify.ts`: `notify(tx, { tenantId, kind, recipients: string[], urgent?, subject: { type, id }, dedupeKey })` inserts one `pending` row per distinct recipient, `on conflict (tenant_id, user_id, dedupe_key) do nothing` (a retried producer job never alerts twice), returns the count written. `cancelNotifications(tx, tenantId, { type, id }, kind?)` sets `pending`/`held` rows for that subject to `cancelled` and returns the count. Neither checks preferences: that happens at send time (D3).
- `templates.ts` (pure): `alertEmail(kind, ctx)` and `digestEmail(items, ctx)` → `Email` (text and HTML, HTML-escaped). `ctx = { to, businessName, link, settingsLink }`. Subjects: escalation "[{business}] A customer wants to talk to a person"; approval_pending "[{business}] A reply is waiting for your approval"; hot_lead "[{business}] New hot lead"; test "[{business}] Test alert from KakiAgent"; urgent alerts prefix "Urgent: ". Body: one line saying what happened, a button-styled link "Open in KakiAgent", and a footer "You get this because of your notification settings for {business}: {settingsLink}". Digest subject "[{business}] {n} alerts while your quiet hours were on", one line per alert with its time (`h:mm a`) and link, oldest first. No visitor names, contact details or message text in any email (D12).
- `links.ts`: `linkFor(kind, subject, appUrl)`: escalation → `/inbox/{conversationId}`, approval_pending → `/approvals/{id}` (FEAT-055 swaps in its signed link here), hot_lead → `/leads/{id}`, test → `/account/notifications`.

### 5.2 Sender (`packages/platform/src/notifications/send.ts`)
`sendDueNotifications(idDb, mailer, { appUrl, now?, limit = 50 })` → `{ sent, held, digests, skipped, failed, purged }`, run by the scheduler every `NOTIFY_SWEEP_MS` (default 5000, ADR-012's 5-second poll; LED-04's minute leaves room for retries).
1. Due tenants: `select distinct tenant_id from notifications where status in ('pending','held') and next_attempt_at <= now` (the `identity_lookup` policy).
2. Per tenant, `withTenant(idDb, tenant, …)`: lock due `pending` rows `for update skip locked` (two scheduler tasks never take the same row), joined to `memberships` (status), `users` (email), `tenants` (name), `notification_prefs` (left join, defaults). Per row, in order: membership not active → `skipped`/`inactive`; kind muted for email and kind ≠ `test` → `skipped`/`muted`; in quiet hours and not urgent and kind ≠ `test` → `held`, `held_at = now` (no email); else send `alertEmail` → `sent` (`attempts + 1`). A provider error → `attempts + 1`, `next_attempt_at = now + backoffSeconds(attempts)` (10 s doubling to 30 min); once `created_at` is older than 24 hours → `failed` with a `warn` log carrying the tenant, row ID and kind only (NFR-17; no alert about a failed alert).
3. Digests: per tenant, the `held` rows grouped by user, locked `for update skip locked`. For each user not in quiet hours *now* (by the current preferences, so turning quiet hours off or shortening them releases the digest at the next tick, D7): one `digestEmail` of the non-cancelled held rows; all of them → `sent`, `digest = true`. A failure retries the whole digest with the same backoff (`next_attempt_at` on the group).
4. Purge: rows with `status not in ('pending','held')` and `created_at` older than 30 days are deleted (D13).
Delivery is at least once: a crash after the provider accepted and before commit re-sends that one email.

### 5.3 Scheduler (`apps/scheduler-worker/src/main.ts`)
A `NOTIFY_SWEEP_MS` timer (Zod default 5000, in `.env.example`) chaining `sendDueNotifications(identityDb, mailer, { appUrl: config.PUBLIC_APP_URL })` like `sweepLinks`, logging non-zero results; cleared on shutdown.

### 5.4 API (`apps/api/src/notifications.ts`)
`GET`/`PUT` read and upsert through `withTenant(dashboardDb, s.tenantId, …)` with `s.userId`; the event list is `ALERT_EVENTS` minus `approval_pending` unless `canApprove(s)` (D9); `sendTo.email` is the session user's email. `POST …/test`: `rateLimiter.hit('notify-test:' + userId, 1, 60_000)`, then `notify(tx, { kind: 'test', recipients: [s.userId], urgent: true, subject: { type: 'user', id: s.userId }, dedupeKey: 'test:' + randomUUID() })` → 202.

### 5.5 Dashboard (detail in ui-design.md)
- `lib/notifications.ts`: `useNotificationPrefs`, `useSaveNotificationPrefs` (optimistic per switch, rolled back on error), `useSendTestAlert`; pure `EVENT_TEXT` (label and help per event), `quietSummary(q)` ("22:00 to 08:00, Singapore time"), `quietError(q)`, `testErrorText(err)`. `lib/api.ts` gains the three calls.
- `pages/notifications.tsx` (SCR-APP-056) at `/account/notifications`; `router.tsx` route; the account menu gains "Notifications" under "My account"; `pages/account.tsx` gains a `card` "Notifications" with a link.

### 5.6 Email authentication (`infra/terraform/modules/mail`, NFR-18, D14)
`aws_sesv2_email_identity` for `var.mail_domain` with Easy DKIM (RSA 2048), `aws_sesv2_email_identity_mail_from_attributes` (`mail.{domain}`, behaviour on MX failure `USE_DEFAULT_VALUE`), a configuration set with reputation metrics and sending enabled, and `aws_cloudwatch_metric_alarm` on `AWS/SES` `Reputation.BounceRate` > 0.05 (period 1 h, alarm actions `var.alarm_topic_arns`). Outputs `dns_records`: the three DKIM CNAMEs, the MAIL FROM MX and SPF TXT (`v=spf1 include:amazonses.com -all`), and `_dmarc.{domain}` TXT `v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:{var.dmarc_report_address}`. `envs/prod` instantiates it (`mail_domain`, `dmarc_report_address` variables) and its `EMAIL_FROM` uses `no-reply@{mail_domain}`. `tests/profiles.tftest.hcl` gains a `mail` run asserting DKIM signing, the MAIL FROM domain, the DMARC record and the alarm threshold. Never applied before MD.

### 5.7 E2E (`e2e/tests/notifications.e2e.ts`)
Signed in as the bakery owner: open Notifications from the account menu; defaults shown (three events on, quiet hours 22:00–08:00); turn escalation email off and reload (persists); set quiet hours and save (toast); "Send me a test alert" → toast, and the email arrives in Mailpit within 30 s with the settings link; restore the defaults in `afterEach`; axe at 1280 and at `{ width: 375, height: 5000 }`.

## 6. Acceptance criteria

- **AC-1** (LED-04 "alert arrives within 1 minute", UC-22 4, UC-23 2) An alert written with `notify` for a member outside their quiet hours, with email on for the event, is emailed to that member within 1 minute; the email names the business and the event and links to the item; it carries no visitor name, contact detail or message text.
- **AC-2** (LED-04 "quiet hours are respected") A non-urgent alert due inside the member's quiet hours is held and not emailed.
- **AC-3** (LED-04 "except for urgent items", SRS §1.4) An urgent alert is emailed at once inside quiet hours, marked "Urgent:".
- **AC-4** (LED-04 "alerts held during quiet hours are sent as one digest when quiet hours end") When the member's quiet hours end, or they turn quiet hours off, everything held for them in that business goes out as exactly one digest email, oldest first; cancelled alerts are left out, and if all were cancelled no email is sent.
- **AC-5** (DSH-09 "each user chooses which events … on which channels", "take effect on the next alert") A member turns an event's email off or on; the next alert of that kind is skipped (`muted`) or sent accordingly. Approval alerts appear only for members who can approve. Defaults: every event on, quiet hours on 22:00–08:00 Singapore time.
- **AC-6** (DSH-09 "and their quiet hours", LED-04 default) A member turns quiet hours on or off and sets start and end times (Singapore time; windows may cross midnight); the same start and end is refused.
- **AC-7** (UC-23 2, plan: producers FEAT-044/050/055) A producer's retried `notify` with the same dedupe key alerts once; `cancelNotifications` stops pending and held alerts for a subject; an alert for a member who has left or been deactivated is not sent.
- **AC-8** (NFR-17) A provider failure is retried with backoff and the alert is sent when the provider recovers; after 24 hours it is marked failed and logged; two concurrent senders never email the same alert twice.
- **AC-9** (ADR-005, AUTH-04) Both tables have forced RLS (tenant B can't read or write tenant A's rows); a member reads and changes only their own preferences, per business; routes take the tenant and user only from the session.
- **AC-10** (NFR-18) The Terraform `mail` module signs with DKIM, sets a custom MAIL FROM with SPF, outputs a DMARC record and alarms on a bounce rate above 5%; `terraform test` passes in CI.
- **AC-11** (SCR-APP-056, NFR-09, NFR-19) The page renders the states in ui-design.md: switches save on change with a rollback on error, quiet hours save with validation, the test alert reaches the member's inbox; at 375 px it works without horizontal scroll; axe reports no serious violations.

## 7. Decisions

- **D1 — Notifications live in `platform`, as `@kaki/platform/notifications`** (plan E6: "notifications in platform"). Every producer module already depends on platform, so no new module or cycle; it reads members, users and tenants by SQL like the identity sweeps do.
- **D2 — Alerts are rows polled from Postgres, not a new SQS queue.** The row is written in the producer's transaction, so it has the outbox's guarantee (nothing sent unless the change commits). A quiet-hours hold is a timer, which ADR-012 keeps in Postgres with a 5-second poll and `skip locked`; the account emails already work this way. *Rejected:* outbox → a `notifications` SQS queue → consumer: a new queue in LocalStack and Terraform, a new consumer, and still a Postgres timer for held alerts. *Revisit:* if FEAT-037's Telegram sends move to `outbound-send`, or volume needs it.
- **D3 — Preferences and quiet hours are applied when sending, not when notifying** (DSH-09 "takes effect on the next alert"; a change made while an alert waits applies to it).
- **D4 — Preferences are per membership and stored as opt-outs.** A person in two businesses may want different alerts for each. `email_muted` lists turned-off events, so an event added later is on by default; no row means the defaults. A member edits only their own row, so last write wins (no version).
- **D5 — Quiet hours are in Singapore time** (LED-04: "default quiet hours 22:00–08:00 SGT"; the product serves Singapore SMEs). Stored as minutes; any minute allowed; windows may cross midnight.
- **D6 — The producer decides urgency** (SRS §1.4). Urgent bypasses quiet hours only, never a muted event.
- **D7 — One digest per member per business, sent at the first tick outside quiet hours by the current settings,** so turning quiet hours off releases it. *Rejected:* one digest across businesses (each email is one business's, with its name and links).
- **D8 — Producers pass the recipients, a subject and a dedupe key.** Routing is the producer's (FEAT-044 round-robin, FEAT-055 approvers via `canApprove`, FEAT-050 lead recipients); the notifications core doesn't know who should get what. Producers cancel through `cancelNotifications` when the subject is resolved.
- **D9 — The page shows approval alerts only to members who can approve.** Escalations and hot leads are shown to every role (Agents see Inbox and Leads, ux-foundations IA).
- **D10 — The sender runs in the identity zone.** It is the zone that reads members' email addresses and already sends every email to members (FEAT-005/007/008), with an `identity_lookup` SELECT policy for the cross-tenant scan. Producers write from their own zones (dashboard, visitor). *Consequence:* AGENTS.md's "identity is for sign-in and sessions only" already has these email exceptions; this adds alerts to them.
- **D11 — The test alert ignores quiet hours and mutes,** goes only to the caller, and is limited to one a minute.
- **D12 — Alert emails carry no visitor data,** only the event, the business and a link into the signed-in dashboard (ADR-015: PII stays in contact-keyed tables; email leaves the region's control). The notification row holds IDs and codes only.
- **D13 — No audit entries;** the `notifications` table is the record, kept 30 days. Preference changes are personal settings, not tenant governance (ADR-014's audited actions).
- **D14 — NFR-18 is met in Terraform, not code.** The mailer stays SMTP; SES signs with DKIM for the verified domain. The bounce alarm is written now and goes live with MD (plan §7).
- **D15 — English only.** The dashboard is English; Chinese alert emails come if the dashboard gains a locale.

## 8. Escalations and open items

- **Producers:** FEAT-044 calls `notify` for escalations (urgent when the visitor asked for a person) and reminders (dedupe key per reminder), and `cancelNotifications` on claim or take-over; FEAT-055 for approvals (urgent within 30 minutes of the SLA) with its signed link in `links.ts`, cancelled on decision; FEAT-050 for hot leads.
- **Channels:** FEAT-037 adds `telegram` to `NotificationChannel`, a `telegram_muted` column and a Telegram sender branch in `send.ts`; FEAT-048 adds `push` the same way. The page renders one switch column per channel in `channels`.
- If every recipient has muted an event, nobody is emailed; in-app signals (inbox, counts) remain. FEAT-044's reminders should still fire.
- The top bar's notifications control (ux-foundations IA) is not in scope; no feature owns it yet (noted for planning).

## 9. Self-check

- LED-04's clauses → AC-1 (minute), AC-2 (quiet), AC-3 (urgent), AC-4 (digest); DSH-09's → AC-5, AC-6; NFR-18 → AC-10; NFR-17 → AC-8; UC-22 4 and UC-23 2 → AC-1, AC-7.
- Two new tenant tables with forced RLS, policies, `TENANT_SCOPED_TABLES` entries and RLS cases; tenant and user from the session only.
- The side effect (email) happens only after the producer's transaction commits, through a durable Postgres row polled with `skip locked` (ADR-012); the sender is idempotent per row.
- No model call, no visitor-facing change, no PII in emails or rows.
