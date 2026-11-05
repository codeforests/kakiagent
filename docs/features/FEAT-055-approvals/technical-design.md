# Technical design: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry

> Implements: APR-02, APR-04, APR-06, AGT-06 (p: `draft_approval`; `handoff_channel` is FEAT-038) · Realizes: UC-22 steps 2, 3, 5 (in the app), 6, 7 with 3a, 5a, 5c, 5d, 6a (step 4's signed single-use link and 5b are FEAT-056, APR-03; the alert itself is FEAT-052's `approval_pending`) · Screens: SCR-APP-017 (new), SCR-APP-018 (new; the link landing states are FEAT-056), SCR-APP-042 (p: approval SLA and approvers), SCR-WGT-002 (p: waiting for approval, quote card), SCR-APP-014 (p: sidebar approval) (see [ui-design.md](ui-design.md)) · Module: `approvals` (`draft`, `decide`, `expire`), architecture §5.2 and §6.2, ADR-008, ADR-012, ADR-013, ADR-014, ADR-025
> Status: designed · 2026-11-05

## 1. Intent

When a visitor asks for a quote, a discount or a custom commitment ("200 cupcakes for our office, any discount? can you deliver Friday?"), the assistant never answers it itself. It drafts an approval in code from the visitor's request and the KB prices it retrieved, tells the visitor the team is checking and when to expect a reply (the next business day after hours), and alerts the approvers. An approver (Owner, Admin, or an Agent with approval rights) opens the queue, sees the draft, the conversation and the prices used, and approves it, edits and approves it, or rejects it with a reason. The first decision wins. The approved quote goes to the visitor as a quote card in the conversation, even if the conversation has closed; a rejection tells the visitor the team will follow up. An approval with no decision within the SLA (default 2 business hours) escalates the conversation; after 7 days it expires and the visitor is told the team will contact them.

## 2. Codebase context

- **Dispatcher** (`agent/dispatch.ts`, ADR-025): `request_commitment` exists in `TaskKind` (triage args `items`, `quantity`, `date`) and routes to `reply.complex`, but has no handler, so it's `unhandled`. `TaskHandler.checkBoundary` and `tool` exist. `ConversationPort` is the handler's only write route.
- **Boundary rules** (FEAT-054): `@kaki/approvals` `rules.ts` with `commitmentDecision(rules, { discountPct })` (`refuse` above the maximum, else `needs_approval` / `allowed`); `boundaryGuard` blocks every discount offer in model text (FEAT-054 D4); the prompt says "say the team will confirm".
- **Lifecycle** (FEAT-042): `inbox` `transition` already allows `ai → waiting_approval` and `waiting_approval → ai | escalated | human | closed`; the inbox has the "Waiting for approval" view, chip and divider. `human` only goes to `ai | closed` (FEAT-043 left hand-back during a pending approval to this feature). `inbox_queue_auto_close()` skips `closed` and `escalated` only.
- **Escalation** (FEAT-044): `requestEscalation(tx, { source, hours, noticeText })`; FEAT-044 §8 reserved source `approval_sla`.
- **Alerts** (FEAT-052): `notify(tx, { kind: 'approval_pending', subject: { type: 'approval', id } … })`, `cancelNotifications`, `linkFor('approval_pending')` → `/approvals/:id` (FEAT-056 swaps in the signed link). Urgent = within 30 minutes of the SLA (SRS §1.4).
- **Identity** (FEAT-007): capability `approvals.decide`, `canApprove(m)`, `Me.canApprove`; members by right via the memberships table (`approval_rights`).
- **Hours**: tenancy `addBusinessMinutes(hours, openOnPublicHolidays, from, minutes, holidays)` and `openStatus` (FEAT-044 uses both).
- **Cards** (FEAT-049): `messages.card` with the `MessageCard` union (`consent`, `lead_form`), rendered by the widget's `cards.tsx`.
- **Facts**: product facts' `value` is `{ name, priceCents, currency, unit? }` with `gstTreatment`; the turn's retrieved set is `searchVisitorFacts`' result.
- **Dashboard**: `/approvals` is a `Placeholder` naming FEAT-055; the nav and tab bar already have Approvals.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Approvals (APR-02, APR-04, APR-06; FEAT-055 §3)`)

```ts
export const ApprovalKind = z.enum(['quote', 'discount', 'commitment']);
export const ApprovalStatus = z.enum(['pending', 'approved', 'edited_approved', 'rejected', 'expired', 'undeliverable']);
export const ApprovalLine = z.object({
  factId: z.uuid().nullable(),            // null: a line the approver added
  factVersion: z.number().int().nullable(),
  label: z.string().min(1).max(120),
  unit: z.string().max(40).nullable(),
  quantity: z.number().int().min(1).max(100_000),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
}).strict();
export const ApprovalTerms = z.object({
  lines: z.array(ApprovalLine).max(20),
  discountPct: z.number().int().min(0).max(100),
  /** Staff's words to the visitor (delivery date, custom work); sent as written. */
  note: z.string().max(500),
}).strict();
export const ApprovalTotals = z.object({ subtotalCents: z.number().int(), discountCents: z.number().int(), totalCents: z.number().int(), gst: z.enum(['inclusive', 'exclusive', 'none']) });
export const ApprovalSummary = z.object({
  id: z.uuid(), kind: ApprovalKind, status: ApprovalStatus, conversationId: z.uuid(),
  contactName: z.string().nullable(), headline: z.string(),       // "200 × Vanilla cupcake · 15% off"
  totalCents: z.number().int().nullable(), createdAt: z.iso.datetime(),
  slaDueAt: z.iso.datetime(), expiresAt: z.iso.datetime(), urgent: z.boolean(), breached: z.boolean(),
  afterHours: z.boolean(), aboveMaxDiscount: z.boolean(),
});
export const ApprovalList = z.object({ items: z.array(ApprovalSummary), nextCursor: z.string().nullable(), pendingCount: z.number().int() });
export const ApprovalDetail = ApprovalSummary.extend({
  request: z.object({ items: z.string().nullable(), quantity: z.string().nullable(), date: z.string().nullable(), discountPct: z.number().int().nullable() }),
  draft: ApprovalTerms, draftTotals: ApprovalTotals,
  final: ApprovalTerms.nullable(), finalTotals: ApprovalTotals.nullable(),
  prices: z.array(z.object({ factId: z.uuid(), version: z.number().int(), name: z.string(), priceCents: z.number().int(), unit: z.string().nullable(), current: z.boolean() })),
  excerpt: z.array(ThreadMessage).max(10),                          // the latest messages up to the request
  maxDiscountPct: z.number().int(),
  decision: z.object({ by: z.object({ userId: z.uuid(), name: z.string() }), at: z.iso.datetime(), reason: z.string().nullable() }).nullable(),
  version: z.number().int(),
  canDecide: z.boolean(),                                           // Me.canApprove and still pending
});
export const ApprovalDecision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), version: z.number().int() }),
  z.object({ action: z.literal('edit_approve'), version: z.number().int(), terms: ApprovalTerms }),
  z.object({ action: z.literal('reject'), version: z.number().int(), reason: z.string().trim().min(1).max(500) }),
]);
export const AlreadyDecided = z.object({ error: z.literal('already_decided'), approval: ApprovalDetail }); // 409
export const ApprovalSettings = z.object({ slaMinutes: z.number().int().min(15).max(2_880) }); // on BoundaryRules
```

Changed: `MessageCard` gains `z.object({ kind: z.literal('quote'), approvalId: z.uuid(), lines: …, discountPct, totals: ApprovalTotals, note })` (the widget renders it; the message body is the same text for other channels); `NOTICE_KINDS` gain `approval_waiting`, `approval_rejected`, `approval_expired`; `BoundaryRules`/`RulesPayload` gain `approvalSlaMinutes` (default 120) and the rules response gains `approvers: { userId, name, role }[]` (read-only); `ContextSidebar` gains `approval: { id, status, slaDueAt } | null`; `ThreadEvent` gains `approval_drafted`, `approval_decided`, `approval_expired`.

Routes (all `sessionFrom`, tenant from the session):

| Route | Who | Result |
|---|---|---|
| `GET /api/v1/approvals?view=pending\|decided&cursor=` | any member | `ApprovalList`; pending: urgent and breached first, then `sla_due_at`; decided: newest first, 30 days |
| `GET /api/v1/approvals/:id` | any member | `ApprovalDetail`; 404 other tenant |
| `POST /api/v1/approvals/:id/decision` | `approvals.decide` and `canApprove` | 200 `ApprovalDetail`; 403 `forbidden`; 409 `already_decided` (with the current detail); 409 `expired`; 422 `invalid_terms` (`edit_approve` with no lines and no note, or a total below 0) |

No re-auth: deciding isn't in AUTH-03's list. Realtime: the api publishes `{ type: 'approval', id, status }` on `channels.inbox(tenant)`; the dashboard invalidates `['approvals']` and `['approval', id]`.

## 4. Schema changes (migration `0049_approvals.sql`)

- `approvals` (tenant-scoped, forced RLS): `id`, `tenant_id`, `conversation_id` (FK), `kind`, `status` (check, default `pending`), `request jsonb` (triage's `items`/`quantity`/`date` strings, ≤ 200 chars each, and the parsed `discount_pct`), `draft jsonb` (`ApprovalTerms`), `final jsonb null`, `prices jsonb` (fact ID, version, name, price, unit, GST at draft time), `rules_version int null`, `above_max boolean`, `after_hours boolean`, `sla_due_at`, `urgent_at` (`sla_due_at − 30 min`, or the draft time when the SLA is shorter), `expires_at` (`created_at + 7 days`), `escalated_at null`, `decided_by uuid null` (FK users), `decided_at null`, `reason text null`, `delivered_message_id uuid null`, `version int default 1`, `created_at`. Partial unique index `approvals_one_pending_uq (tenant_id, conversation_id) where status = 'pending'` (D4). Index `(tenant_id, status, sla_due_at)`. Check: `decided_by`/`decided_at` set iff status not in (`pending`, `expired`); `reason` required for `rejected`.
- Grants: `app_visitor` insert and select (the draft is made in the visitor turn); `app_dashboard` select and update of `status, final, decided_by, decided_at, reason, delivered_message_id, version` only; the timer role below updates `escalated_at`, `status` (to `expired`), `urgent_at`.
- `boundary_rules.approval_sla_minutes smallint not null default 120` with check 15–2880.
- `approvals_queue_due()` SECURITY DEFINER owned by NOLOGIN `kaki_approvals_timer`, executable by `app_outbox` (the 0045 pattern): for pending approvals with `urgent_at <= now()` (set it null), `sla_due_at <= now() and escalated_at is null` (set `escalated_at`), or `expires_at <= now()`, inserts one `conversation-turns` outbox row per due item, group key = conversation, payload `{ kind: 'approval_timer', tenantId, approvalId, timer: 'urgent' | 'sla' | 'expire' }`.
- `inbox_queue_auto_close()` replaced to skip `waiting_approval` too (D6).
- `NOTIFICATION_KINDS` + `approval_undeliverable` (muted with `approval_pending`, `muteEvent`); `NOTICE_KINDS` + the three notices; `ESCALATION_SOURCES` + `approval_sla`.
- Name in `TENANT_SCOPED_TABLES`; cases in `rls.int.test.ts`.

## 5. Component design

### 5.1 `@kaki/approvals` (`drafts.ts`, `decide.ts`, `timers.ts`, `quote.ts`)

- `quote.ts` (pure): `totalsOf(terms, gst)` in integer cents (subtotal = Σ quantity × unit price; discount = round half up of subtotal × pct / 100; total = subtotal − discount); `quoteText(language, terms, totals)` ("Here's your quote from {business}: 200 × Vanilla cupcake at S$3.50 = S$700.00 … 15% off: −S$105.00 · Total S$595.00 (incl. GST)", then the note), in en and zh, SGD formatting shared with the renderer's formatter; `draftLines(itemsText, quantity, facts)`: the product facts of this turn whose name shares a word (case-insensitive, ≥ 3 letters, CJK by character bigram) with `items`, best match first, at most 3, quantity from `quantity` (an integer 1–100 000, else 1). `kindOf(request, discountPct)`: `discount` when a percentage was asked, else `quote` when any line matched or a quantity was given, else `commitment`.
- `draftApproval(tx, input)`: input `{ tenantId, conversationId, request, facts, rules, rulesVersion, hours, now }`. A pending approval for the conversation → `{ status: 'already_pending', approval }` and nothing else. Otherwise computes `after_hours` and `sla_due_at = addBusinessMinutes(hours, …, now, rules.approvalSlaMinutes)` (no hours saved: plain minutes), inserts the row, `transition(… to: 'waiting_approval', actor: agent)` when the status is `ai` (an `escalated` conversation stays escalated), audits `approval.drafted` (`approvalId`, `kind`, `aboveMax`, `afterHours`, `rulesVersion`; no text or amounts, ADR-014), alerts every approver with `notify(kind 'approval_pending', urgent: sla ≤ 30 min, dedupe `approval:{id}`)`. Returns `{ status: 'drafted', approval }`.
- `decide(tx, { tenantId, approvalId, userId, decision, now })` (`decide.ts`): `select … for update`; status not `pending` → `AlreadyDecided(row)` or `ApprovalExpired`; `version` mismatch → `AlreadyDecided` too (the row changed). Sets status (`approved` with `final = draft`; `edited_approved` with the new terms; `rejected` with the reason), `decided_by`, `decided_at`, `version + 1` with `where status = 'pending' and version = $v` (zero rows → `AlreadyDecided`, so two simultaneous decisions record one, APR-06). Then `deliver` (below), `cancelNotifications(subject approval)`, audit `approval.decided` (`approvalId`, `outcome`, `edited`, `actorId` = approver; the reason stays on the row only, D9).
- `deliver(tx, approval, outcome)`: approved → inbox `appendSystemMessage` with `card: { kind: 'quote', … }` and the `quoteText` body, author `system`, even when the conversation is closed (it doesn't reopen it); rejected → notice `approval_rejected` ("Our team couldn't confirm this one, but they'll follow up with you." / zh). Then, if the conversation is `waiting_approval`, `transition(→ ai)`. **Undeliverable** (UC-22 6a, D7): approved or rejected while the conversation is closed and its contact has neither an email nor a phone (no other channel can reach them): status becomes `undeliverable` (the decision stays in `final`, `decided_*` and the audit), the message is still stored, and `notify(kind 'approval_undeliverable', recipients: approvers + the decider)`.
- `timers.ts` `runApprovalTimer(tx, { approvalId, timer, hours, now })` (agent-worker): reads the row for update, does nothing unless `pending` (a stale timer, ADR-012). `urgent` → `notify(approval_pending, urgent: true, dedupe approval:{id}:urgent)`. `sla` → `requestEscalation(source 'approval_sla', no notice: the visitor already has the expected time)`; `with_person` is fine. `expire` → status `expired`, notice `approval_expired` ("Sorry for the wait. Our team will contact you about this request." / zh), `→ ai` if `waiting_approval`, `cancelNotifications`, audit `approval.expired`.
- Queries: `listApprovals(tx, view, cursor)`, `approvalDetail(tx, id)` (prices' `current` = the fact's version is still the visitor-visible one), `pendingApprovalOf(tx, conversationId)` for the sidebar, `approvers(tx, tenantId)` (owners, admins, agents with rights, active).
- `rules.ts`: `approvalSlaMinutes` joins `BoundaryRules`, `SAFE_DEFAULTS` (120), `normaliseRules`, `changedFields` (`approval_sla`); `commitmentDecision` returns `needs_approval` above the maximum (D1) and reports `aboveMax`.

### 5.2 Agent (`request_commitment`, ADR-025)

- `approval.ts`: `requestCommitmentHandler` (kind `request_commitment`, tool `draft_approval`, scopes `['visitor']`, args `{ items?, quantity?, date?, discount? }` strings/numbers, `.catch({})`-free: invalid args are refused). `checkBoundary` is `commitmentDecision(...) !== 'refuse'` (always true after D1, kept as the ADR-025 hook). `run` calls `ctx.conversation.draftApproval(args)`; when `commitmentDecision` says `allowed` (quotes don't need approval, discount within the maximum, at least one matched line, no `date` and no free request: D3) the port sends the quote at once instead, as an `approved` row decided by no one (`decided_by` null, audit `approval.auto`). Returns `{ approval: { status, slaDueAt, afterHours } }`.
- `ConversationPort.draftApproval(args)`: the worker implements it with approvals `draftApproval` in one transaction on the visitor zone, passing this turn's retrieved facts and the rules in force; tests and evals keep it in memory.
- Turn: like an escalation (FEAT-044 §5.4). A commitment-only plan stores the waiting notice as the reply with no reply-model call: "Thanks! Our team is checking this and will reply by {2:30 pm today}." / after hours "…will reply on the next business day, {Monday 9:00 am}." (`approvalNotice(language, afterHours, dueAt, now)` in `texts.ts`; the time is rendered, never model-written, ADR-025 d5). With `answer` tasks too, the answer is composed as usual and the notice is stored after it as a `approval_waiting` system notice. `already_pending` says "Our team is still checking your earlier request and will reply by {time}." `agent.decision` records `approval: drafted | already_pending | auto`.
- Composer: unchanged. The quote reaches the visitor only through `deliver` (code-built from the approver's values), so FEAT-054's always-on discount guard stays as it is (D2) and nothing from `draft_approval` is ever streamed (AGT-06).
- Coaching and replay: `request_commitment` isn't in their registries; the coaching answer says "A visitor would get: the team is checking your request" via `VisitorsWouldGet` (no draft written).

### 5.3 Inbox

- `TRANSITIONS.human` gains `waiting_approval`: `handBack` lands in `waiting_approval` when the conversation has a pending approval (D5), `ai` otherwise. Approval decided while `human` or `escalated`: the status stays.
- The sidebar's `approval` comes from the api (`pendingApprovalOf`), not from inbox (inbox never imports approvals). Thread dividers read the three audit actions.
- New `appendSystemMessage(tx, { tenantId, conversationId, body, card })` beside `appendSystemNotice`: stores without reopening a closed conversation; the api publishes it after commit.

### 5.4 Workers and API

- Scheduler: `approval-timers.ts` `approvalTimersOnce` every `APPROVAL_SWEEP_MS` (default 30 000) calling `approvals_queue_due()`. Agent-worker: `TurnJob` handles `approval_timer` with `runApprovalTimer` and publishes notices.
- API `apps/api/src/approvals.ts` `registerApprovalRoutes`; `rules.ts` route reads/writes `approvalSlaMinutes` and returns `approvers`; the inbox sidebar adds `approval`.

### 5.5 Widget

- `cards.tsx` `QuoteCard`: lines (label, "200 × S$3.50", amount), discount row, total with the GST note, the note text; read-only. The `approval_waiting/rejected/expired` notices use the existing `system-notice`.

### 5.6 Dashboard

- `pages/approvals.tsx` (SCR-APP-017, `/approvals`), `pages/approval.tsx` (SCR-APP-018, `/approvals/:id`), parts in `pages/approval-parts.tsx`; data and pure helpers in `lib/approvals.ts` (`slaChip`, `termsError`, `totalsOf` re-exported from a Zod-free `@kaki/contracts/quote` entry shared with approvals, `decisionText`). Nav badge = `pendingCount` (pending-soft). Rules page: SLA field and the approvers list. Inbox sidebar: Approval section with a link.

### 5.7 Evals and seed

- `evals/cases/feat-055-approvals.json`: ≥ 20 cases: quote, discount, delivery promise, mixed price question + quote (answer + notice), Chinese and Singlish requests, a repeat while pending, after hours; each asserts no price total or discount in model text and the `request_commitment` dispatch. Seed: none (dev tenants run on the safe defaults: quotes need approval).

## 6. Acceptance criteria

- **AC-1** (APR-02 "the AI drafts a quote, discount or commitment → it appears in the queue with the conversation context and the KB prices used"; UC-22 2–3; AGT-06) A visitor turn whose plan has `request_commitment` writes one pending approval with the request, draft lines from this turn's product facts, the price snapshot and the rules version; the conversation moves to `waiting_approval`; `approval.drafted` and `agent.dispatch` (`tool: draft_approval`, `done`) are audited with no text or amounts. `GET /approvals/:id` returns the excerpt, the prices used and the draft totals.
- **AC-2** (APR-02 "nothing is sent before a decision"; AGT-06 "`draft_approval` never sends to the visitor before approval") Until a decision, the conversation has no quote card and no model-written total or discount (the eval set asserts it; FEAT-054's guard still blocks offers); the visitor gets only the waiting notice.
- **AC-3** (APR-04 "tells the visitor the team is checking and gives an expected response time"; "a request made after hours … next business day"; UC-22 3, 3a) The notice names `sla_due_at` rendered in SGT; after hours it says the next business day with the opening time. A commitment-only turn makes no reply-model call.
- **AC-4** (APR-04 "the SLA counts business hours only", "configurable, default 2 business hours") `sla_due_at` is `addBusinessMinutes` from the request with the tenant's SLA (120 by default; 15–2880 accepted on the rules page, audited by `rules.updated` with `approval_sla`); no hours saved → plain minutes.
- **AC-5** (APR-02 approver actions; UC-22 5, 5a) An approver can approve, edit and approve (lines, quantities, prices, discount, note) or reject with a required reason; an Agent without rights gets 403 and sees actions disabled; each decision is audited `approval.decided` with the approver and time.
- **AC-6** (APR-02 "the result is sent to the visitor"; APR-06 "delivered on the conversation's latest channel even if the conversation has closed"; UC-22 6) An approval stores a quote card whose totals match `totalsOf(final)`, and a rejection the follow-up notice, in the same transaction as the decision, also on a closed conversation (which stays closed), and publishes them; `waiting_approval` returns to `ai`.
- **AC-7** (APR-06 "two simultaneous decisions result in exactly one recorded decision"; UC-22 5c) Two concurrent decisions on the same version: one 200, one 409 `already_decided` naming the first decider; one `approval.decided`; one delivered message.
- **AC-8** (APR-04 "no decision within the SLA → the conversation is escalated"; UC-22 5d) At `sla_due_at` a pending approval escalates through `requestEscalation` (`approval_sla`, routed and alerted as FEAT-044); at `urgent_at` approvers get one urgent alert; a decided approval's timers do nothing.
- **AC-9** (APR-06 "expires after 7 days and the visitor is told", "an expired approval can no longer be sent"; UC-22 5d) After 7 days a pending approval becomes `expired`, the visitor gets the expiry notice, alerts are cancelled, and a later decision is 409 `expired`.
- **AC-10** (UC-22 6a; ADR-013 d4) A decision on a closed conversation whose contact has no email or phone marks the approval `undeliverable` and alerts the approvers and the decider.
- **AC-11** (D1, D3, D4, D5, D6) Above-maximum discounts are drafted with `aboveMax`; `allowed` requests are sent at once and audited `approval.auto`; a second request while one is pending drafts nothing and says so; hand-back during a pending approval returns to `waiting_approval`; auto-close skips `waiting_approval`.
- **AC-12** (ADR-005, ADR-014) Tenant B can't list, read or decide tenant A's approvals (404); `app_visitor` can't update an approval; no audit payload carries request text, amounts or the reason.
- **AC-13** (screens) SCR-APP-017, SCR-APP-018, SCR-APP-042's approvals block, the widget's quote card and notices, and the sidebar section render each state in ui-design.md, pass axe at desktop and phone width (tall viewport), and work by keyboard.

## 7. Decisions

- **D1 — A discount above the maximum goes to approval, flagged (pending Ken's card).** UC-22's precondition names "the discount exceeds the maximum" as a reason for approval, which FEAT-054's `refuse` contradicts. The draft carries `aboveMax`, the queue and detail say "Above your 10% maximum", and the approver decides. If Ken picks "refuse", `commitmentDecision` keeps `refuse`, the handler is refused `boundary` and the turn stores a fixed "we can't offer that discount; the team can tell you about our prices" reply: tasks T3 and T4 change only there.
- **D2 — Quotes are built in code, not by a model.** The draft's lines come from this turn's retrieved product facts matched to triage's `items`, totals are integer arithmetic (ADR-008: totals go into `draft_approval` quotes, computed in code), and the delivered text is a fixed template with the approver's values. No extra model call (cost, and nothing to verify). The approver fixes a wrong match. FEAT-054 D4's guard stays: model text never offers a discount; the approved quote doesn't pass through the composer.
- **D3 — `allowed` sends at once, but only a plain quote.** When the owner turned quote approval off and the discount is within the maximum, a request whose lines all matched and that names no date or free commitment is sent immediately as an approved quote with no decider. Anything else (no match, a date, a custom request) is a `commitment` and always drafted, because AGT-06 forbids an irreversible commitment without approval.
- **D4 — One pending approval per conversation.** A partial unique index; a second request while one is pending tells the visitor the team is still checking. Staff can add to the pending draft by editing it. Keeps the queue one row per conversation and the state machine simple.
- **D5 — Hand-back returns to `waiting_approval`** when an approval is pending (FEAT-043 §8): the inbox view and chip stay right. New edge `human → waiting_approval`.
- **D6 — Auto-close skips `waiting_approval`** (as FEAT-044 D5 did for `escalated`): a pending request isn't silently closed after 30 minutes; it ends by decision, staff close or expiry, after which auto-close applies again.
- **D7 — Undeliverable = closed, and no other channel.** Today only the widget delivers; the message is always stored (a returning visitor sees it). A closed conversation whose contact has no email or phone has no route to the visitor, so staff are told. FEAT-036+ add channel delivery through the outbox and adapters (ADR-011) and refine this.
- **D8 — Agents without rights see the queue read-only** (design.md §635: show controls disabled with "Ask the Owner for approval rights"); the decision route enforces it.
- **D9 — The reason stays on the row.** A rejection reason is staff text about the request, not a visitor's personal data, but it can name the visitor; it is never in the audit chain (ADR-014), only on the tenant-scoped row, which tenant deletion removes.
- **D10 — Timers are columns plus one sweep**, as the codebase does for escalations (0045), not a generic `timers` table: the due columns are the timer, the sweep marks and queues in one statement, and the worker re-checks `pending` (ADR-012's stale-timer rule).

## 8. Escalations and open items

- D1 waits for Ken's answer (decision card); the design follows the recommended option until then.
- FEAT-056: signed single-use link in the alert (`linkFor('approval_pending')`), link-expired and reused states on SCR-APP-018. FEAT-066: approval analytics (APR-05) from `approvals` rows. FEAT-036+: delivery on email/Telegram/Meta through the outbox. FEAT-048/037: push and Telegram alerts.
- Architecture §6.2 shows "lead + consent" in the draft transaction; the lead stays FEAT-049's flow (consent first), so a draft doesn't create a lead. Noted here, not an amendment.

## 9. Self-check

Traceability: APR-02 → AC-1, AC-2, AC-5, AC-6; APR-04 → AC-3, AC-4, AC-8; APR-06 → AC-6, AC-7, AC-9; AGT-06 (p) → AC-1, AC-2; UC-22 2, 3 → AC-1, 3a → AC-3, 5 → AC-5, 5a → AC-5, AC-6, 5c → AC-7, 5d → AC-8, AC-9, 6 → AC-6, 6a → AC-10; ADR-005/014 → AC-12; ADR-012 → AC-8, D10; ADR-013 → AC-7, AC-10; ADR-025 → §5.2. IDs checked: APR-01..06, AGT-06, AUTH-03, INB-05, INB-08, UC-22, SCR-APP-014, SCR-APP-017, SCR-APP-018, SCR-APP-042, SCR-WGT-002, ADR-005, ADR-008, ADR-012, ADR-013, ADR-014, ADR-025, FEAT-036, FEAT-037, FEAT-043, FEAT-044, FEAT-048, FEAT-049, FEAT-052, FEAT-054, FEAT-056, FEAT-066 resolve.
