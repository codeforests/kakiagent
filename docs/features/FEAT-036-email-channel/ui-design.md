# UI Design: FEAT-036 — Email channel

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E5) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-038 (new), SCR-APP-036 (p: Connect entry, email card), SCR-APP-014 (p: email conversations) · Mode: per-feature · Status: Draft · Date: 2026-11-08

No design tool is connected and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; only `var(--…)` variables. Components: `card`, `chip`/`status-badge`, `button` (`primary`, `secondary`, `ghost`, `danger-ghost`, `danger`), `confirm-dialog`, `field`, `text-input`, `tabs`, `alert`, `toast`, `skeleton`, `error-state`, `empty-state`, `link`, `snippet-box` (copy behaviour only), `dns-record-table` (design.md §4.6, first use), `message-bubble`. No new component or token. Icons (Lucide, 20 px): `mail` for email, `message-circle` for the widget.

**Record status chip** (text and icon always): OK — success-soft, check, "OK"; Waiting — neutral, clock, "Waiting"; Failing — danger-soft, x-circle, "Not found".
**Domain state chip:** pending — neutral "Checking DNS"; verified — success-soft "Verified"; failing — warning-soft "Not working".

## SCR-APP-038 — Email channel

- **Strategy and source:** code-native (this section).
- **Route:** `/settings/channels/email`; breadcrumb "Settings / Channels / Email". Reached from Channels' Connect entry ("Email · Set up") and the email card's "Email settings" link. Roles: Owner, Admin; Agents get the permission state "Only the Owner and Admins can change channels." (as SCR-APP-036).
- **Contract bindings:** `GET`/`POST /api/v1/channels/email`, `PUT …/reply-cap`, `POST …/domain`, `POST …/domain/check`, `DELETE …/domain`.
- **Layout:** title "Email", lede "Your assistant answers customer emails from your approved facts, in the same email thread." One column at reading width; cards in this order. Go live / offline stay on Channels (one place for them); a caption under the lede: "Status: {Live | Offline} · Change it on `link` Channels."

**Not set up** (`connected: false`): `empty-state` with the `mail` icon, title "Answer customer emails", body "We'll give you an address to forward your business email to. Nothing is sent until you go live.", `primary` "Set up email" (busy "Setting up…"). Success: the page renders the forwarding card, focus on its heading, toast "Email is set up. Next, forward your mail."

**Card 1 — Forwarding address** (heading "1. Forward your email to us"):
- The address in a copy box (mono, `secondary` sm "Copy", announces "Copied").
- `tabs` "Gmail" · "Outlook" · "Other" with 3–4 numbered steps each (Gmail: Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding address → paste → confirm with the code below → "Forward a copy… keep Gmail's copy in the Inbox"; Outlook: Settings → Mail → Forwarding → Enable → paste → "Keep a copy"; Other: "Set up automatic forwarding to this address in your email provider. Keep a copy in your mailbox.").
- Gmail code (`forwardingConfirmation` present): `alert` (info) "Gmail sent a confirmation code: **{code}**" with `link` "Open Gmail's confirmation link" (new tab) when a link exists, caption "Received {relative time}."
- Status line (body-sm): `lastReceivedAt` → success check "Forwarding works. Last email received {relative time}."; none → clock "Waiting for your first forwarded email."
- Note (caption, text-secondary): "Your assistant replies for you. Reply from the KakiAgent inbox so the whole thread stays together."

**Card 2 — Reply from** (heading "2. The address replies come from"):
- Current line: "Replies come from **{replyFrom}**." 
- No domain: body "Use your own address, like hello@yourbusiness.sg. You'll add a few DNS records so inboxes trust it." `field` "Your business email" (`text-input`, type email, help "Must be on a domain you own, not Gmail or Outlook."), `secondary` "Use this address" (busy "Adding…").
- With a domain: header row = the address + domain state chip; meta "Last checked {relative}" / "Verified {date}" / "Not working since {date}".
  - pending: `alert` (info) "Add these records at your domain provider. Until they check out, replies keep coming from {forwarding address}."
  - failing: `alert` (warning) "Some records are missing, so replies come from {forwarding address} again. Put the records back, then check again."
  - `dns-record-table`: columns Type · Host · Value (mono, wraps, copy button per value, `aria-label` "Copy value for {host}") · Status chip; below 640 px each record is a stacked list item (Type and Host on one line, Value block, chip). Purpose labels as a caption under Host: "Signs your email (DKIM)", "Bounce handling (SPF)", "Sender policy (DMARC)". The DMARC row appears only when it's missing, with caption "You can tighten p=none later."
  - Actions: `secondary` "Check now" (busy "Checking…"; 429 → caption "You can check again in a few seconds."); `danger-ghost` "Stop using this address" → `confirm-dialog` "Stop replying from {address}?" body "Replies will come from {forwarding address}. You can add it again later." buttons "Cancel" / `danger` "Stop using it". Focus returns to the email field.
  - Verified after a check: toast "{address} is verified. Replies now come from it."; still pending: inline caption "Not all records are there yet. DNS changes can take up to a few hours."
- Errors (inline on the field, NFR-19): `platform_domain` "Use an address on your own domain, not {domain}."; invalid "Enter an email address like hello@yourbusiness.sg."; `provider_unavailable` "We couldn't reach our email provider. Try again in a minute."; `stale` "Someone else changed this. Reload to see the latest." with `link` "Reload".

**Card 3 — Safety** (heading "3. Stop email loops"):
- Body "Your assistant never answers out-of-office replies, bounces, mailing lists, bulk mail or spam."
- `field` "AI replies per email thread" `text-input` number (min 1, max 50) with suffix "per 24 hours", help "After this, the AI stops and the conversation goes to your team. Default 10."; `secondary` "Save" (disabled until changed). Error: "Enter a number from 1 to 50." Toast "Saved."
- Ignored mail (title-sm "Ignored in the last 7 days"): a short list "{count} out-of-office replies", "{count} bounces", "{count} mailing-list emails", "{count} bulk emails", "{count} spam", "{count} unsafe emails", "{count} loops" (non-zero rows only); none → caption "Nothing ignored yet." Caption: "Ignored emails are still in your own mailbox."

**States:** loading = skeleton cards; error = `error-state` "We couldn't load your email settings." + "Try again"; permission (Agent); not set up; forwarding only; domain pending; verified; failing; saving per card; validation errors; conflict (409 → reload alert).

## SCR-APP-036 — Channels (partial)

- **Connect a channel** section now renders: row "Email" with `mail` icon, caption "Answer customer emails in the same thread.", `secondary` "Set up" → `/settings/channels/email`.
- Email card: `mail` icon; under the meta a `link` "Email settings". The "While it's offline" radios for email: `hidden` "Don't reply" (help "Emails wait in your inbox for your team."), `message` "Reply with a message" (help "Each new email gets your message once."). The textareas and preview as for the widget, preview label "What customers get". The degraded alert's fix line for email: "Check the DNS records on the Email page." with `link` "Email settings" replacing "Check again".

## SCR-APP-014 — Inbox (partial: email conversations)

- Channel filter option "Email" after "Website chat". Rows: the `mail` glyph (with `aria-label` "Email") where the widget's chat glyph is; the row's first line is the subject when present, then the last message as now.
- Thread header: the subject (title-sm, one line, truncated with the full text in `title`) under the contact name; caption "By email".
- **Delivery line** under AI and staff bubbles in email conversations (caption, right-aligned with the bubble): `sending` "Sending…" (clock); `sent` nothing; `failed` danger text with x-circle "Not delivered: {reason}" + `ghost` sm "Retry" (busy "Retrying…"; failure toast "Couldn't retry. Try again."). Reasons: `bounced` "the address bounced"; `rejected` "the email was refused"; `timed_out` "we couldn't send it for 24 hours".
- **Attachment chips** under a visitor bubble: paperclip icon + name + size; `clean` is a link that downloads ("Download {name}"); `scanning` "Checking…" (no link); `rejected` text-secondary with "Not stored: {reason}" (`unsupported_type` "file type not allowed", `too_large` "over 10 MB", `malware` "failed the virus check", `encrypted` "password-protected", `too_many` "more than 10 files").
- Escalation strip texts: `reply_cap` "AI reply limit reached in this email thread"; `delivery_failed` "A reply couldn't be delivered".

## Tokens used

`--color-success-soft`, `--color-warning-soft`, `--color-danger-soft`, `--color-info-soft`, `--color-text-secondary`, `--color-danger-default`, `--color-bg-subtle`, `--color-border-default`, `--font-family-mono`, `--space-*`, `--radius-md`, `--radius-lg`. Nothing hard-coded.

## Gaps and escalations

- Email consent and withdrawal wording (technical-design D7) and verified contact merge (FEAT-039) aren't on these screens.
- Go-live readiness for email reuses FEAT-035's checklist unchanged.
