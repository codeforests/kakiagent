# Technical design: FEAT-050 — Leads list, pipeline, scoring and CSV export

> Implements: LED-03, LED-05 (p: the withdrawn-consent exclusion lands with FEAT-051), LED-08 (completes it: the CSV shows the marketing flag, its time and the Do Not Call reminder), LED-04 (p: the hot-lead alert; Telegram FEAT-037, push FEAT-048), AUTH-03 (p: "export leads" re-auth), LED-02 (p: consent records shown on the lead; added at M4 close to match the RTM Test ref) · Realizes: UC-21 steps 5 (score) and 6 with 6a (hot-lead alert), UC-24 (p: the leads CSV, D1; the tenant export is FEAT-062) · Screens: SCR-APP-032 (new), SCR-APP-033 (new; consent withdrawn FEAT-051), SCR-APP-043 (p: qualification criteria), SCR-APP-014 (p: score in the sidebar's Lead section) (see [ui-design.md](ui-design.md)) · Module: `leads`, architecture §5.2, ADR-005, ADR-008, ADR-012, ADR-014, ADR-015, ADR-020, ADR-025
> Status: designed · 2026-11-06

## 1. Intent

The team sees every lead in one place: the ones the assistant captured in chat and the ones left on the paused or not-live contact form (FEAT-049 D9). Each lead has a score (hot, warm or cold) with the reasons that produced it, computed in code from criteria the owner sets (keywords in what the visitor needs, a minimum budget) plus fixed intent signals (asked for a quote or to order, gave both phone and email, said when, came back). A new hot lead alerts the team within a minute through FEAT-052's alerts, held in quiet hours. Owners and Admins move leads through New → Contacted → Won / Lost and export the list as CSV after re-authenticating; the export is audited and carries the marketing-consent flag with its time and the Do Not Call reminder. Agents see the list and each lead, read only.

## 2. Codebase context

- **Leads** (`packages/leads`, FEAT-049): `contacts`, `consents` (append-only, purpose `enquiry` | `marketing`, decision `agreed` | `declined`, `wording_id`), `leads` (status `new` | `contacted` | `won` | `lost`, `need`, `budget`, `preferred_time` as free text, `captures`, `conversation_id` null for the contact form, `leads_one_open_uq`), `lead_settings` (`version`, `fields`, marketing). `captureLead` (`capture.ts`) runs in the **visitor zone** (`apps/api/src/leads-widget.ts`), upserts the open lead and audits `lead.created` / `lead.updated`. `views.ts` has `contactOf`, `leadSummaryOf` for the inbox sidebar. `settings.ts` `getLeadSettings` / `saveLeadSettings` (compare-and-set on `version`, audit `settings.lead_fields_updated`), F&B defaults from tenancy `INDUSTRY_TEMPLATES`.
- **Alerts** (`@kaki/platform/notifications`, FEAT-052): `notify(tx, { tenantId, kind, recipients, urgent, subject, dedupeKey })` in the producer's transaction; kind `hot_lead` and subject type `lead` already exist, `linkFor('hot_lead')` already points at `/leads/:id`; members toggle `hot_lead` on My notifications; quiet hours and digest apply at send time. The visitor zone reads member IDs through `escalation_candidates()` (0045; granted to `app_agent_visitor` and `app_dashboard`).
- **Intent signals**: `messages.task_kinds` per AI turn; inbox `INTENT_OF_TASK` maps `request_commitment` → `wants_to_order`. Leads reads `task_kinds` itself (never imports inbox).
- **Re-auth** (FEAT-006): `requireReauth(s)` after the capability check → 403 `reauth_required`; the dashboard's `useReauthGuard().guard(fn)` re-runs the call once.
- **Capabilities** (`identity/capabilities.ts`): no leads capability yet; Agents have `inbox.read` only.
- **Dashboard**: `/leads` is a placeholder naming FEAT-050; the nav item exists. Lead settings page `pages/leads-settings.tsx` + `leads-settings-parts.tsx` (one Save). The inbox `ContextSidebar` Lead section shows status and consent (`LeadSummary`).
- **Schema**: latest migration `0050`. No score columns; `lead_settings` has no qualification block.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: leads (LED-03, LED-05, LED-08; FEAT-050 §3)`)

```ts
export const LeadScore = z.enum(['hot', 'warm', 'cold']);
/** Why a lead scored as it did; the dashboard words each code (ui-design). */
export const ScoreReasonCode = z.enum([
  'keyword', 'budget_met', 'budget_below', 'wants_to_order', 'both_contacts', 'need_given', 'timing_given', 'returning',
]);
export const ScoreReason = z.object({
  code: ScoreReasonCode,
  points: z.number().int(),
  /** The matched keyword or the minimum budget in whole S$; null for the rest. */
  detail: z.string().max(80).nullable(),
});
export const LeadScoring = z.object({
  score: LeadScore, points: z.number().int(), reasons: z.array(ScoreReason),
  at: z.iso.datetime({ offset: true }),
}).nullable(); // null: captured before FEAT-050 and not rescored yet

/** Owner-set criteria (SCR-APP-043). Keywords trimmed, case-folded, unique, 1–40 chars. */
export const Qualification = z.object({
  keywords: z.array(z.string().trim().min(1).max(40)).max(20),
  /** Whole S$, 1–10,000,000; null = no budget criterion. */
  minBudget: z.number().int().min(1).max(10_000_000).nullable(),
});
// LeadSettings gains `qualification: Qualification`; LeadSettingsBody gains it too (strict).

export const LeadSource = z.enum(['chat', 'contact_form']); // conversation_id present or not at capture
export const LeadMarketing = z.object({ agreed: z.boolean(), at: z.iso.datetime({ offset: true }) }).nullable(); // null = not asked

export const LeadRow = z.object({
  id: z.uuid(), version: z.number().int().min(1),
  name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable(), // phone formatted +65 9123 4567
  need: z.string().nullable(), // first 120 chars
  status: LeadStatus, scoring: LeadScoring, source: LeadSource, marketing: LeadMarketing,
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
});
export const LeadsQuery = z.object({
  status: z.enum(['open', 'new', 'contacted', 'won', 'lost', 'all']).default('open'),
  score: LeadScore.optional(),
  cursor: z.string().max(200).optional(), // opaque keyset (updated_at, id)
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const LeadList = z.object({
  items: z.array(LeadRow), nextCursor: z.string().nullable(),
  counts: z.record(LeadStatus, z.number().int().min(0)), // all four, ignoring the score filter
});

export const LeadConsentRecord = z.object({
  id: z.uuid(), purpose: z.enum(['enquiry', 'marketing']), decision: z.enum(['agreed', 'declined']),
  at: z.iso.datetime({ offset: true }), channel: z.enum(['widget']), conversationId: z.uuid().nullable(),
  wording: z.object({ id: z.uuid(), version: z.number().int(), text: z.string() }), // the exact text shown, in the language shown
});
export const LeadDetail = LeadRow.extend({
  need: z.string().nullable(), // full text
  budget: z.string().nullable(), preferredTime: z.string().nullable(), captures: z.number().int().min(1),
  contactId: z.uuid(),
  consents: z.array(LeadConsentRecord), // newest first, every consent row of the contact
  conversations: z.array(z.object({ id: z.uuid(), status: ConversationStatus, startedAt: z.iso.datetime({ offset: true }), lastMessageAt: z.iso.datetime({ offset: true }) })), // the contact's, newest first, max 20
  canManage: z.boolean(), canExport: z.boolean(),
});
export const LeadStatusBody = z.strictObject({ status: LeadStatus, version: z.number().int().min(1) });
export const LeadConflict409 = z.object({ error: z.enum(['stale', 'open_lead_exists']), lead: LeadRow.optional() });
export const LeadExportBody = z.strictObject({ status: LeadsQuery.shape.status, score: LeadScore.optional() });
// LeadSummary (inbox sidebar) gains `scoring: LeadScoring`.
```

| Route | Who | Answers |
|---|---|---|
| `GET /api/v1/leads?status&score&cursor&limit` | `inbox.read` (all roles) | `LeadList`, newest `updated_at` first |
| `GET /api/v1/leads/:id` | `inbox.read` | `LeadDetail`; 404 unknown or other tenant |
| `POST /api/v1/leads/:id/status` | `leads.manage` (Owner, Admin) | 200 `LeadRow`; 403; 409 `stale` (with the current row) or `open_lead_exists` (reopening a won/lost lead while the contact has another open one); same status → 200 no audit |
| `POST /api/v1/leads/export` | `leads.export` (Owner, Admin) + re-auth | 200 `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="leads-YYYY-MM-DD.csv"`, `Cache-Control: no-store`; 403 `reauth_required`; 413 `too_many` above 10,000 rows (D1) |
| `GET`/`PUT /api/v1/settings/leads` | as FEAT-049 | now with `qualification`; a changed qualification rescores open leads in the same transaction (§5.2) and the response says `rescored: n` |

The tenant ID always comes from the session (ADR-005). Export filters travel in the body, never personal data in a URL.

## 4. Schema changes (migration `0051_lead_scoring.sql`)

- **`leads`** gains `score` text null (check `hot` | `warm` | `cold`), `score_points` int null, `score_reasons` jsonb null (array, check `jsonb_typeof = 'array'`), `scored_at` timestamptz null, `hot_alerted_at` timestamptz null, `version` int not null default 1, `status_changed_at` timestamptz null. Check: `score`, `score_points`, `score_reasons`, `scored_at` all null or all set. Index `leads_tenant_status_updated_idx` on `(tenant_id, status, updated_at desc, id)`.
- **`lead_settings`** gains `qualification` jsonb not null default `'{"keywords":[],"minBudget":null}'` (check `jsonb_typeof = 'object'`).
- **Grants**: `app_agent_visitor` (the visitor zone's role) gains `update (score, score_points, score_reasons, scored_at, hot_alerted_at)` on `leads`. It reads the contact's other conversations' `task_kinds` only if its policies already allow that; T1 checks, and if not, a SECURITY DEFINER `lead_intents(contact uuid)` owned by a NOLOGIN role returns only those task kinds and the conversation count (the 0045 pattern); `app_dashboard` gains `update (status, version, status_changed_at, updated_at, score, score_points, score_reasons, scored_at)` on `leads`. Nobody gains delete. `app_dashboard` already reads `contacts`, `consents`, `wording_versions`, `conversations`.
- No new table, so `TENANT_SCOPED_TABLES` is unchanged; `rls.int.test.ts` gains cases for the new grants (visitor can't update `status`; dashboard can't update `need` or `contact_id`; tenant B can't update tenant A's score).
- `scripts`/Drizzle: `schema.ts` mirrors the columns; `LEAD_SCORES`, `SCORE_REASON_CODES` constants beside `LEAD_STATUSES`.

## 5. Component design

### 5.1 Scoring (`leads/score.ts`, pure; LED-03, D2)

`scoreLead(input, q: Qualification): { score, points, reasons }` where `input = { need, budget, preferredTime, hasPhone, hasEmail, wantsToOrder, returning }`. Points, in this reason order:

| Code | Points | When |
|---|---|---|
| `keyword` | +2 (once) | `need` contains an owner keyword (case-folded; NFKC; CJK by substring, Latin on word boundaries); `detail` = the first keyword matched |
| `budget_met` / `budget_below` | +2 / 0 | `minBudget` set and `parseBudget(budget)` ≥ / < it; `detail` = the minimum. No reason when no criterion or no parseable amount |
| `wants_to_order` | +2 | any AI turn in the contact's conversations had `request_commitment` |
| `both_contacts` | +1 | phone and email both given |
| `need_given` | +1 | `need` non-empty |
| `timing_given` | +1 | `preferredTime` non-empty |
| `returning` | +1 | `captures > 1` or the contact has more than one conversation |

Band: **hot ≥ 5, warm 3–4, cold ≤ 2** (fixed, D2). `parseBudget`: the largest amount in the text, digits with `,` or `.`, optional `S$`/`$`/`SGD`, `k` ×1,000, `万` ×10,000; nothing parseable → null. Unit-tested as a table (EN, Singlish "abt 2k", ZH "预算3000"). The model is never involved (ADR-008, ADR-025).

### 5.2 When a lead is scored

- **Capture** (`captureLead`, visitor zone): after the upsert, `rescore(tx, leadId)` loads the lead, contact, settings and intent facts and writes the four score columns. If the lead is now `hot` and `hot_alerted_at` is null: `notify(tx, { kind: 'hot_lead', subject: { type: 'lead', id }, recipients: escalation_candidates() user IDs, urgent: false, dedupeKey: 'hot_lead:<leadId>' })` and set `hot_alerted_at` (D3). One alert per lead, ever; a won/lost lead reopened later doesn't alert again. Audit `lead.scored` (lead ID, score, codes; no PII, ADR-014) only when the band changes.
- **Criteria saved** (`saveLeadSettings`, dashboard zone): when `qualification` changed, rescore every open (`new`, `contacted`) lead of the tenant in the same transaction (an SME has hundreds, not millions; capped at 5,000 rows, the rest keep the old score until their next capture, recorded in §8), audit `settings.lead_fields_updated` with code `qualification` and `{ rescored }`. A rescore here **never alerts** (an owner tuning criteria would otherwise flood the team, D3).
- Won/lost leads keep the score they had. Leads from before FEAT-050 show "Not scored" until either event.

### 5.3 List, detail, status (`leads/views.ts`, `leads/status.ts`)

- `listLeads(tx, tenantId, query)`: one query joining `contacts` and the lead's marketing consent (the newest `marketing` row of the contact), keyset on `(updated_at desc, id desc)`; `counts` by status in a second query. `open` = `new` + `contacted`.
- `leadDetail(tx, tenantId, id)`: lead + contact; every consent of the contact with its wording (`wording_versions` text in the language shown: the consent row keeps the wording ID, and the conversation's language picks `en` or `zh`, contact form `en`); the contact's conversations.
- `setLeadStatus(tx, { tenantId, leadId, status, version, userId })`: compare-and-set `where version = $v`; `version + 1`, `status_changed_at`, `updated_at`; unique violation on `leads_one_open_uq` → `OpenLeadExists`; audit `lead.status_changed` (`{ from, to }`, actor user). Any move is allowed (New ↔ Contacted ↔ Won/Lost); the pipeline order is the UI's, not a rule (D4).

### 5.4 Export (`leads/export.ts`; LED-05, LED-08, D1)

- `exportLeads(tx, tenantId, filters)` → rows (same filters as the list; hard cap 10,000, above it `TooManyRows`); **`exportable(...)`** is the one predicate FEAT-051 extends with "no withdrawn consent" (today every lead passes; §8).
- `leadsCsv(rows, now)` (pure): UTF-8 with BOM (Excel shows Chinese), CRLF, RFC 4180 quoting; every cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` (CSV injection). Line 1 is the reminder as one cell: `Reminder: the Do Not Call Registry applies before you call or text anyone for marketing. Marketing consent is in the "Marketing consent" columns.` Line 2 the header: `Created (SGT), Updated (SGT), Status, Score, Score reasons, Name, Email, Phone, What they need, Budget, Preferred date or time, Enquiry consent at (SGT), Marketing consent, Marketing consent at (SGT), Source`. Dates `18 Nov 2026 14:05`; marketing `Yes` / `No` / `Not asked`; source `Chat` / `Contact form`; reasons as the dashboard's short words joined by `; `.
- The route: capability → `requireReauth` → one dashboard transaction that reads, writes the audit entry `lead.exported` (`{ count, filters }`, no PII) and returns the CSV body. The export is audited even when it has zero rows.

### 5.5 API (`apps/api/src/leads.ts`)

`registerLeadRoutes(app, deps, sessionFrom)` beside the settings routes: the four routes of §3, Zod-validated, errors mapped (`stale`, `open_lead_exists`, `too_many`). Identity gains capabilities `leads.manage` and `leads.export` (Owner, Admin). The inbox sidebar's `leadSummaryOf` adds `scoring`.

### 5.6 Dashboard

`pages/leads.tsx` (SCR-APP-032, `/leads`), `pages/lead.tsx` (SCR-APP-033, `/leads/:leadId`), parts in `pages/leads-parts.tsx` (`ScoreChip`, `StatusChip`, `MarketingFlag`, `ExportDialog`, `StatusMenu`); helpers in `lib/leads.ts` (`useLeads` infinite query, `useLead`, `reasonText`, `scoreLabel`, `leadsQueryOf` URL ↔ filters, `exportFileName`); the export calls `api.exportLeads` through `useReauthGuard().guard` and saves the blob with a temporary object URL. SCR-APP-043 gains the Qualification card in `leads-settings-parts.tsx` (`KeywordListEditor` reusing rules' `TopicListEditor` pattern). Inbox `ContextSidebar` Lead section shows the score chip and "Open lead".

### 5.7 Seed and evals

- `seed`: Kaki Bakery gets four contact-form leads (no conversation, so no inbox list or search change; memory lesson from FEAT-049): one hot (wedding cake keyword, budget, both contacts), one warm, one cold, one won; and qualification `{ keywords: ['wedding', 'corporate', 'event', '婚礼'], minBudget: 300 }`. The second tenant has no leads (empty state).
- Evals: none. Nothing here calls a model.

## 6. Acceptance criteria

- **AC-1** (LED-03 "score (hot / warm / cold) using tenant-configurable criteria plus intent signals") `scoreLead` gives the table's points and bands for keywords, budget met/below, `wants_to_order`, both contacts, need, timing and returning; changing keywords or minimum budget changes the score of a matching open lead on save; won/lost leads are not rescored.
- **AC-2** (LED-03 "score and reasons are visible on the lead"; UC-21 5) A captured lead has a score, points and reasons immediately; `GET /leads/:id` returns them; SCR-APP-033 shows the chip and every reason in words; the list shows the chip.
- **AC-3** (LED-04 hot lead; UC-21 6, 6a) A capture that makes a lead hot writes one `hot_lead` notification per active member in the capture's transaction, deduped on the lead; a second capture, a rescore on criteria save, and a reopen don't alert again; quiet hours hold it (FEAT-052 behaviour, asserted through the held status).
- **AC-4** (LED-05 "leads list with status pipeline (New → Contacted → Won / Lost)") The list shows chat and contact-form leads (FEAT-049 D9) with status tabs and counts, score filter and "Load more"; Owner/Admin change status with compare-and-set; stale → 409 with the current row; reopening while another lead is open → 409 `open_lead_exists`; each change is audited `lead.status_changed`; Agents get 403 and see no controls.
- **AC-5** (LED-05 "CSV export … recorded in the audit log"; AUTH-03; UC-24 1, 2, 4) Export needs `leads.export` and a fresh re-auth (403 `reauth_required` otherwise); a successful export audits `lead.exported` with the count and filters and no personal data; Agents get 403.
- **AC-6** (LED-08 "the lead and its CSV export show the marketing-consent flag and its timestamp. The export includes a reminder that the Do Not Call Registry applies") The CSV's first line is the reminder; every row has Marketing consent `Yes`/`No`/`Not asked` and its SGT time; the lead page and list show the same flag.
- **AC-7** (CSV safety) Cells starting `=`, `+`, `-`, `@` are prefixed; quotes, commas, newlines and Chinese round-trip through a CSV parser; above 10,000 rows → 413 and no audit entry.
- **AC-8** (LED-02 "consent recorded with a timestamp and the wording used", shown on the lead) SCR-APP-033 lists every consent record of the contact with purpose, decision, time and the exact wording text and version.
- **AC-9** (GOV-03, ADR-005) Tenant B gets 404 for tenant A's lead, an empty list, and can't export or change tenant A's leads; the visitor zone can't change `status`; the dashboard zone can't change captured fields.

## 7. Decisions

- **D1 — Leads CSV is a direct download after re-auth (Ken, 2026-11-06).** UC-24 step 3 describes a background build and a 24-hour link for exports. For the leads CSV alone the design downloads it in the response: an SME's leads fit well under the 10,000-row cap, it is instant, and no copy of personal data sits in S3. The tenant data export (UC-24, FEAT-062) keeps the link.
- **D2 — Fixed points and bands, owner-set keywords and minimum budget.** LED-03's "tenant-configurable criteria" are the two things an owner knows (what a good enquiry mentions, what spend is worth chasing); the intent signals and the bands are the platform's so scores mean the same across tenants and need no tuning. Budget and timing are free text (FEAT-049), so only budget is parsed, deterministically.
- **D3 — One hot-lead alert per lead, on capture only.** Rescoring after a criteria change never alerts; a reopened lead doesn't alert again. Recipients are all active members (`escalation_candidates()`); each member's `hot_lead` preference and quiet hours decide delivery (FEAT-052 D3).
- **D4 — Any status move is allowed, Owner and Admin only.** The pipeline is New → Contacted → Won / Lost as shown, but mistakes need undoing, so any move is a compare-and-set. "Agent: view only" (ux-foundations SCR-APP-032) means Agents can't move or export.
- **D5 — A list with status tabs, no board.** SCR-APP-032 allows "a list or columns"; one list with tabs works at phone width and with keyboard and screen readers; columns can come later without a contract change.
- **D6 — No live updates on the list.** It refetches on focus and after a change; new leads aren't time-critical in the list because the hot-lead alert covers urgency.

## 8. Escalations and open items

- LED-05's "withdrawn consent excluded from exports" and LED-07's "consent withdrawn" state on SCR-APP-033 are FEAT-051's (`exportable()` in §5.4 is the seam); LED-05's Test ref stays partial until then.
- UC-24 step 3 deviation for the leads CSV (D1) is Ken's decision of 2026-11-06.
- Criteria-save rescoring caps at 5,000 open leads per save; beyond that the rest keep their score until their next capture (noted in the toast count).
- FEAT-049 verify note (F&B "Date needed" label not carried in the widget config) is not part of this feature: the dashboard labels the field "Preferred date or time" everywhere; left in pending-actions.
- The score uses only `messages.task_kinds`; richer intent (pages viewed, dwell) waits for the intent data of INB-04's later work.

## 9. Self-check

- LED-03 → AC-1, AC-2; LED-04 (hot lead) → AC-3; LED-05 → AC-4, AC-5 (withdrawn exclusion: FEAT-051); LED-08 → AC-6; AUTH-03 export → AC-5; LED-02 display → AC-8; GOV-03 → AC-9; UC-21 5, 6, 6a → AC-2, AC-3.
- No new table; new columns have column-level grants per zone; tenant from the session or widget token only; RLS cases added (ADR-005).
- Audit entries carry IDs, codes and counts only; the CSV is never stored (ADR-014, ADR-015).
- Scoring and the CSV are code, not model output (ADR-008, ADR-025). The alert is written in the capture's transaction through `notify` (ADR-012).
- UI uses design.md `table`/`list`, `tabs`, `chip`, `menu`, `confirm-dialog`, `reauth-dialog`, `pagination`, `empty-state`, `error-state`, `card`, `toast`; tokens only; sensitive-action pattern §4.10 for export.
