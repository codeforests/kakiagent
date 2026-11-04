# Technical design: FEAT-049 — Consent and lead capture

> Implements: LED-01, LED-02, LED-08, LED-09, AGT-06 (p: `capture_lead`), INB-11 (completes it: contact name, email and phone join conversation search, FEAT-046 D1), GOV-08 (completes "with lead capture": the paused widget's contact form, FEAT-057 D6) · Realizes: UC-21 steps 1–5 with 2a, 2b, 4a (scoring in step 5 and the hot-lead alert in step 6 are FEAT-050) · Screens: SCR-WGT-003 (new), SCR-WGT-005 (p: contact form), SCR-APP-043 (p: lead fields, marketing wording; qualification FEAT-050, webhooks FEAT-053), SCR-APP-014 (p: sidebar contact and lead, dividers, contact search hits) (see [ui-design.md](ui-design.md)) · Module: `leads` (`captureLead`), architecture §5.2, ADR-005, ADR-008, ADR-009, ADR-011, ADR-014, ADR-015, ADR-025
> Status: designed · 2026-11-04

## 1. Intent

A visitor who wants the business to get back to them can leave their details in the chat, and only after agreeing to the business's purpose statement. The agent offers this when the visitor gives or offers contact details, or when it can't help (out of scope, unsure, after hours, AI unavailable). The widget shows a consent card (purpose statement, privacy link, a separate unchecked marketing opt-in when the business asks for one), then a short form with the fields the business chose, validated for SG phone and email. Submitting creates the visitor's contact and lead, or updates their open lead when they come back (LED-09). Every lead names its consent record, with the exact wording shown and the time (LED-02). When the widget is paused or not live yet, the same consent-plus-form is a contact form on the fallback screen. Staff see the contact, the lead and the consent in the conversation sidebar and can search by the contact's name, email or phone.

## 2. Codebase context

- **Dispatcher** (`agent/dispatch.ts`, ADR-025): `TaskKind` already has `capture_lead` (triage args `name`, `phone`, `email`), `DispatchContext.consentGiven()` returns `false` everywhere (fail closed), and `check()` refuses a `needsConsent` handler with reason `consent`. No handler is registered for `capture_lead`, so it is `unhandled` today.
- **Turn** (`agent/turn.ts`): `store()` appends the reply through inbox `appendAgentReply` (body, disclosure, `notice {kind, text}`, language, `taskKinds`), audits `agent.decision`; outcomes `unavailable`, `unsure`, `escalated`, after-hours notice, the paused fallback and the provider-failure fallback are all decided before `store()`.
- **Privacy wordings** (`governance/privacy.ts`, FEAT-058): append-only `wording_versions` (`privacy_notice`, `purpose_statement`), `privacy_settings` pointers, `DEFAULT_PURPOSE`, `CONSENT_PROMPT` (the platform's question), `visitorPrivacy(tx)` through SECURITY DEFINER `visitor_privacy()` (current purpose content and its wording ID, notice, business name) for the visitor zone. Go-live already requires a saved purpose statement and notice (`readiness.ts`), so every live widget has a purpose wording ID.
- **Phone and email** (`contracts`, FEAT-009 D3): `SgPhone` (8 digits starting 3/6/8/9, stored `+65XXXXXXXX`), `ContactEmail`, `formatSgPhone`. `inbox/search.ts` `searchTerms` already expands an SG phone query into its spellings.
- **Widget** (`apps/widget`): messages arrive over SSE and live only in panel memory; `Message` carries `notice`/`noticeKind`; `api.ts` holds the visitor calls; the paused notice and the not-live card are `PausedNotice` and `NotLiveCard` in `panel.tsx` (FEAT-057, FEAT-034); chrome strings in `strings.ts`. Widget routes are in `apps/api/src/app.ts` (`visitorFrom(req)`, conversation ownership by `visitorId`, `notify` on `channels.conversation`/`channels.inbox`).
- **Inbox**: `ContextSidebar.contact` is a placeholder (`label`, first seen, previous conversations by `visitor_id`) and `lead` is `LeadSummary { status }` "until FEAT-049"; dividers come from audit rows (`views.ts` `threadEvents`); `searchConversations` has the comment "FEAT-049 unions contact hits here (D1)".
- **Schema**: no `contacts`, `leads`, `consents`; `audit_pii.contact_id` has "No FK yet: contacts arrives with FEAT-049". Latest migration `0047`. Dev seed (`db/src/setup.ts`) saves no purpose statement.
- **Tenancy**: `INDUSTRY_TEMPLATES` (FEAT-009) waits for the F&B lead fields; the dashboard route `/leads` is a placeholder naming FEAT-049 (it is FEAT-050's).

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Leads and consent (LED-01, LED-02, LED-08, LED-09; FEAT-049 §3)`)

```ts
export const LeadFieldKey = z.enum(['name', 'phone', 'email', 'need', 'budget', 'preferredTime']);
export const LeadFieldMode = z.enum(['off', 'optional', 'required']);
export const LeadFieldSetting = z.object({ key: LeadFieldKey, mode: LeadFieldMode });
/** Every key once, in LeadFieldKey order; phone or email must not both be off (D6). */
export const LeadFields = z.array(LeadFieldSetting).length(6) /* .superRefine: order, phone_or_email */;

/** What the visitor typed; '' means left empty. Phone through SgPhone, email through ContactEmail. */
export const LeadInput = z.strictObject({
  name: z.string().trim().max(120).default(''),
  phone: SgPhone.default(''),
  email: ContactEmail.default(''),
  need: z.string().trim().max(1000).default(''),
  budget: z.string().trim().max(120).default(''),
  preferredTime: z.string().trim().max(120).default(''),
});
/** Values triage read from the visitor's message, already validated; shown in the form for the visitor to confirm. */
export const LeadPrefill = z.object({ name: z.string().optional(), phone: z.string().optional(), email: z.string().optional() });

/** A widget card on an agent message (SCR-WGT-003). */
export const MessageCard = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('consent'), prefill: LeadPrefill }),
  z.object({ kind: z.literal('lead_form'), consentId: z.uuid(), prefill: LeadPrefill }),
]);
// Message gains `card: MessageCard.nullable()`; noticeKind gains 'lead_captured'.

/** In WidgetConfigResponse: null when no purpose statement is saved (fail closed, LED-02). */
export const LeadCaptureConfig = z.object({
  purpose: z.object({ wordingId: z.uuid(), text: z.object({ en: z.string(), zh: z.string() }) }),
  /** CONSENT_PROMPT, resolved per locale. */
  prompt: z.object({ en: z.string(), zh: z.string() }),
  /** Null: the business doesn't ask (D3). */
  marketing: z.object({ wordingId: z.uuid(), text: z.object({ en: z.string(), zh: z.string() }) }).nullable(),
  fields: z.array(LeadFieldSetting.extend({ mode: z.enum(['optional', 'required']) })),
});

// POST /widget/v1/conversations/:id/consent
export const ConsentBody = z.strictObject({
  purposeWordingId: z.uuid(),
  agreed: z.boolean(),
  /** Present iff the card showed the opt-in; `agreed` false unless ticked. */
  marketing: z.strictObject({ wordingId: z.uuid(), agreed: z.boolean() }).optional(),
});
export const ConsentResponse = z.object({ consentId: z.uuid().nullable() }); // null when declined

// POST /widget/v1/conversations/:id/lead
export const LeadSubmitBody = z.strictObject({ consentId: z.uuid(), fields: LeadInput });
export const LeadSubmitResponse = z.object({ status: z.enum(['created', 'updated']), notice: Message });

// POST /widget/v1/contact — the fallback contact form (SCR-WGT-005): consent and details in one request
export const ContactFormBody = z.strictObject({
  conversationId: z.uuid().optional(),
  purposeWordingId: z.uuid(),
  agreed: z.literal(true),
  marketing: z.strictObject({ wordingId: z.uuid(), agreed: z.boolean() }).optional(),
  fields: LeadInput,
});
export const ContactFormResponse = z.object({ status: z.enum(['created', 'updated']) });

/** 422 for the three lead routes: per-field codes, rendered by the widget. */
export const LeadFieldErrors = z.object({
  error: z.literal('invalid_fields'),
  fields: z.partialRecord(LeadFieldKey, z.enum(['required', 'invalid'])),
  /** True when neither phone nor email was given (D6). */
  needsContact: z.boolean(),
});

// Dashboard: GET /api/v1/settings/leads, PUT /api/v1/settings/leads (SCR-APP-043)
export const LeadSettings = z.object({
  version: z.number().int().min(0),          // 0 = never saved (defaults shown)
  fields: LeadFields,
  marketing: z.object({ enabled: z.boolean(), text: LocalText, wording: WordingRef.nullable() }),
  /** Read-only here; edited on Privacy and data (SCR-APP-047). */
  purpose: z.object({ text: LocalText, saved: z.boolean() }),
});
export const LeadSettingsBody = z.strictObject({
  version: z.number().int().min(0),
  fields: LeadFields,
  marketing: z.strictObject({ enabled: z.boolean(), text: LocalTextInput }),
});
```

- Errors: consent and lead routes → 404 for a conversation that isn't the visitor's; 409 `wording_changed` with `LeadCaptureConfig` when a posted wording ID is no longer the current one (the widget re-renders the card); 409 `consent_required` when `consentId` isn't a granted enquiry consent of this conversation (or, for `/contact`, of nothing; it records its own); 409 `not_capturing` when the tenant has no `LeadCaptureConfig`; 422 `LeadFieldErrors`. `/contact` is allowed while the widget is not live (pre-live, UX-R4) or paused, and refused 409 `not_capturing` otherwise outside a conversation.
- Settings: `settings.manage` (Owner, Admin) as the other settings routes; 409 `stale` on version mismatch with the current `LeadSettings`; 400 for `phone_or_email` (both off), an enabled marketing opt-in with an empty English text. Not a sensitive action (AUTH-03 list).
- Dashboard inbox: `ContextSidebar.contact` gains `contactId: uuid | null`, `name`, `email`, `phone` (null each, `phone` formatted); `LeadSummary` becomes `{ id, status: 'new' | 'contacted' | 'won' | 'lost', updatedAt, consent: { enquiryAt, marketing: { agreed, at } | null } }`. `ThreadEvent.kind` gains `consent` (reason `agreed` | `declined`) and `lead` (reason `created` | `updated`); `ThreadMessage` gains `card: 'consent' | 'lead_form' | null` (the kind only, never the prefill).
- Search: `SearchMatch` gains `source: 'message' | 'contact'` (default `message`) and `field: 'name' | 'email' | 'phone' | null`; `messageId` and `author` become nullable (null for a contact hit). The request is unchanged.

## 4. Schema changes (migration `0048_leads.sql`)

- **`contacts`** (tenant_id, id, name, email (lower-cased), phone (`+65…`), created_at, updated_at). Partial unique indexes on `(tenant_id, email)` and `(tenant_id, phone)` where not null; checks reuse the business-profile phone and email patterns. Trigram GIN on `(tenant_id, name)` and `(tenant_id, email)` for search (§5.5).
- **`consents`** (tenant_id, id, contact_id null, conversation_id null, purpose `enquiry` | `marketing`, decision `agreed` | `declined`, wording_id not null → `wording_versions (tenant_id, id)`, channel `widget`, created_at). Append-only: `app_visitor` may insert, and update only `contact_id` (a column grant; code sets it once, `where contact_id is null`). A declined row has no contact. FEAT-051 adds `withdrawn` as a new row kind.
- **`leads`** (tenant_id, id, contact_id not null, consent_id not null → `consents` (the enquiry consent the lead was captured under), conversation_id null (latest), status `new` | `contacted` | `won` | `lost` default `new`, need, budget, preferred_time, captures int default 1, created_at, updated_at). Partial unique index `leads_one_open_uq` on `(tenant_id, contact_id) where status in ('new','contacted')` (LED-09).
- **`lead_settings`** (tenant_id pk, version, fields jsonb, marketing_enabled bool default false, marketing_wording_id null → `wording_versions`, updated_at). `WORDING_KINDS` gains `marketing_consent` (check widened).
- **`conversations.contact_id`** null, FK `(tenant_id, contact_id)` → `contacts`; index `(tenant_id, contact_id)`.
- **`messages.card`** jsonb null (`MessageCard`); `NOTICE_KINDS` gains `lead_captured`.
- **`audit_pii.contact_id`** gets its FK `(tenant_id, contact_id)` → `contacts` on delete cascade.
- All four new tables: forced RLS, tenant policy, `TENANT_SCOPED_TABLES`, cases in `rls.int.test.ts`. Grants: `app_visitor` select/insert/update(name, email, phone, updated_at) on contacts, select/insert on consents + update(contact_id), select/insert/update(need, budget, preferred_time, conversation_id, consent_id, captures, updated_at) on leads, select on lead_settings; `app_dashboard` select on all four, insert/update on lead_settings. `visitor_privacy()` is replaced (same owner) to also return the current marketing wording and `lead_settings.fields` (the visitor zone reads wordings only through it).
- `inbox_contact_hits(patterns text[])` SECURITY DEFINER owned by `kaki_inbox_search` (the 0047 pattern; select on contacts' name, email, phone and conversations' contact_id), returning `(tenant_id, conversation_id, field, value)` for the current tenant.

## 5. Component design

### 5.1 `@kaki/leads`

- `settings.ts`: `DEFAULT_FIELDS` (name required, phone optional, email optional, need optional, budget off, preferredTime off), the F&B default (adds preferredTime optional, labelled by the widget as "Date needed"; in `INDUSTRY_TEMPLATES.fnb.leadFields`), `DEFAULT_MARKETING` (en, zh), `getLeadSettings(tx, tenantId)` (row, or the industry default with version 0), `saveLeadSettings(tx, input)` (compare-and-set on `version`; a changed marketing text saves a new `marketing_consent` wording through governance `saveWording`; audit `settings.lead_fields_updated` with codes), `leadCaptureConfig(tx)` (visitor zone, from `visitor_privacy()`: null without a purpose wording).
- `consent.ts`: `recordConsent(tx, { tenantId, conversationId, purposeWordingId, agreed, marketing })` checks the IDs against `leadCaptureConfig` (else `WordingChanged`), inserts the enquiry row (and a marketing row when the opt-in was shown: `agreed` or `declined`), audits `consent.recorded` (purpose, decision, wording ID; no PII); `consentState(tx, conversationId)` → `{ enquiry: 'agreed' | 'declined' | null, consentId, offered, captured }` (offered = a message with a card exists; captured = a lead names this conversation).
- `capture.ts`: `captureLead(tx, { tenantId, conversationId | null, consentId, input })` (`leads.captureLead`, the plan's interface): validates `input` against the settings (required fields, phone or email, D6) → `LeadFieldErrors`; resolves the contact (§5.2); sets `consents.contact_id` for this conversation's consent rows, `conversations.contact_id`; inserts the lead or updates the contact's open lead (`insert … on conflict (tenant_id, contact_id) where status in ('new','contacted') do update`: non-empty fields overwrite, `captures + 1`, `consent_id` and `conversation_id` to the latest); audits `lead.created` or `lead.updated` (lead and contact IDs); appends a system message (`noticeKind 'lead_captured'`, text from the widget's locale via `leadCapturedNotice(language, businessName)`) when there is a conversation. Returns `{ status, leadId, contactId, notice }`. `submitContactForm` wraps `recordConsent` + `captureLead` in one transaction.
- `index.ts` exports these plus `contactOf(tx, conversationId)` and `leadSummaryOf(tx, conversationId)` for the sidebar.

### 5.2 Contact resolution (LED-09, D4)

In `captureLead`'s transaction: match an existing contact of the tenant by normalised email, else by phone; else the contact already on the conversation; else insert one. On a match, empty contact fields are filled from the input (a different name replaces the old one; a phone or email already on another contact is left off this contact, D4). `select … for update` on the matched contact so two submits from one person serialise; the open-lead unique index is the final guard.

### 5.3 Agent (`capture_lead`, ADR-025)

- `captureLeadHandler` in `visitorRegistry` (new file `agent/lead.ts`): `kind 'capture_lead'`, `scopes ['visitor']`, `needsConsent: true`, `args` = optional `name`, `phone`, `email` strings. `run` validates each through the contracts' phone and email rules, drops what fails, and returns `{ card: { kind: 'lead_form', consentId, prefill } }`. It writes nothing: the lead is stored only when the visitor submits the form (the model's args are a proposal, ADR-025).
- `TaskResult` gains `card?: MessageCard`. The dispatcher's refusal `consent` for `capture_lead` makes the turn attach `{ kind: 'consent', prefill }` instead (the same validated args): the consent check stays the dispatcher's.
- `DispatchContext.consentGiven()` in the visitor turn → leads `consentState(...).enquiry === 'agreed'` for this conversation (D2). Coaching, replay and suggestions keep `false` and register no handler (no cards outside the widget).
- **Offers** (UC-21 step 1, AGT-04, AGT-09, NFR-04): when a turn ends `unavailable`, `unsure`, `escalated` after hours, `out_of_scope` (topic `other` or `blocked`), with the after-hours notice, or with the provider-failure fallback, and the conversation's `consentState` is `enquiry null`, `offered false`, `captured false`, and `leadCaptureConfig` is not null, `store()` attaches `{ kind: 'consent', prefill: {} }` to that reply. At most one offer per conversation; a visitor's own `capture_lead` always gets its card (after a decline too: they changed their mind, D2). Safety turns (`crisis`, `abuse`) never get a card.
- The reply text for a turn whose only task is `capture_lead` is a fixed system text (`ReplyKey 'lead_consent'` or `'lead_form'`, EN and ZH: "I can pass your details to the team so they can get back to you." / "Please fill in your details below."); with other tasks the composed answer comes first and the card follows it.
- `appendAgentReply` takes `card`; `agent.decision` audits `card: 'consent' | 'lead_form' | null`.
- The paused path (gate closed, kill switch) attaches no card: the panel's paused notice has its own contact form (§5.4).

### 5.4 API

- Widget routes in `apps/api/src/leads-widget.ts` (`registerLeadWidgetRoutes(app, deps, visitorFrom)`, wired in `app.ts` next to `/escalate`): `/consent`, `/lead`, `/contact` (§3), each in one `withTenant(visitorDb, …)` transaction; `/lead` and `/contact` publish the notice (`channels.conversation`, `channels.inbox`) and the updated summary. `GET /widget/v1/config` adds `leadCapture: leadCaptureConfig(tx)`; it is returned while not live and while paused (the fallback form needs it).
- Dashboard routes in `apps/api/src/leads.ts` (`registerLeadSettingsRoutes`): `GET`/`PUT /api/v1/settings/leads`.
- Inbox sidebar and thread: `views.ts` `sidebarOf` reads `contactOf`/`leadSummaryOf` through new inbox ports filled by the api (inbox doesn't import leads: the api passes a `ContactLookup`, the `OwnerNames` pattern); `threadEvents` maps `consent.recorded` and `lead.created`/`lead.updated` to dividers.

### 5.5 Search (INB-11, FEAT-046 D1)

`searchConversations` gets a second source: `inbox_contact_hits(patterns)` (name or email `ILIKE` the patterns; phone matched by the phone variants `searchTerms` already makes) → every conversation with that `contact_id`. Merge rule: a conversation with a message hit shows the message hit; one with only a contact hit shows `{ source: 'contact', field, excerpt: the field value, ranges }`. The union keeps the `(last_message_at, id)` keyset; `excerptOf` marks the hit. The FEAT-046 volume test gains 5,000 contacts and stays ≤ 2 s.

### 5.6 Widget

- `chat.ts`: `activeCard(chat)` (the latest message's card if no later message answers it), `cardState` per message ID (`asked | agreed | declined | form | submitting | submitted | failed`, in panel memory), `leadFormView(config, prefill)` (enabled fields in order, labels from strings), `validateLead(fields, values)` (the contracts' `SgPhone`/`ContactEmail` rules as plain functions exported from contracts without Zod, so the panel chunk stays small, D7).
- `panel.tsx`: `ConsentCard`, `LeadFormCard` (SCR-WGT-003) under the message that carries them; `ContactForm` (SCR-WGT-005) reached from `PausedNotice` and `NotLiveCard` with a "Leave your details" button, posting `/contact`. Strings EN and ZH in `strings.ts`. A 409 `wording_changed` swaps the card's text for the new wording and asks again.

### 5.7 Dashboard

`pages/leads-settings.tsx` at `/settings/leads` (SCR-APP-043), parts in `pages/leads-settings-parts.tsx`, data and pure helpers (`fieldsError`, `diffLeadSettings`) in `lib/leads.ts`; the settings-form pattern of `privacy-parts.tsx` (`useSave`, `ErrorSummary`). Settings index gains "Leads and consent". Inbox: `ContextSidebar` Contact and Lead sections, the new dividers, a contact search hit's row label ("Email matches"). `/leads` placeholder names FEAT-050.

### 5.8 Evals

`evals/cases/feat-049-lead-capture.json` in the AGT-14 multi-task and dispatch subset: details offered (EN, Singlish, ZH) → `capture_lead` with args; "can someone call me back" → `capture_lead`; capture plus a question → both tasks in order; before consent → `refused: consent` and a consent card; after consent → a lead form with the validated prefill (an invalid phone dropped); out of scope → one offer, and none on the next unsure turn.

### 5.9 Seed

`seed` saves a purpose statement and a privacy notice for both dev tenants (so their live widgets capture leads), and lead settings with marketing enabled for Kaki Bakery only (both states for E2E).

## 6. Acceptance criteria

- **AC-1** (LED-02 "before collecting personal data … explicit consent"; UC-21 2) No lead can be stored without a granted enquiry consent of the same conversation (or the same `/contact` request): `/lead` without one → 409 `consent_required`; the `leads.consent_id` FK and NOT NULL make it impossible in the database too. The form card appears only after Agree.
- **AC-2** (LED-02 "recorded with a timestamp and the wording used"; UC-21 3) Agree records a consent row naming the purpose wording version shown and the time; a stale wording ID → 409 `wording_changed` with the current wording, and nothing is recorded.
- **AC-3** (UC-21 2a) Not now records a declined row with no contact and no personal data; the agent goes on answering; no proactive offer follows in that conversation, but a later `capture_lead` from the visitor shows the card again.
- **AC-4** (LED-08; UC-21 2b; D3) The marketing opt-in shows only when the business enabled it, is unticked by default, and is recorded as its own consent row (agreed or declined, its own wording). Off: no opt-in shown, no marketing row.
- **AC-5** (LED-01; UC-21 4, 4a) The form shows the business's enabled fields in order with required ones marked; SG phones in any common spelling are stored `+65XXXXXXXX`; an invalid phone or email, a missing required field, or neither phone nor email → 422 with per-field codes, shown inline, nothing stored; triage's valid args prefill the form and invalid ones are dropped.
- **AC-6** (LED-09; UC-21 5) A submit whose email or phone matches an existing contact updates that contact's open lead (fields overwritten where given, `captures` + 1) instead of creating one; with no open lead a new one is created; concurrent submits for one contact leave exactly one open lead.
- **AC-7** (AGT-06 `capture_lead`, ADR-025) `capture_lead` is dispatched through the registry with `needsConsent`; before consent it is `refused: consent` and the reply carries a consent card; after consent it returns a lead form card and writes nothing; every dispatch is audited with codes only; coaching and replay don't handle it.
- **AC-8** (UC-21 1, AGT-04, AGT-09, NFR-04) An unavailable, unsure, out-of-scope, after-hours or fallback reply carries one consent offer per conversation, never after a decline or a capture, never on a safety turn, never when the tenant has no saved purpose statement.
- **AC-9** (GOV-08 "with lead capture"; SCR-WGT-005; UX-R4) While paused, or not live in message mode with a saved purpose statement and notice, the fallback screen offers the contact form; one submit records consent and the lead; without a saved purpose statement the form isn't offered.
- **AC-10** (INB-11 contact fields) Search finds a conversation by its contact's name, email or phone (any SG spelling) even when no message contains it; the result shows which field matched; tenant B finds none of A's contacts; the volume test stays ≤ 2 s.
- **AC-11** (ADR-005, ADR-015, ADR-014) The four new tables have forced RLS and pass the cross-tenant suite; personal data is only in `contacts`, `leads`, `messages`; audit entries carry IDs and codes only; logs carry no field values.
- **AC-12** (SCR-APP-043, SCR-APP-014; NFR-09, NFR-19) Leads and consent settings save fields and marketing wording with loading, error, stale and validation states; the sidebar shows contact, lead status and consent; dividers show consent and capture; the widget cards and contact form render as in ui-design.md in EN and ZH, keyboard-operable, axe clean at 375 px.

## 7. Decisions

- **D1 — Cards, not free-text collection.** The widget shows the consent card and a form card (design.md §4.9 `consent-card`, `lead-form-card`); the agent never extracts and stores fields from chat text. Triage's args only prefill the form for the visitor to confirm. Deterministic validation, no model writes (ADR-008, ADR-025). Text-only channels (FEAT-037 onward) render the cards through their adapter later.
- **D2 — Consent is per conversation.** A granted enquiry consent covers lead capture in that conversation only; a new conversation asks again. Nothing is prefilled from an earlier conversation (a shared computer would show one person's details to another). A decline stops proactive offers in that conversation only.
- **D3 — Marketing opt-in off until the owner turns it on** (Ken chose this on 2026-11-04). The owner enables it on SCR-APP-043, with the default wording prefilled, and saving records a `marketing_consent` wording, so every marketing consent names a saved wording.
- **D4 — Duplicates match on email, then phone.** Values are unverified, so a match only updates the open lead and fills empty contact fields; nothing from the existing contact is ever shown to the visitor. If phone and email match two different contacts, the email's contact wins and the phone stays off it (the unique index holds).
- **D5 — Consent rows are append-only and carry no PII.** A declined or never-completed consent has no contact; `contact_id` is set once at submit. FEAT-051 adds withdrawal as a new row; FEAT-061 deletes by contact.
- **D6 — Phone or email is always required.** The team needs one way back; the form says "Phone or email" when both are optional. Settings refuse turning both off.
- **D7 — Validation without Zod in the panel.** `normaliseSgPhone` and `isEmail` are plain functions in contracts that `SgPhone`/`ContactEmail` also use, so the widget and the server agree and the panel chunk stays within budget (ADR-016).
- **D8 — Scoring and the hot-lead alert are FEAT-050.** UC-21 step 5's score and step 6's alert need LED-03's criteria; leads are stored unscored. The qualification-criteria block of SCR-APP-043 is FEAT-050's, webhooks FEAT-053's.
- **D9 — Lead without a conversation.** A pre-live contact form has no conversation (`409 not_live` starts none), so `leads.conversation_id` and `consents.conversation_id` are nullable; such leads show in FEAT-050's list.

## 8. Escalations and open items

- UC-21 step 5 (score) and step 6 (alert) and LED-03/LED-04 for leads are FEAT-050; the RTM's UC-21 trace stays partial.
- Contact merge across channels and the Contact screen (SCR-APP-016, CHN-08) are later; this feature only resolves by email and phone.
- The pre-live contact form's leads aren't visible to staff until FEAT-050's list lands; recorded in pending-actions.

## 9. Self-check

- LED-01 → AC-5; LED-02 → AC-1, AC-2; LED-08 → AC-4; LED-09 → AC-6; AGT-06 (`capture_lead`) → AC-7; INB-11 contact fields → AC-10; GOV-08 lead capture → AC-9; UC-21 1–5, 2a, 2b, 4a → AC-8, AC-1–AC-6.
- Four tenant tables with forced RLS, policies, `TENANT_SCOPED_TABLES` and RLS cases; tenant ID from the widget token or the session; the visitor zone reads wordings only through `visitor_privacy()` (ADR-005).
- PII only in contact-keyed tables; audit and logs carry IDs and codes (ADR-014, ADR-015); NRIC masking at the edge unchanged.
- Model interprets, code acts: `capture_lead` registers a handler, consent is the dispatcher's check, the model writes no field (ADR-025, ADR-008). No channel branching in the core (ADR-011): cards are message data.
- UI uses design.md `consent-card`, `lead-form-card`, `text-input`, `checkbox`, `button`, `alert`, `toast`, data-view states; tokens only; widget `--kaki-*` only (ADR-016).
