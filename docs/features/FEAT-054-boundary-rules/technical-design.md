# Technical design: FEAT-054 — Boundary rules with safe defaults

> Implements: APR-01 (and AUTH-03's "change boundary rules" re-auth, GOV-01's "rule edits", ONB-06's F&B rules part, ONB-09's "saved boundary rules" readiness item) · Realizes: UC-29 · Screens: SCR-APP-042, SCR-APP-009 (p) · Module: `approvals` (architecture §5.2)
> Status: designed · 2026-10-30

## 1. Intent

The owner sets what the assistant may talk about and promise: allowed and blocked topics, a maximum discount (default 0%), whether quotes need approval (default yes) and forbidden commitments (delivery guarantees, refunds, legal and medical advice, plus the owner's own). A tenant that never saved rules runs on safe defaults. Saving needs a fresh re-authentication, is audited, and applies from the next reply: blocked topics are refused in code, commitment and discount language in model-typed text is blocked by a segment check like ADR-008's verifier, and the rules reach the dispatcher's `checkBoundary` for FEAT-055's `request_commitment` handler.

## 2. Codebase context

- `@kaki/approvals` is an empty placeholder (`src/index.ts` exports nothing). This feature gives it its first file, `rules.ts`; FEAT-055 adds approvals beside it.
- The dispatcher already has the hook: `DispatchContext.boundaryRules()` returns `null` in `turn.ts`, `coach.ts` and `replay-dispatch.ts`; `TaskHandler.checkBoundary(rules, args)` and the `boundary` refusal reason exist (`dispatch.ts`). `BoundaryRules` is `Record<string, unknown>` until now.
- Triage (`plan.ts`) is a fixed `TRIAGE_SYSTEM`; `out_of_scope` has a `topic` arg (`medical|legal|financial|illegal|other`) handled by `outOfScopeHandler`. Advice and illegal declines are already code (AGT-13, FEAT-025), so legal and medical advice are never promised whatever the rules say.
- The verifier already blocks every model-typed number, percentage, date and price (`verify.ts`), so the model can't type "10% off". It can still type "we can give you a discount" or "we guarantee it will arrive", which this feature blocks.
- The reply prompt (`prompt.ts` `buildVisitorPrompt`) has a cached tenant block after the platform rules (`<business>`, then `assistantLines`). The leak guard's `ruleText` cuts `system` at `<business>`, so anything after it is tenant data, not rules.
- Re-auth: `requireReauth(s)` from `@kaki/identity` after the capability check (`apps/api/src/mfa.ts`); dashboard `useReauthGuard().guard(fn)` (`lib/reauth.ts`). This is the first tenant-settings route that needs it.
- Industry templates: `packages/tenancy/src/templates.ts` (F&B only, suggested FAQs); the comment there names this feature for the template's rules.
- `/setup/rules` (`pages/setup-rules.tsx`, FEAT-058) holds the privacy block and names this feature for the rules block above it. The Settings index row "Rules and approvals" has no link yet.
- Versioned settings pattern: FEAT-058's immutable `wording_versions` (insert a new version, never update).

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: boundary rules (APR-01; FEAT-054 §3)`)

```ts
export const COMMITMENT_KEYS = ['delivery_guarantee', 'refund', 'legal_advice', 'medical_advice'] as const;
export const CommitmentKey = z.enum(COMMITMENT_KEYS);
/** Always forbidden: AGT-13 declines advice in code, so these can't be switched off. */
export const LOCKED_COMMITMENTS = ['legal_advice', 'medical_advice'] as const;

const Topic = z.string().trim().min(2).max(80);          // one topic or phrase
const TopicList = z.array(Topic).max(25);                // duplicates (case-insensitive) refused

export const BoundaryRules = z.object({
  allowedTopics: TopicList,
  blockedTopics: TopicList,
  maxDiscountPct: z.number().int().min(0).max(100),
  quotesNeedApproval: z.boolean(),
  forbiddenCommitments: z.array(CommitmentKey),          // must include LOCKED_COMMITMENTS
  customCommitments: z.array(Topic).max(10),             // "same-day delivery"
}).superRefine(/* no duplicate in a list; no topic both allowed and blocked; locked keys present */);

export const BoundaryRulesResponse = z.object({
  rules: BoundaryRules,
  /** null until the first save; the prefill is shown but not in force beyond the defaults. */
  version: z.number().int().positive().nullable(),
  savedAt: z.string().datetime().nullable(),
  /** Where the shown rules come from: the saved version, the industry template, or the safe defaults. */
  source: z.enum(['saved', 'template', 'default']),
});

export const SaveBoundaryRulesRequest = z.object({
  /** The version the form was loaded from (null when never saved): optimistic concurrency. */
  version: z.number().int().positive().nullable(),
  rules: BoundaryRules,
});
// 200 → BoundaryRulesResponse (source 'saved')
```

| Route | Who | Errors |
|---|---|---|
| `GET /api/v1/settings/rules` | `settings.manage` (Owner, Admin) | 403 `forbidden` |
| `PUT /api/v1/settings/rules` | `settings.manage`, then `requireReauth` | 400 `invalid_rules` with Zod issues (path per field), 403 `forbidden`, 403 `reauth_required` (`ReauthRequired`), 409 `rules_stale` (version isn't the current one) |

Order in `PUT`: session → capability → body parse → `requireReauth` → save. Parsing before re-auth means a typo doesn't cost a re-auth round trip; nothing is written before re-auth passes. Saving rules identical to the current version still writes a new version (the owner confirmed them; ONB-09 counts a save).

## 4. Schema changes (migration `0038_boundary_rules.sql` + Drizzle table)

```sql
create table boundary_rules (
  tenant_id uuid not null references tenants(id),
  version integer not null check (version > 0),
  allowed_topics text[] not null default '{}',
  blocked_topics text[] not null default '{}',
  max_discount_pct smallint not null default 0 check (max_discount_pct between 0 and 100),
  quotes_need_approval boolean not null default true,
  forbidden_commitments text[] not null
    default '{delivery_guarantee,refund,legal_advice,medical_advice}'
    check (forbidden_commitments <@ array['delivery_guarantee','refund','legal_advice','medical_advice']
       and forbidden_commitments @> array['legal_advice','medical_advice']),
  custom_commitments text[] not null default '{}',
  created_by uuid not null,            -- user ID (no FK into identity's zone; as wording_versions)
  created_at timestamptz not null default now(),
  primary key (tenant_id, version),
  check (cardinality(allowed_topics) <= 25 and cardinality(blocked_topics) <= 25
         and cardinality(custom_commitments) <= 10)
);
alter table boundary_rules enable row level security;
alter table boundary_rules force row level security;
create policy tenant_isolation on boundary_rules using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert on boundary_rules to app_dashboard;   -- no update, no delete: history is immutable
grant select on boundary_rules to app_visitor;             -- the turn reads the current version
```

- The current rules are the row with the highest `version` for the tenant; no row means the safe defaults (§5.1). Copy the policy and `current_tenant_id()` helper names from the newest migration; they may differ.
- Name in `TENANT_SCOPED_TABLES`; RLS suite cases: tenant B can't read A's rules; inserting a row with A's ID in B's context fails; `app_dashboard` update and delete are permission denied; `app_visitor` insert is denied.
- The `(tenant_id, version)` primary key is the concurrency control: two saves from version 3 both try version 4, the loser gets a unique violation → 409 `rules_stale`.

## 5. Component design

### 5.1 Approvals (`packages/approvals/src/rules.ts`, exported from `src/index.ts`)

- `interface BoundaryRules` (the same fields as the contract; domain packages don't import `@kaki/contracts`, so the API maps between them and a contract unit test checks the keys match), `COMMITMENT_KEYS`, `LOCKED_COMMITMENTS` and `SAFE_DEFAULTS`: no topics, `maxDiscountPct: 0`, `quotesNeedApproval: true`, all four commitments forbidden, no custom ones.
- `currentRules(tx, tenantId): Promise<{ rules; version; savedAt } | null>` — highest version; works on the dashboard and visitor zones.
- `rulesInForce(tx, tenantId): Promise<{ rules; version: number | null }>` — `currentRules` or `SAFE_DEFAULTS` with `version: null`. The agent uses this.
- `saveRules(tx, tenantId, { expectedVersion, rules, userId })` — inserts `expectedVersion + 1` (1 when null); a unique violation, or `expectedVersion` not equal to the current version, throws `RulesStale`. Normalises before insert: trim, collapse inner spaces, case-insensitive dedupe keeping the first spelling. Appends one audit entry in the same transaction: action `rules.updated`, actor `user` (user ID), subject `tenant`/tenantId, payload `{ version, changed: [...] }` where `changed` lists the field codes that differ from the previous version (`allowed_topics`, `blocked_topics`, `max_discount`, `quotes_need_approval`, `forbidden_commitments`, `custom_commitments`) — codes only, never topic text (ADR-014); the version row holds the values.
- `rulesSaved(tx, tenantId): Promise<boolean>` — ONB-09's "saved boundary rules" item, for FEAT-035's readiness check.
- `commitmentDecision(rules, { discountPct?: number }): 'refuse' | 'needs_approval' | 'allowed'` — pure: a discount above `maxDiscountPct` → `refuse`; otherwise `needs_approval` when `quotesNeedApproval`, else `allowed`. FEAT-055's `request_commitment` handler calls it from `checkBoundary`; this feature tests it only.
- `approvals` depends on `@kaki/db` and `@kaki/governance` (audit), like `kb`; `@kaki/agent` and `apps/api` add `@kaki/approvals` to their package.json (dependency-cruiser's `no-non-package-json`). No cycle: approvals imports neither agent nor tenancy.

### 5.2 Industry template (`packages/tenancy/src/templates.ts`)

`IndustryTemplate` gains `suggestedRules: { allowedTopics: string[]; blockedTopics: string[] }`. F&B (D1): allowed "Menu and prices", "Custom and celebration cakes", "Ordering and notice needed", "Delivery and self-collection", "Allergens, halal and dietary needs", "Payment", "Events and bulk orders"; blocked "Competitors' prices", "Health or weight-loss claims". Commitments and discounts stay at the safe defaults for every industry (the template only fills topics; D3). The template is a suggestion: it's in force only once saved.

### 5.3 Agent (`packages/agent/src`)

- **Type:** `dispatch.ts` `BoundaryRules` becomes the approvals type (re-exported); `boundaryRules()` in `turn.ts`, `coach.ts` and `replay-dispatch.ts` returns the rules loaded for the turn (below), never null from now on. Its doc comment drops "Null until FEAT-054".
- **Load:** `runVisitorTurn` reads `rulesInForce(tx, tenantId)` in its first transaction (visitor zone), next to the gate check. No cache: the next turn after a save sees the new version (UC-29 3). Coaching (`runCoachingTurn`) loads it on the dashboard zone, so the owner tests what visitors would get; replay does the same (it re-answers under current settings).
- **Blocked topics, in code** (`boundary.ts`, new): `blockedTopicHit(rules, text): boolean` — the visitor's latest message, NFKC-normalised and lower-cased, contains a blocked topic as a whole-word phrase (a trailing `s`/`es` on the last word allowed; CJK topics as a plain substring). After triage, `applyBoundary(plan, rules, text)` turns the plan's `answer` tasks into `out_of_scope` with `topic: 'blocked'` when either the phrase matches or triage already returned `out_of_scope` `topic: 'blocked'`. `OutOfScopeArgs.topic` gains `blocked`; `outOfScopeHandler` maps it to a new `ReplyKey` `blocked_topic`. Other tasks in the plan (escalate, capture_lead, …) run as before.
- **Triage sees the topics** (`plan.ts`): when the tenant has allowed or blocked topics, the triage request gets a `tail` (uncached, after the fixed system) "Topics this business handles: …. Topics it doesn't discuss: …" with each topic through `asData`. `TRIAGE_SYSTEM` adds one line: `out_of_scope` topic `blocked` = the message is about a topic the business doesn't discuss (listed after the messages). This catches paraphrases and other languages that the phrase match misses; the phrase match is the floor (D2). No tail when both lists are empty, so prompts for tenants without topics don't change.
- **Texts** (`texts.ts`, every language present): `blockedTopic(b)` — en "Sorry, I can't help with that here. I'm happy to help with other questions about {b}.", zh "抱歉，这个问题我无法在这里回答。关于 {b} 的其他问题，我很乐意为您解答。", and the other languages the file holds in the same pattern. `answer.ts` `render` gains the case.
- **Reply prompt** (`prompt.ts`): `rulesLines(rules)` after `assistantLines`, in the cached tenant block (changes only on save): `<rules>` with "Topics you help with: …" (if any), "Topics you never discuss; say you can't help with that: …" (if any), and fixed lines from the rule values: "Never offer or hint at a discount; say the team will confirm any special price." (always while FEAT-055 isn't built: D4), "Never quote a total or accept a custom order; say the team will confirm it." when `quotesNeedApproval`, "Never promise: {delivery dates or guaranteed delivery}, {refunds or money back}, {custom phrases}" for the forbidden ones. Topic and phrase values go through `asData`.
- **Segment check** (`boundary.ts` `boundaryGuard(rules)` → `check(text, spans): Violation[]`), run in `compose.ts` after the leak guard on the same model-typed text (slot spans masked, like `verifySegment`): new `ViolationKind`s `commitment` and `discount_offer`.
  - `discount_offer` (always on, D4): offer phrasing, not the word: `(?:we|i)\s*(?:can|could|will|'ll|would)\s+(?:give|offer|do|provide|arrange|apply)\s+(?:you\s+)?(?:a|an|some)?\s*(?:\w+\s+)?(?:discount|special price|cheaper price|promo)`, `(?:discount|promo)\s+(?:for you|is possible|can be arranged)`, zh `(给|帮)?您?(打折|优惠|折扣)`. "We don't offer discounts" doesn't match.
  - `commitment` per forbidden key: `delivery_guarantee` — `guarantee[ds]?|guaranteed` within 6 words of `deliver|arrive|reach|on time`, `(?:will|'ll)\s+(?:definitely|surely|certainly)\s+(?:arrive|be delivered|reach)`, zh `保证.{0,6}(送达|到)`; `refund` — `(?:we|i)\s*(?:can|will|'ll)\s+(?:give|offer|issue|process|arrange)\s+(?:you\s+)?(?:a\s+)?(?:full\s+)?refund`, `money[- ]back`, `refund(?:ed)?\s+in full`, zh `(给您|可以)?退款`; custom phrases — whole-phrase, case-insensitive. Legal and medical advice are already declined in code; the guard adds nothing for them.
  - A violation fails the segment like a verifier failure: one regeneration with the violation named ("a commitment the business doesn't allow"), then the escalation text (existing `composeReply` path). The audit records `guardrail.boundary_commitment` / `guardrail.boundary_discount` through the existing guardrail-hit audit in `store()`.
- **Audit:** `agent.decision` gains `rulesVersion` (number or null) so each reply records which rules applied (GOV-01, code-only payload); a blocked-topic refusal records `guardrail.boundary_topic`.
- **Fakes and evals:** `fake-triage.ts` returns `out_of_scope` `topic: 'blocked'` when its tail lists a blocked topic contained in the message; `fake-responder.ts` gets a scripted reply with a delivery guarantee and one with a discount offer for the guard tests. New `evals/cases/feat-054-boundary.json` (about 12 cases): blocked topic by phrase, by paraphrase (fake triage via the tail), in zh; a multi-task message (blocked topic + an answerable question → refusal; the dispatch order holds); discount ask with default rules → no offer; delivery-date ask → no guarantee; a "we don't offer discounts" answer passes. Thresholds unchanged unless a new metric is added (then add it to `thresholds.json`).

### 5.4 API (`apps/api/src/rules.ts`, `registerRuleRoutes(app, deps, sessionFrom)`, wired at the end of `app.ts`)

- `GET`: `currentRules` on the dashboard zone; if none, the tenant's profile industry template (`tenancy` profile read) merged into `SAFE_DEFAULTS` → `source: 'template'`, else `'default'`.
- `PUT`: as §3. `RulesStale` → 409 `rules_stale`; Zod failure → 400 `invalid_rules` with issues in the shape the other settings routes use (copy from `apps/api/src/privacy.ts`).
- Tests in `apps/api/test/rules.int.test.ts`: Owner and Admin read and save; Agent 403 on both; stale re-auth (`staleReauth`, as `mfa.int.test.ts`) → 403 `reauth_required` and nothing written; 409 on a stale version; 400 on duplicate topic, topic in both lists, missing locked key, 101%; exactly one `rules.updated` entry per save with `changed` codes and no topic text; tenant B can't read or overwrite A's rules; template prefill for an F&B tenant with no saved rules.

### 5.5 Dashboard (detail in ui-design.md)

- `lib/rules.ts`: `useRules()` (query `['rules']`), `useSaveRules()` whose `mutationFn` is wrapped in `useReauthGuard().guard`, and the pure helpers `diffRules(before, after)` (the confirm dialog's change lines) and `topicError(list, value)` (client-side duplicate/length checks mirroring the contract), unit-tested in `lib/rules.test.ts`. `api.getRules`, `api.saveRules` in `lib/api.ts`.
- `pages/rules-parts.tsx`: `RulesForm` (topics, discounts and quotes, never promise, footer with Save) and `TopicListEditor` (input + Add, list with Remove; the widget's origin-list pattern). Used by `pages/rules.tsx` (SCR-APP-042, `/settings/rules`) and `pages/setup-rules.tsx` (SCR-APP-009, above the privacy block).
- Router: `settings/rules` → `RulesPage`. Settings index: the "Rules and approvals" row links to `/settings/rules`.
- `setup-rules.tsx`: the step's "ready" caption counts saved rules too.

### 5.6 E2E (`e2e/tests/rules.e2e.ts`)

The dev Owner opens `/settings/rules` (fresh re-auth state as in `two-step.e2e.ts`; reset its `reauth_at` first to also cover the re-auth dialog in one browser), adds a blocked topic, raises the discount, saves through the confirm dialog, sees the toast; reload shows the saved values. A widget visitor then asks about the blocked topic and gets the refusal (fake provider). axe checks on the page and both dialogs, light and dark, at 375 px. `afterEach` restores the dev tenant's rules by saving the defaults (data from a failed run breaks later specs; code-map E2E pitfalls).

## 6. Acceptance criteria

- **AC-1** (APR-01 "defaults are safe"; UC-29 1) A tenant with no saved rules runs on `SAFE_DEFAULTS` (no topics, 0% discount, quotes need approval, all four commitments forbidden): `rulesInForce` returns them with `version: null`, and `GET /settings/rules` shows them (`source: 'default'`), or for an F&B tenant the template topics with the same safe values (`source: 'template'`, ONB-06).
- **AC-2** (APR-01 configuration; UC-29 2) Owner and Admin can save allowed and blocked topics, maximum discount, quotes-need-approval, forbidden commitments and custom commitments; the response and a reload return the saved values with the new version. Invalid input (duplicates, a topic in both lists, a missing locked commitment, a discount outside 0–100, too many items) is refused with 400 and field paths; legal and medical advice can't be switched off.
- **AC-3** (AUTH-03 "change boundary rules"; UC-29 3) Without a re-authentication in the last 10 minutes, `PUT` returns 403 `reauth_required` and writes nothing; in the dashboard the re-auth dialog opens and the save completes after it. Agents get 403 on both routes.
- **AC-4** (APR-01 "changes are recorded in the audit log"; GOV-01) Each save appends exactly one `rules.updated` entry (actor user ID, version, changed field codes; no topic text), in the same transaction as the new version; earlier versions are never updated or deleted (no grant); the chain verifies.
- **AC-5** (UC-29 3 "applies them to the next reply") After a save, the next visitor turn uses the new version (recorded as `rulesVersion` in `agent.decision`), with no restart or cache delay; coaching uses the same rules.
- **AC-6** (APR-01 blocked topics) A visitor message about a blocked topic, by phrase match or by triage's `blocked` topic, gets the `blocked_topic` text with no reply-model call for that part; other tasks in the same plan still dispatch; `guardrail.boundary_topic` is audited.
- **AC-7** (APR-01 forbidden commitments, max discount; ADR-008 decision 3) A model-typed segment that offers a discount, guarantees delivery, offers a refund (when forbidden) or contains a custom forbidden phrase is never released: one regeneration, then the escalation text; the guardrail is audited. Unticking `delivery_guarantee` or `refund` stops that check; a segment saying the business doesn't offer discounts is released.
- **AC-8** (APR-01 quotes, max discount; ADR-025 decision 2) `commitmentDecision` refuses a discount above the maximum, and otherwise returns `needs_approval` when quotes need approval and `allowed` when not; `DispatchContext.boundaryRules()` returns the rules in force (never null) in visitor, coaching and replay turns.
- **AC-9** (ONB-09 readiness item; SCR-APP-009) `rulesSaved` is false until the first save and true after; the setup step shows the rules form above the privacy block and its "ready" caption counts saved rules.
- **AC-10** (ADR-005) Tenant B can't read, insert or overwrite tenant A's rules (RLS suite and API case); `app_visitor` can only select.
- **AC-11** (SCR-APP-042, SCR-APP-009; design.md §4.10, NFR-08/INB-06) Save goes confirm-dialog (with the change lines) → re-auth if needed → server acknowledgement → toast; never optimistic; a 409 shows the conflict alert with Reload; no serious axe violations in light and dark; usable at 375 px.

## 7. Decisions

- **D1 — Rules are immutable versions in one table.** Each save inserts a row; the newest is in force. This gives the audit entry a version to point at without putting values in the chain (ADR-014), lets FEAT-055 record which rules a draft was checked against, and makes the primary key the concurrency check. The plan's single `boundary_rules` table holds the history; no second table.
- **D2 — Blocked topics: code phrase match as the floor, triage for paraphrases.** A phrase match alone misses "do you sell anything like Brand X's" for "competitors' prices" and every other language; triage alone could miss a listed phrase. Both feed one `out_of_scope` `blocked` task, so the refusal is code (ADR-025 decision 3). The topics go in triage's uncached tail, so the fixed triage prefix stays cached (ADR-007).
- **D3 — Allowed topics guide; they don't gate.** "Only these topics" can't be enforced deterministically, and triage's `out_of_scope` already handles unrelated questions. Allowed topics go to triage and the reply prompt to sharpen that judgment. The template fills topics only; commitment and discount values stay at the safe defaults for every industry.
- **D4 — No discount is offered in text until FEAT-055.** The verifier already blocks typed percentages; the guard also blocks discount offers whatever `maxDiscountPct` says, because within-maximum discounts must go through `draft_approval` (APR-02), which FEAT-055 builds on `commitmentDecision`. `maxDiscountPct` and `quotesNeedApproval` are stored, shown and tested now, and enforced at dispatch in FEAT-055. APR-01 is about configuring the rules with safe defaults and auditing them, so it isn't partial; the enforcement of discount and quote values is FEAT-055's APR-02.
- **D5 — The segment guard is a rule set, no classifier.** ADR-008 decision 3 mentions "a Haiku classifier on the triage path": triage's existing `request_commitment` task is that classifier. A second model call per segment would break the streaming latency budget; the patterns target offer phrasing, and the evals hold the false-positive cases.
- **D6 — Legal and medical advice stay forbidden.** AGT-13 declines advice in code (FEAT-025), so the checkboxes are shown checked and disabled ("Always on"), and the contract and the table check require them.
- **D7 — Validation before re-auth.** A bad form is refused before asking the user to confirm it's them; nothing is written until re-auth passes.
- **D8 — Approval SLA and approval rights stay out.** SCR-APP-042 also lists them, but they're APR-04 and D3's approver rights (FEAT-055); the page shows a short "Approvals" section placeholder naming that feature rather than empty controls.

## 8. Escalations and open items

- FEAT-035 reads `rulesSaved` for the readiness checklist (ONB-09); record it in its plan row's hand-off when it's designed.
- FEAT-055 registers `request_commitment` with `checkBoundary` on `commitmentDecision`, relaxes D4's always-on discount guard to "no offer outside a `draft_approval` result", and adds the SLA and approver rights to SCR-APP-042.
- Other industry templates (ONB-06 Should) fill `suggestedRules` when they're built (M7).
- Widget, dashboard and agent files change → GitHub CI (E2E, size) in the verify stage.

## 9. Self-check

- Every APR-01 criterion maps to an AC (safe defaults AC-1, configuration AC-2, audit AC-4), and UC-29 steps 1–3 to AC-1, AC-2, AC-3/AC-5.
- New tenant table with forced RLS, a policy, `TENANT_SCOPED_TABLES` and RLS cases in the same task (AC-10); no update or delete grant.
- Enforcement goes through the dispatcher and the existing compose verification path; no new task kind (`blocked` is an argument of `out_of_scope`) and no side path (ADR-025, ADR-008).
- Audit payloads carry codes and IDs only (ADR-014); topic text lives in the tenant-scoped version row.
- Tenant ID from the session only; no provider SDK outside the gateway; only `var(--…)` tokens and design.md components in the UI.
