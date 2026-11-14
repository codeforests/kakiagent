# Technical design: FEAT-060 — Audit log viewer, chain verification and export

> Implements: GOV-02, GOV-01 (p: the Owner/Admin "Verify audit chain" action of ADR-014 decision 6; the chain and the CLI are FEAT-002), AUTH-03 (p: "export … audit data" re-auth) · Realizes: UC-32 (steps 1–3) · Screens: SCR-APP-050 (new), SCR-APP-014 (p: "View audit log" link in the context sidebar) · ADRs: ADR-014, ADR-005, ADR-015, ADR-020, ADR-023
> Status: designed · 2026-11-14

## 1. Intent

Owners and Admins can read their business's audit log in the dashboard: every agent decision, human action and admin event FEAT-002's chain records. They filter by date range, conversation, actor and event type, open one entry to see its details, run "Verify audit chain" (which recomputes the whole chain and compares it with the S3 anchors, reporting intact or the first broken entry), and export the filtered entries as CSV or JSON after re-authentication. Thirty days of entries export in under a minute (GOV-02). Agents don't see the log. Nothing here writes to the chain except the two new events it records (`audit.verified`, `audit.exported`).

## 2. Codebase context

- **The chain (FEAT-002):** `audit_entries` (PK `(tenant_id, seq)`; indexes `(tenant_id, ts)` and GIN `subject_refs`; append-only by trigger), `audit_pii`, `audit_heads`. `app_dashboard` already has `SELECT, INSERT` on `audit_entries` and `SELECT` on `audit_pii` (0005), so **no migration**. `subject_refs` holds `type:id` strings, the primary subject first (`subjectRefs` in `governance/src/payload.ts`); every message/turn entry carries `conversation:<id>`.
- **Verification:** `verifyChain(zdb, tenantId, { anchors })` in `governance/src/verify.ts` returns `VerifyResult` (`ok`, `checked`, `headSeq`, `anchorsChecked`, `piiChecked`, `broken?: { seq, reason: BreakReason }`). Anchors come from `createS3AnchorStore({ bucket, region, endpoint }).list(tenantId)` (a listing of `audit/<tenant>/`; no GetObject). Today only the scheduler and `pnpm audit:verify` use them.
- **Actors:** `actor_type` is `agent | user | operator | system | visitor`; `actor_ref` is a user ID for `user`. Names come from identity `memberNames(tx, ids)` (current memberships only).
- **Patterns reused:** the export route and its re-auth (`apps/api/src/leads.ts` `/leads/export`, `requireReauth`, `csvCell` in `leads/src/export.ts`), the keyset list (`listLeads`), `useReauthGuard` and the leads `ExportDialog` (blob download), filters in the URL (`leadsQueryOf`), the Settings index row "Audit log" (no `to` yet) in `pages/settings.tsx`, the inbox `ContextSidebar` in `conversation-parts.tsx`.
- **Event types in use today** (84, from `grep "action: '"`): `agent.*`, `tool.*`, `coach.*`, `message.*`, `conversation.*`, `handoff.*`, `inbox.*`, `fact.*`, `kb.*`, `kb_source.*`, `correction.*`, `approval.*`, `rules.*`, `contact.*`, `consent.*`, `lead.*`, `tracking.*`, `member.*`, `tenant.*`, `terms.*`, `settings.*`, `widget.*`, `channel.*`, `onboarding.*`, `escalation.*`, `ai.*`, `audit.*`.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: audit log (GOV-01, GOV-02; FEAT-060 §3)`)

All routes need the session's `audit.read` capability (new; Owner and Admin, D2): 403 `forbidden` otherwise. Tenant from the session only.

```ts
export const AUDIT_EVENT_GROUPS = [
  { key: 'conversations', prefixes: ['conversation.', 'message.', 'handoff.', 'inbox.'] },
  { key: 'assistant',     prefixes: ['agent.', 'tool.', 'coach.', 'ai.'] },
  { key: 'knowledge',     prefixes: ['fact.', 'kb.', 'kb_source.', 'correction.'] },
  { key: 'approvals',     prefixes: ['approval.', 'rules.'] },
  { key: 'contacts',      prefixes: ['contact.', 'consent.', 'lead.', 'tracking.'] },
  { key: 'team',          prefixes: ['member.', 'tenant.', 'terms.'] },
  { key: 'settings',      prefixes: ['settings.', 'widget.', 'channel.', 'onboarding.', 'escalation.'] },
  { key: 'audit',         prefixes: ['audit.'] },
] as const;                                   // anything else is group 'other'
export const AuditGroup = z.enum([...keys, 'other']);
export function auditGroupOf(eventType: string): AuditGroup; // pure, Zod-free; also exported as @kaki/contracts/audit for the dashboard
export const AUDIT_PAGE_MAX = 100;
export const AUDIT_EXPORT_MAX = 100_000;

export const AuditQuery = z.object({          // GET query; all optional
  from: IsoDate.optional(), to: IsoDate.optional(),   // 'YYYY-MM-DD', SGT days, inclusive; from ≤ to
  conversation: z.string().uuid().optional(),
  actorType: z.enum(ACTOR_TYPES).optional(),
  actor: z.string().uuid().optional(),        // a member; implies actorType 'user'
  group: AuditGroup.optional(),
  before: z.coerce.number().int().positive().optional(),  // keyset: seq < before
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(50),
}).strict();
export const AuditSubject = z.object({ type: z.string(), id: z.string() });
export const AuditRow = z.object({
  seq: z.number().int(), ts: z.string().datetime(),
  actorType: z.enum(ACTOR_TYPES), actorId: z.string().nullable(), actorName: z.string().nullable(),
  eventType: z.string(), group: AuditGroup,
  subjects: z.array(AuditSubject),            // parsed from subject_refs, primary first
  payload: z.record(z.unknown()),
  pii: z.enum(['none', 'kept', 'erased']),    // pii_ref null / row present / row deleted (D5)
  prevHash: z.string(), hash: z.string(),
});
export const AuditPage = z.object({ entries: z.array(AuditRow), next: z.number().int().nullable() });
export const AuditFilters = z.object({ members: z.array(z.object({ id: z.string().uuid(), name: z.string() })) });
export const BREAK_REASONS = ['hash_mismatch', 'link_mismatch', 'seq_gap', 'anchor_mismatch', 'truncated', 'pii_commitment_mismatch'] as const; // = governance BreakReason (a type test keeps them equal)
export const AuditVerifyResult = z.object({
  ok: z.boolean(), checked: z.number().int(), headSeq: z.number().int(),
  anchors: z.enum(['checked', 'none_yet', 'unavailable']), anchorsChecked: z.number().int(),
  piiChecked: z.number().int(),
  broken: z.object({ seq: z.number().int(), reason: z.enum(BREAK_REASONS) }).nullable(),
  verifiedAt: z.string().datetime(), durationMs: z.number().int(),
});
export const AuditLastVerified = z.object({ last: AuditVerifyResult.pick({ ok: true, headSeq: true, verifiedAt: true }).extend({ by: z.string().nullable() }).nullable() });
export const AuditExportBody = AuditQuery.omit({ before: true, limit: true }).extend({ format: z.enum(['csv', 'json']) }).strict();
export const AuditTooMany = z.object({ error: z.literal('too_many'), count: z.number().int(), max: z.number().int() });
```

| Route | Answer |
|---|---|
| `GET /api/v1/audit/entries?…` | 200 `AuditPage`, newest first (`seq` desc); `next` = last seq when more remain. 400 on a bad query (`to` before `from`, `actor` with a non-`user` `actorType`). |
| `GET /api/v1/audit/entries/:seq` | 200 `AuditRow`; 404 `not_found`. |
| `GET /api/v1/audit/filters` | 200 `AuditFilters` (current members, display name or email). |
| `GET /api/v1/audit/verification` | 200 `AuditLastVerified` (from the latest `audit.verified` entry; `by` = member name). |
| `POST /api/v1/audit/verify` | 200 `AuditVerifyResult` (also when broken: `ok: false`). 409 `verify_running` when another verify holds the tenant lock; 429 `verify_cooldown` + `retryAfterS` within 30 s of the last one (D4). |
| `POST /api/v1/audit/export` | `requireReauth` → 403 `reauth_required`. 413 `AuditTooMany` above `AUDIT_EXPORT_MAX`. 200 `text/csv; charset=utf-8` or `application/json`, `Content-Disposition: attachment; filename="audit-log-YYYY-MM-DD.csv|json"`, `Cache-Control: no-store` (D1). |

## 4. Schema changes

None. No new table or column; no RLS change. The two new event codes are plain `event_type` values. (`audit_entries` is already in `TENANT_SCOPED_TABLES` with its RLS case.)

## 5. Component design

### 5.1 Reading (`governance/src/audit-read.ts`)

- `auditWhere(tenantId, q)` builds one SQL condition: `tenant_id = $t`; `ts >= from 00:00 +08` and `ts < (to + 1 day) 00:00 +08`; `subject_refs @> array['conversation:<id>']` (GIN); `actor_type = $` / `actor_ref = $`; group as `event_type like any(array['fact.%', …])`, `other` as `not like all(<every prefix>)`. Shared by list, count and export so they can't disagree.
- `listAudit(tx, tenantId, q)` → `seq < before` when given, `order by seq desc limit limit + 1`; left join `audit_pii p on p.tenant_id = e.tenant_id and p.id = e.pii_ref` for `pii` (`none` when `pii_ref` is null, `kept` when the row exists, `erased` otherwise; the PII row's data is never selected, D5). Names through one `memberNames` call per page; a user no longer a member gets `actorName: null` (UI: "Former member").
- `auditEntry(tx, tenantId, seq)`, `auditCount(tx, tenantId, q)`.
- Mapping `toAuditRow` (pure, unit-tested): `subject_refs` "type:id" → `{ type, id }` (split at the first `:`), `group` via `auditGroupOf`.

### 5.2 Verification (`governance/src/audit-verify.ts`)

`verifyForDashboard(zdb, tenantId, { anchors, userId, now })`:
1. The latest `audit.verified` entry's `ts` within 30 s → `VerifyCooldown(retryAfterS)`. Then a **session-level** `pg_try_advisory_lock(hashtextextended('audit-verify:' || tenant, 0))` on one checked-out connection, held across the read and released in `finally` (a transaction-level lock would end before `verifyChain`'s own transaction); not acquired → `VerifyRunning`.
2. Anchors: `anchors.list(tenantId)`; an S3 error → run without anchors and report `anchors: 'unavailable'`; an empty list → `'none_yet'` (a chain younger than the first 15-minute anchor run); else `'checked'`.
3. `verifyChain(zdb, tenantId, { anchors: fixed list })` over the **whole chain** (D3).
4. Appends `audit.verified` (actor user, subject `tenant:<id>`, payload `{ ok, checked, head_seq, anchors, anchors_checked, broken_seq?, reason? }`, numbers and codes only) in its own transaction after the read, so its seq is above the verified head.
5. A broken chain also logs `logger.error` with the tenant ID and seq (ops alerting picks it up; tenant-facing alerting is a follow-up, §8).

### 5.3 Export (`governance/src/audit-export.ts`)

`exportAudit(tx, tenantId, body)`: `auditCount` → `AuditTooMany` above the cap; then pages of 2,000 in `seq` order (oldest first) bounded by the head seq read at the start, so the file is a consistent snapshot even while appends continue. Returns `{ rows, count }`; `auditCsv(rows)` and `auditJson(rows, meta)` are pure.

- **CSV** columns: `seq, time_sgt, time_utc, actor_type, actor_id, actor_name, event_type, subjects, payload, personal_data, prev_hash, hash`. `subjects` space-separated `type:id`; `payload` canonical JSON (`canonicalJson`); BOM and CRLF as the leads CSV; every cell through the same formula-injection rule as leads `csvCell` (copied into governance: governance may not import leads).
- **JSON**: `{ tenant_id, exported_at, filters, count, entries: [{ tenant_id, seq, ts, actor_type, actor_ref, actor_name, event_type, subject_refs, payload, pii_ref, pii_commitment, personal_data, prev_hash, hash }] }`: every hashed field kept verbatim, so an auditor can recompute `hash` with the documented algorithm (`chain.ts` `hashInput`).
- The route appends `audit.exported` (payload `{ format, count, from?, to?, group?, actor_type?, conversation_id?, actor_id? }`; IDs and codes only) in the same transaction, after the snapshot bound, so it isn't in its own file. Personal data from `audit_pii` is never exported (D5).

### 5.4 API (`apps/api/src/audit.ts`, `registerAuditRoutes(app, deps, sessionFrom)`)

Six routes per §3 through `member(req, 'audit.read')`, all on `dashboardDb` with `withTenant`. `Deps` gains `auditAnchors: AnchorSource` built in `main.ts` from new config `AUDIT_ANCHOR_BUCKET` (+ the existing `AWS_REGION`/`AWS_ENDPOINT_URL`); tests pass a fake. Export: `requireReauth(s)` after the capability check (AUTH-03).

### 5.5 Identity

`Capability` gains `audit.read` (Owner, Admin). Agents get 403 on every route and the dashboard hides the Settings row and the sidebar link.

### 5.6 Infrastructure

- `apps/api/.env.example` + `config.ts`: `AUDIT_ANCHOR_BUCKET` (local `kaki-local-audit-anchors`); `gen-local-env.mjs` writes it.
- Terraform `envs/prod/main.tf`: api env `AUDIT_ANCHOR_BUCKET`; new policy document `audit_anchor_reader` attached to the api task role: `s3:ListBucket` on the anchors bucket with condition `s3:prefix` `audit/*`, `kms:Decrypt` not needed (listing only). `terraform validate` and `terraform test` pass.
- No exports bucket use (D1).

### 5.7 Dashboard (UI session; ui-design.md)

`/settings/audit` → `pages/audit.tsx` (SCR-APP-050) with parts in `pages/audit-parts.tsx` (`AuditFiltersBar`, `AuditTable`, `EntryDetail` slide-over, `VerifyCard`, `AuditExportDialog`); data, URL mapping (`auditQueryOf`/`auditSearchOf`), event texts and pure helpers in `lib/audit.ts`. Settings index row gets `to`; Agents don't see it. Inbox `ContextSidebar` gains "View audit log" for Owner/Admin → `/settings/audit?conversation=<id>`.

### 5.8 Seed and performance

- Dev seed: nothing new; the dev tenants already have entries from seeding and use.
- Perf (GOV-02 "30 days in ≤ 1 minute"): `governance/test/audit-export.int.test.ts` bulk-inserts 75,000 entries (ADR-014 §8's A1 volume) through a test helper that builds a valid chain in JS (`entryHash`) and inserts it with multi-row `INSERT`s as the test superuser (setting `audit_heads`), then asserts `exportAudit` + `auditCsv` and `auditJson` each finish in < 60 s and the same data verifies with `verifyChain` (time logged, asserted < 60 s).

## 6. Acceptance criteria

- **AC-1** (GOV-02 "audit viewer with filters"; UC-32 1) `GET /audit/entries` returns the tenant's entries newest first with keyset paging; each filter (SGT date range inclusive, conversation, actor type, member, group incl. `other`) narrows to exactly the matching entries and they combine; tenant B never sees tenant A's entries (cross-tenant case); Agent → 403.
- **AC-2** (GOV-01 "references and masked values only"; D5) Rows carry `pii` `none`/`kept`/`erased` correctly (an `erasePii` turns `kept` into `erased`); no route or export ever returns `audit_pii.data`.
- **AC-3** (GOV-01 "verification tool"; UC-32 2; ADR-014 d6) `POST /audit/verify` on an intact chain with anchors returns `ok: true`, `anchors: 'checked'`, `checked` = head seq; after tampering an entry's payload as superuser (trigger disabled in the test) it returns `ok: false` with `broken.seq` = that entry and `hash_mismatch`; a deleted anchor-covered tail gives `truncated`; anchors unavailable → `ok` from the DB check and `anchors: 'unavailable'`; a second call within 30 s → 429; concurrent → 409; each completed verify appends one `audit.verified`, and `GET /audit/verification` returns it.
- **AC-4** (GOV-02 "export (CSV/JSON) for a conversation or a date range"; AUTH-03; UC-32 3) Export without fresh re-auth → 403 `reauth_required`; with it, CSV and JSON contain exactly the filtered entries (conversation filter and date-range filter each tested), JSON entries recompute to their `hash` with `entryHash`, CSV cells starting `=+-@` are prefixed; above the cap → 413 `too_many`; one `audit.exported` entry per export with IDs and codes only, not inside the file; Agent → 403.
- **AC-5** (GOV-02 "export completes for 30 days of data in ≤ 1 minute") 75,000 entries export in under 60 s as CSV and as JSON (§5.8).
- **AC-6** (SCR-APP-050; UC-32 1) The Audit log screen lists entries with time, actor, event text and subject; filters live in the URL and survive reload; "Load more" pages; an entry opens a detail panel with subjects (linked where a screen exists), payload, personal-data state and hashes; empty, filtered-empty, loading and error states as ui-design.
- **AC-7** (SCR-APP-050; UC-32 2) "Verify audit chain" shows verifying → verified ("Chain intact · 12,345 entries checked") or tamper detected (first broken entry, reason in words, "Show entry"), and the last verification time; cooldown and running states are shown, not errors.
- **AC-8** (SCR-APP-050, SCR-APP-014; UC-32 3; AUTH-03) Export dialog (format, count, filters) → re-auth dialog when needed → download and toast; too-many shows its message; the inbox sidebar link opens the log filtered to that conversation; Agents see neither the Settings row nor the link; axe has no serious violations at desktop and at 375 px.

## 7. Decisions

- **D1 — Export is a direct download, not an S3 presigned link.** ADR-014 §8 describes streaming exports "from the reader instance to S3 … via a presigned link". The launch profile (ADR-023) has no reader instance, 30 days at A1 volume is ~75k rows (~30 MB) built in well under a minute, and Ken chose the same direct-download pattern for the leads CSV (FEAT-050 D1). So the export is built in the request and sent as an attachment with `no-store`; no copy of the log is stored, no exports bucket or extra IAM is needed. The cap (`AUDIT_EXPORT_MAX` 100,000) bounds the memory. Listed for architecture §12 in §8; if exports outgrow the cap, the ADR's S3 path is the follow-up.
- **D2 — One capability, `audit.read`, Owner and Admin.** SCR-APP-050 is Owner/Admin; export is gated by the same capability plus re-auth (AUTH-03), as leads.
- **D3 — Verify always checks the whole chain.** A range verify takes its first link on trust (`ChainVerifier` with `fromSeq`), which is weaker than what the screen promises; the CLI keeps `--from/--to`. At A1 volumes a whole-chain check is seconds; the AC-5 perf test logs the 75k-entry verify time as a guide.
- **D4 — One verify at a time per tenant, 30 s cooldown.** A session advisory lock (409) and the latest `audit.verified` time (429) keep a repeated click from re-reading the chain; the cooldown uses the audit log itself, so no new table.
- **D5 — Personal data from `audit_pii` is never shown or exported.** Entries are PII-free by construction (ADR-014 d2); the viewer shows only whether linked personal data is kept or was erased. Showing it would make the audit viewer a second way to read contacts' data outside contact-keyed screens (ADR-015); contact data is reached through the contact and data-request screens (FEAT-061).
- **D6 — Filters are date range (SGT days), conversation, actor (type or member) and event group.** UC-32's "event type" is offered as the eight groups plus Other rather than 84 codes; the detail panel shows the exact code. Conversation filter is reached from the inbox link (IDs aren't typed by hand), with a "Clear" chip.

## 8. Escalations and open items

- **Architecture §12 (for the next architecture amendment):** ADR-014 §8's S3/presigned export path replaced by direct download at launch scale (D1).
- Tenant-facing alert on a detected break (a notification to owners) is not in GOV-01/02; a broken chain is logged at error level for ops. Candidate follow-up (pending-actions).
- Operator actions (FEAT-063 support sessions) will appear here as `actor_type: operator` entries; FEAT-063 only needs its own event texts in `lib/audit.ts`.
- FEAT-059's retention purge adds checkpoint entries (ADR-014 d7); the verifier change is FEAT-059's; the viewer shows a checkpoint like any other entry.

## 9. Self-check

- GOV-02 → AC-1, AC-4, AC-5, AC-6, AC-8; GOV-01 (p) → AC-2, AC-3, AC-7; AUTH-03 (p) → AC-4, AC-8; UC-32 1 → AC-1, AC-6; 2 → AC-3, AC-7; 3 → AC-4, AC-5, AC-8.
- No schema change; tenant from the session only; every route has a cross-tenant case (ADR-005).
- The two new entries carry IDs, codes and counts only; `audit_pii` data never leaves the database (ADR-014, ADR-015).
- Export and verify are code paths, not model output; no model call.
- UI uses design.md `table`/`list`, `field` (date, select), `chip`, `card`, `alert`, `confirm-dialog`, `reauth-dialog`, `pagination`, `empty-state`, `error-state`, `toast`, mono for hashes and IDs; tokens only; sensitive-action pattern §4.10 for export.
