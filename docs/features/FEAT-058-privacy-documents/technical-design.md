# Technical Design: FEAT-058 — Privacy notice and template, consent wording, data-processing documents

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E8) · Milestone: M2
> Implements: GOV-14 (privacy notice: link or filled template, versioned notice and consent wordings), GOV-07 (in-app data-intermediary documentation, downloadable DPA and data-flow PDF; the 30-day sub-processor notice is FEAT-073), GOV-11 (each cross-border transfer listed with location, purpose and safeguard), LED-02 (p: the purpose statement and consent wording, versioned; showing it and recording consent is FEAT-049) · Realizes: UC-03 step 8 (privacy part) and 10a (privacy items of the readiness check, as a predicate FEAT-035 calls); UC-35 only as context for SCR-APP-047 (retention is FEAT-059) · Screens: SCR-APP-047 (p: notice, purpose statement, documents, terms read-only), SCR-APP-009 (p: privacy block on the setup step) (see [ui-design.md](ui-design.md))
> Status: Designed · Date: 2026-10-27

## 1. Intent

Before a business collects a visitor's details it must say why (LED-02) and where its privacy notice is (GOV-14), and as a data intermediary KakiAgent must show the business where its data goes (GOV-07, GOV-11). This feature gives the Owner or Admin one page, Settings → Privacy and data, and the same privacy block on a new setup step "Rules and privacy": they either paste a link to their own privacy notice or fill in a short platform template that KakiAgent hosts; they review the PDPA purpose statement visitors will see before giving details; and they read and download the sub-processor list, the data flows and the DPA schedule as PDFs. Every saved notice and purpose statement is an immutable, numbered wording version, so FEAT-049 can record exactly which wording a visitor consented to. The widget's privacy link (FEAT-033) now shows for any tenant that has a notice.

## 2. Codebase context

- **Widget config:** `GET /widget/v1/config` (`apps/api/src/app.ts`) already returns `privacyNoticeUrl: null` (FEAT-033 D1); the panel renders the menu item and footer link when it is set. The config reads tenant values through SECURITY DEFINER functions (`visitor_tenant_state()`, `visitorWidgetTheme`), never table grants for the visitor zone; the key resolves with `resolveWidgetKey` (`@kaki/tenancy`), and a non-`active` install is "not here".
- **Settings pattern:** `apps/api/src/settings.ts` (`registerSettingsRoutes`, `manager()` checks `settings.manage`), domain in `packages/tenancy/src/assistant.ts` (one row per tenant, absent until first save; optimistic `version`; `SettingsConflictError` → 409; audit names changed fields, never their text). The dashboard's `pages/assistant.tsx` is the form pattern (`lib/form.ts`, `lib/field.tsx`).
- **Terms:** `@kaki/identity` `CURRENT_TERMS` (tos, aup, dpa, version constants until FEAT-073) and `terms_acceptances` (FEAT-005). `/legal/:document` shows a title and version only (FEAT-005 D9: full text after legal review).
- **Business profile:** `name`, `uen`, `contactEmail` (`@kaki/tenancy` `getBusinessProfile`) prefill the template.
- **Governance:** `packages/governance` holds only the audit chain today; the plan puts E8 here. ADR-019 lists the sub-processors; architecture §8.1 and ADR-006 the Bedrock `au.` transfer.
- **Setup steps:** `/setup/sources` (2), `/setup/review` (3), `/setup/test` (4), `/setup/website` (5), each a page with `page-lede` "Step N of the setup"; the review step's Continue links to `/setup/test`. The IA (ux-foundations flow F1) puts "Rules, persona, privacy (APP-009)" between review and test. FEAT-035 adds the wizard frame, FEAT-054 the boundary rules on SCR-APP-009.
- **Dev seed:** no tenant has a notice; the FEAT-033 E2E stubs `privacyNoticeUrl` in the config response, so it is unaffected.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: privacy (GOV-14, GOV-07, GOV-11, LED-02; FEAT-058 §3)`)

```ts
export const LocalTextIn = z.object({ en: z.string().trim().min(1).max(600), zh: z.string().trim().max(600).nullable() });

export const NoticeTemplateFields = z.object({
  contactName: z.string().trim().min(1).max(120),       // the data protection officer or contact person
  contactEmail: z.email().max(254),
  contactPhone: z.string().trim().max(40).nullable(),
  address: z.string().trim().max(300).nullable(),
  extra: z.string().trim().max(2000).nullable(),        // "Anything else to tell visitors"
});

export const PrivacyNoticeBody = z.discriminatedUnion('mode', [
  z.object({ version: z.number().int().min(0), mode: z.literal('link'), url: z.url({ protocol: /^https$/ }).max(2048) }),
  z.object({ version: z.number().int().min(0), mode: z.literal('template'), fields: NoticeTemplateFields }),
]);
export const PurposeStatementBody = z.object({ version: z.number().int().min(0), purpose: LocalTextIn });

const WordingRef = z.object({ seq: z.number().int().min(1), savedAt: z.iso.datetime() });

export const PrivacySettingsResponse = z.object({
  version: z.number().int().min(0),                     // privacy_settings.version, 0 = never saved
  notice: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({ mode: z.literal('link'), url: z.url(), wording: WordingRef }),
    z.object({ mode: z.literal('template'), fields: NoticeTemplateFields, templateVersion: z.string(), publicUrl: z.url(), wording: WordingRef }),
  ]),
  purpose: z.object({ text: z.object({ en: z.string(), zh: z.string().nullable() }), wording: WordingRef.nullable() }), // null = default, not yet saved
  defaults: z.object({
    purpose: z.object({ en: z.string(), zh: z.string() }),
    template: z.object({ organisationName: z.string(), uen: z.string().nullable(), contactEmail: z.string().nullable() }),
  }),
  readiness: z.object({ privacyNotice: z.boolean(), purposeStatement: z.boolean() }),
  documents: PrivacyDocuments,
  terms: z.array(z.object({ document: z.enum(['tos', 'aup', 'dpa']), title: z.string(), currentVersion: z.string(), acceptedVersion: z.string().nullable(), acceptedAt: z.iso.datetime().nullable() })),
});

export const PrivacyDocuments = z.object({
  updatedOn: z.string(),                                // registry date, YYYY-MM-DD
  dpaVersion: z.string(),                               // CURRENT_TERMS.dpa.version
  subProcessors: z.array(z.object({ name: z.string(), service: z.string(), purpose: z.string(), location: z.string(), dataAtRest: z.boolean() })),
  transfers: z.array(z.object({ data: z.string(), from: z.string(), to: z.string(), purpose: z.string(), safeguard: z.string(), retention: z.string() })),
});
```

| Route | Who | Request → response | Errors |
|---|---|---|---|
| `GET /api/v1/settings/privacy` | `settings.manage` | → `PrivacySettingsResponse` | 401, 403 |
| `PUT /api/v1/settings/privacy/notice` | `settings.manage` | `PrivacyNoticeBody` → `PrivacySettingsResponse` | 400 `invalid` (Zod; non-https URL), 409 `conflict` (stale `version`) |
| `PUT /api/v1/settings/privacy/purpose` | `settings.manage` | `PurposeStatementBody` → `PrivacySettingsResponse` | 400, 409 |
| `GET /api/v1/settings/privacy/documents/:doc.pdf` (`doc` ∈ `data-flow`, `dpa`) | `settings.manage` | → `application/pdf`, `content-disposition: attachment; filename="kakiagent-<doc>-<updatedOn>.pdf"` | 404 unknown doc |
| `GET /privacy/:key` (public, no session, no CORS) | anyone | → `text/html; charset=utf-8`, the hosted notice for a template tenant | 404 HTML page "This privacy notice isn't available" for an unknown key, a non-`active` install, or a tenant not in template mode |

`WidgetConfigResponse.privacyNoticeUrl` (unchanged shape) is now the link-mode URL, or `${PUBLIC_API_URL}/privacy/${key}` in template mode, or null. `/privacy/:key` sends `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `x-robots-tag: noindex`, `cache-control: public, max-age=60`.

## 4. Schema changes (migration `0033_privacy.sql`)

- **`wording_versions`** (tenant-scoped, append-only): `id uuid pk`, `tenant_id uuid not null → tenants on delete cascade`, `kind text not null` check in (`privacy_notice`, `purpose_statement`), `seq integer not null` (1, 2, … per tenant and kind), `content jsonb not null`, `created_by uuid → users on delete set null`, `created_at timestamptz default now()`. Unique `(tenant_id, kind, seq)` and `(tenant_id, id)`. Content shapes (Zod in governance, D3): notice link `{ mode: 'link', url }`; notice template `{ mode: 'template', templateVersion, fields }`; purpose `{ purpose: {en, zh}, consentPrompt: {en, zh}, wordingVersion }` (the full text a visitor sees, so a consent record is self-contained).
- **`privacy_settings`** (tenant-scoped, one row per tenant, absent until the first save): `tenant_id uuid pk → tenants on delete cascade`, `version integer not null default 1`, `notice_wording_id uuid null`, `purpose_wording_id uuid null`, `updated_at timestamptz default now()`. Composite FKs `(tenant_id, notice_wording_id)` and `(tenant_id, purpose_wording_id)` → `wording_versions(tenant_id, id)`, so a pointer can't name another tenant's wording.
- Both: forced RLS with the standard `tenant_id = current_setting('app.tenant_id')::uuid` policy, names added to `TENANT_SCOPED_TABLES`, a case each in `packages/db/test/rls.int.test.ts`.
- **Grants:** `app_dashboard`: `SELECT, INSERT` on `wording_versions` (no `UPDATE`/`DELETE`: versions are immutable, D3); `SELECT, INSERT, UPDATE (version, notice_wording_id, purpose_wording_id, updated_at)` on `privacy_settings`. No grant to the visitor zone.
- **`visitor_privacy()`** SECURITY DEFINER, owner `kaki_tenant_state`, `STABLE`, `search_path = public, pg_temp`, for the current `app.tenant_id` only; `EXECUTE` to `app_agent_visitor` (config, public notice; FEAT-049 consent later). Returns one row: `notice jsonb`, `notice_wording_id uuid`, `notice_saved_at timestamptz`, `purpose jsonb`, `purpose_wording_id uuid`, `business_name text`, `uen text` (null row fields when nothing is saved).
- Drizzle tables in `schema.ts`; `pnpm db:generate` then add RLS, grants and the function by hand in the same migration.

## 5. Component design

### 5.1 Governance (`packages/governance/src/`, exported from `index.ts`)

- **`registry.ts`** — `DOCUMENTS_UPDATED_ON` and the two in-code lists, from ADR-019 and ADR-006: `SUB_PROCESSORS` (AWS Singapore: hosting, database, storage, queues, logs; AWS Bedrock Claude `au.` profile: AI replies, Sydney/Melbourne, nothing at rest; AWS Bedrock Cohere Embed: search index, Singapore; Amazon SES: email, Singapore; GuardDuty Malware Protection: file scanning, Singapore; Google: staff sign-in only, no visitor data) and `TRANSFERS` (one row per cross-border flow, GOV-11: conversation text and retrieved facts → Bedrock in Sydney/Melbourne for reply generation, safeguard "AWS data processing terms; Bedrock invocation logging off, retention none; no model-provider access", retention "not stored"; staff sign-in identity → Google, "Google OAuth terms", "Google's account terms"). Plain data, unit-tested for non-empty fields and that every non-Singapore location appears in `TRANSFERS` (D5).
- **`privacy.ts`** — `NoticeContent`, `PurposeContent` (Zod), `DEFAULT_PURPOSE` (en, zh; ui-design copy), `CONSENT_PROMPT` and `CONSENT_WORDING_VERSION` (platform text around the purpose statement, D4), `PRIVACY_TEMPLATE_VERSION`.
  - `getPrivacySettings(tx, tenantId)` → `{ version, notice, purpose }` with wording refs (`seq`, `createdAt`), defaults when absent.
  - `savePrivacyNotice(tx, { tenantId, userId, version, notice })` and `savePurposeStatement(tx, { tenantId, userId, version, purpose })`: if the content equals the current wording's content, nothing is written and the current settings return (no empty versions, D3); otherwise insert the next `seq` for that kind, then upsert `privacy_settings` with the same optimistic rule as assistant settings (0 inserts with `onConflictDoNothing`, n updates where `version = n`; no row → `PrivacyConflictError`, the transaction rolls back the new wording). Audit `settings.privacy_notice_updated` / `settings.purpose_statement_updated`, payload `{ version, seq, mode }` only: no URL, names or text (ADR-014).
  - `privacyReadiness(tx, tenantId)` → `{ privacyNotice, purposeStatement }`: true once a notice wording and a purpose wording exist (an explicit save, D6). For FEAT-035's readiness check and FEAT-034's pre-live form (UX-R4).
  - `visitorPrivacy(tx)` → `{ noticeUrl(key, publicApiUrl), notice, purpose, purposeWordingId, … } | null` via `visitor_privacy()`.
- **`notice-template.ts`** (pure) — `noticeSections(input)` → ordered `{ heading, paragraphs }[]` from the template version, the tenant's fields, business name and UEN, the current purpose statement (en), `TRANSFERS` and the sub-processor services in plain words. Sections: Who we are · What we collect (messages you send in the chat, details you choose to give, the pages you view on our website while chatting) · Why we use it (the purpose statement) · Who processes it for us · Where it is processed (from `TRANSFERS`) · How long we keep it (generic until FEAT-059 adds periods) · Your choices (access, correction, withdrawal of consent, via the contact) · Contact us · "Last updated {d MMM yyyy}" (the wording's `created_at`, SGT). `renderNoticeHtml(sections, css)` returns a full HTML document (`lang="en"`), every value HTML-escaped, the `extra` text as paragraphs split on blank lines (no markup, no links).
- **`documents.ts`** — `dataFlowPdf()` and `dpaPdf()` → `Promise<Uint8Array>` with **pdf-lib** (Ken, D2): A4, standard Helvetica (WinAnsi; the registry is English-only and unit-tested to stay in WinAnsi), a heading, the registry date, tables drawn as wrapped rows. Data-flow PDF: the transfer table, the sub-processor table, "No tenant data is stored at rest outside Singapore." DPA PDF: title, `CURRENT_TERMS.dpa.version`, the notice "The full agreement text will be added after legal review." (FEAT-005 D9), Schedule 1 sub-processors, Schedule 2 transfers and locations, Schedule 3 zero-retention terms. Deterministic: `creationDate`/`modDate` set from `DOCUMENTS_UPDATED_ON`, so the same registry gives byte-identical files.

### 5.2 API

- **`apps/api/src/privacy.ts`** — `registerPrivacyRoutes(app, deps, sessionFrom)` with the dashboard routes in §3 (`manager()` as in `settings.ts`). The response builder joins `getPrivacySettings`, `getBusinessProfile` (defaults), `privacyReadiness`, the registry, and the tenant's latest `terms_acceptances` per document. `PrivacyConflictError` → 409 `conflict` in `app.ts`'s error mapper. PDFs are generated once per process on first request and cached in memory (registry is static).
- **Public notice** `GET /privacy/:key` in the same file: `resolveWidgetKey(visitorDb, key)`; not `active` → 404 page; `withTenant(visitorDb, tenantId, visitorPrivacy)`; not template mode → 404 page; else `renderNoticeHtml` with the stylesheet. The stylesheet is `@kaki/design-tokens/tokens.css` read once at start-up plus a short rule block using only `var(--…)` (page width, type scale); `@kaki/design-tokens` becomes an api dependency (D7).
- **Widget config** (`app.ts`): inside the existing visitor-zone transaction, `visitorPrivacy(tx)` gives `privacyNoticeUrl` (link URL, or the hosted URL from `config.PUBLIC_API_URL` and the key).

### 5.3 Dashboard

- `lib/api.ts`: `privacySettings()`, `savePrivacyNotice(body)`, `savePurposeStatement(body)`, and `documentUrl(doc)` (plain links, the browser downloads with the session cookie).
- `lib/privacy.ts` (unit-tested): `noticeDraftOf(response)`, `validateNotice(draft)` (https only, names the field; NFR-19 copy), `purposeDraftOf`, `samePurpose`, `formatSaved(ref)` ("Version 3 · saved 27 Oct 2026").
- `pages/privacy-parts.tsx`: `NoticeForm` (link / template radio, the fields), `PurposeForm` (en, zh, with the consent preview), `DocumentsSection`, `TermsSection`. Shared by:
  - `pages/privacy.tsx` `PrivacyPage` at `/settings/privacy` (SCR-APP-047); the Settings index row links to it.
  - `pages/setup-rules.tsx` `SetupRulesPage` at `/setup/rules` (SCR-APP-009 partial): "Step 4 of the setup", the notice and purpose forms only; Continue → `/setup/test`. The review step's Continue now links to `/setup/rules`; Test and Website become steps 5 and 6 (D8).

### 5.4 E2E (`e2e/tests/privacy.e2e.ts`)

Owner signs in, opens Settings → Privacy and data, saves the template with a contact, opens the hosted notice (new tab) and checks the business name and contact; the widget host page's privacy link now points at it; switches to link mode with an https URL, the widget link follows; saves a Chinese purpose statement; downloads both PDFs (`%PDF-` header, non-empty); Agent role sees the permission state; axe on the page and the hosted notice. `afterEach` restores the dev tenant to "no notice" by deleting its `privacy_settings` row through the superuser DB helper (wording rows may stay) so later specs and FEAT-033's stub are unaffected.

## 6. Acceptance criteria

- **AC-1** (GOV-14 "links to the tenant's privacy notice") An Owner or Admin saves a privacy-notice link (https only; http, `javascript:` and malformed URLs are 400 with field copy); `GET /widget/v1/config` then returns that URL as `privacyNoticeUrl`, and the widget's menu item and footer link (FEAT-033) point to it.
- **AC-2** (GOV-14 "a template the tenant can fill in") Saving the template with a contact name and email makes `privacyNoticeUrl` `{PUBLIC_API_URL}/privacy/{key}`; that page returns 200 HTML naming the business, UEN when set, the contact, the purpose statement, each cross-border transfer from the registry and "Last updated"; every tenant value is HTML-escaped (a `<script>` in `extra` shows as text); CSP and `noindex` headers are set; an unknown key, a suspended tenant and a link-mode tenant get the 404 page.
- **AC-3** (GOV-14 "consent and notice wordings are versioned"; LED-02 "the wording used") Each save that changes the notice or the purpose statement adds one `wording_versions` row with the next `seq` for its kind and points `privacy_settings` at it; saving identical content adds nothing; earlier rows never change (`app_dashboard` has no UPDATE or DELETE on `wording_versions`); a purpose wording's content holds the purpose text and the consent prompt in both languages.
- **AC-4** (optimistic save, ADR-014) A save with a stale `version` is 409 and adds no wording row; each accepted save writes one audit entry whose payload holds only version, seq and mode (no URL, names or text).
- **AC-5** (ONB-09, UC-03 10a) `privacyReadiness` is false/false for a new tenant, true for the notice only after a notice save and for the purpose only after a purpose save (showing the default doesn't count); the GET response carries it.
- **AC-6** (GOV-07, GOV-11) The Privacy and data page lists every sub-processor (name, service, purpose, location) and every cross-border transfer (data, destination, purpose, safeguard, retention) from the registry; every non-Singapore location in `SUB_PROCESSORS` has a `TRANSFERS` row; the page says no tenant data is stored at rest outside Singapore.
- **AC-7** (GOV-07 "downloadable DPA and data-flow PDF") Both PDF routes return `application/pdf` attachments that start with `%PDF-`, contain every sub-processor name and transfer destination (text extracted in the test), and are byte-identical across two calls; an unknown doc is 404; an Agent gets 403.
- **AC-8** (tenant isolation, ADR-005) Tenant B can't read or point at tenant A's `wording_versions` or `privacy_settings` (RLS suite cases; composite FK rejects a cross-tenant pointer); `visitor_privacy()` returns only the current tenant's row; the dashboard routes use the session's tenant only.
- **AC-9** (SCR-APP-047, SCR-APP-009; NFR-19) The page and the setup step show loading, error with Try again, never-saved (defaults, readiness note), saved (version and date), conflict ("Someone else changed this. Reload to see their version.") and permission states per ui-design; the setup flow goes review → Rules and privacy → test → website with the renumbered steps; terms show the accepted and current versions read-only.
- **AC-10** (WCAG 2.1 AA) Forms follow the validation convention (error summary alert, field-linked errors, focus to the alert); radios and download links are keyboard-operable with visible focus; axe has no serious or critical issues on the page, the setup step and the hosted notice, light and dark.

## 7. Decisions

- **D1 — Governance owns privacy.** Plan E8 puts GOV-* in `governance`; leads (FEAT-049) and tenancy's readiness (FEAT-035) call it through `@kaki/governance`. No new module.
- **D2 — PDFs generated on the server with pdf-lib** (Ken chose this on 2026-10-27). Built from the same registry as the page, so they can't drift; deterministic for tests. If Ken picks the print-page or static option, T4 and T5 change and nothing else. Lockfile change → Ken's local CI is due (STATE.md cadence).
- **D3 — Wordings are immutable rows; settings only point.** A consent record (FEAT-049) will store a `wording_versions.id`, so it must never change: insert-only grants, no-op on identical content. Link-mode notices are versioned too, as GOV-14 asks for notice wordings.
- **D4 — The consent prompt is platform text, snapshotted.** The tenant edits the purpose statement; the question around it ("Is it OK for us to use your details for this?" / 「可以为此使用您的资料吗？」) is fixed copy with `CONSENT_WORDING_VERSION`. Each purpose wording stores both, so the record shows exactly what the visitor read even after the platform copy changes.
- **D5 — The registry is code, dated, English-only.** Sub-processors change by PR (ADR-007/ADR-019 gate); FEAT-073 adds published versions and the 30-day notice. The DPA's full text and the template wording await legal review (SRS §8 item 3; architecture R11), noted on the PDFs and in pending-actions.
- **D6 — Readiness needs an explicit save.** Showing the default purpose statement doesn't count; the Owner must review and save it (UC-03 step 8), so ONB-09's "purpose statement" item means someone looked at it.
- **D7 — The hosted notice is server-rendered HTML on the api role.** No script, strict CSP, token CSS from `@kaki/design-tokens`; it loads fast for visitors and needs no dashboard bundle. English only for now (the template's legal wording is English; a `zh-Hans` template is an open item).
- **D8 — The setup gains its "Rules and privacy" step now.** The IA puts SCR-APP-009 after review; this feature adds the step with the privacy block and renumbers Test (5) and Website (6); FEAT-054 adds the boundary rules and FEAT-035 the frame and skipping.
- **D9 — Out of scope, no placeholders on the page:** retention periods (FEAT-059), terms re-acceptance and sub-processor notices (FEAT-073), showing the purpose statement in chat and recording consent (FEAT-049). Terms show read-only.

## 8. Escalations and open items

- Legal review of the template, the consent prompt and the DPA before pilot (SRS §8 item 3) → pending-actions.
- `zh-Hans` notice template; DPO name in the template is a business contact stored like the profile contacts (not visitor PII, ADR-015).
- FEAT-035 calls `privacyReadiness`; FEAT-034 uses it for the pre-live form (UX-R4); FEAT-049 reads `visitorPrivacy().purpose` and stores `purposeWordingId` and `noticeWordingId` on the consent; FEAT-059 adds retention to the page and the template's "How long we keep it".
- The FEAT-033 E2E comment "no tenant has one until FEAT-058" stays true for the seed (D in §5.4).

## 9. Self-check

GOV-14 → AC-1–AC-3, AC-5; GOV-07 → AC-6, AC-7; GOV-11 → AC-2, AC-6, AC-7; LED-02 (p) → AC-3, AC-5; UC-03 8 → AC-9, 10a → AC-5. ADR-005 → AC-8; ADR-014 → AC-4; ADR-019, ADR-006 → registry (AC-6); ADR-016 unchanged (widget code untouched; config value only). New tables have RLS, policy, `TENANT_SCOPED_TABLES` and RLS cases. Contract changes are additive. Tasks run schema → governance → contracts/api → PDFs → dashboard → E2E → verify. IDs checked: GOV-07, GOV-11, GOV-14, LED-02, ONB-09, AUTH-08, UC-03, UC-35, SCR-APP-009, SCR-APP-047, SCR-APP-012, ADR-005, ADR-006, ADR-014, ADR-015, ADR-019, FEAT-005, FEAT-033, FEAT-034, FEAT-035, FEAT-049, FEAT-054, FEAT-059, FEAT-073, UX-R4 resolve.
