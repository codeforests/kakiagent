# Tasks: FEAT-058 — Privacy notice and template, consent wording, data-processing documents

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-10-27

- [x] T1 — Schema: `wording_versions`, `privacy_settings`, `visitor_privacy()` in `0033_privacy.sql` + Drizzle tables, `TENANT_SCOPED_TABLES`, RLS cases (design §4; AC-3, AC-8)
      Done when: `pnpm db:setup` applies 0033 on a database at 0032 and `drizzle-kit generate` reports no drift; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with the two new RLS cases (tenant B sees and inserts nothing of A's; the composite FK rejects a pointer to A's wording from B's settings); `app_dashboard` UPDATE and DELETE on `wording_versions` fail with permission denied; `visitor_privacy()` as `app_agent_visitor` returns only the current tenant's row and nothing without a tenant context.
- [x] T2 — Governance registry and privacy domain: `registry.ts`, `privacy.ts` (contents, defaults, get, save notice, save purpose, readiness, `visitorPrivacy`) (design §5.1; D3, D4, D6; AC-3–AC-6)
      Done when: governance unit tests: every registry row has non-empty fields, every non-Singapore sub-processor location has a transfer row, all registry text is WinAnsi-encodable; governance integration tests: first save inserts seq 1 and the settings row; a changed save adds seq 2 and moves the pointer; identical content adds nothing; a stale version throws `PrivacyConflictError` and leaves no new wording row; audit payload has only version, seq and mode; readiness false/false → notice only → both; a purpose wording holds purpose and consent prompt in en and zh; `pnpm --filter @kaki/governance typecheck` passes.
- [ ] T3 — Notice template and HTML: `notice-template.ts` (`noticeSections`, `renderNoticeHtml`) (design §5.1; AC-2)
      Done when: unit tests: sections in order with business name, UEN when set and omitted when null, contact, purpose statement, one line per transfer, "Last updated" in SGT `d MMM yyyy`; `<script>`, `&`, quotes in any field render escaped; `extra` splits into paragraphs and keeps no markup; output has `lang="en"` and one `h1`.
- [ ] T4 — PDFs: `documents.ts` with pdf-lib (add the exact-pinned dependency to `@kaki/governance`) (design §5.1; D2; AC-7)
      Done when: unit tests: both PDFs start with `%PDF-`, two calls are byte-identical, extracted text (pdfjs-dist, already in the lockfile, or pdf-lib's own parse) contains every sub-processor name and transfer destination and, for the DPA, its version and the legal-review notice. Note: lockfile change → Ken's local CI due before merge.
- [ ] T5 — Contracts and API: the privacy contract section; `apps/api/src/privacy.ts` (dashboard routes, PDFs, public `/privacy/:key`); 409 mapping; widget config `privacyNoticeUrl`; `@kaki/design-tokens` api dependency (design §3, §5.2; AC-1–AC-8)
      Done when: contracts unit tests parse each body and response variant and reject an http and a `javascript:` URL; api integration tests (`testApp`): GET defaults for a new tenant; link save → config returns the URL; template save → config returns `{PUBLIC_API_URL}/privacy/{key}` and that page is 200 HTML with CSP and `noindex`, escaped values; 404 page for unknown key, suspended tenant, link mode; stale version 409; PDFs 200 `application/pdf` attachment, unknown doc 404; Agent 403 on every dashboard route; tenant B's session never sees A's settings; `pnpm --filter @kaki/api typecheck` passes.

## Build session 2 (UI)

- [ ] T6 — Dashboard data layer: `lib/api.ts` calls, `lib/privacy.ts` helpers (design §5.3; AC-1, AC-9)
      Done when: dashboard unit tests (`--project unit`): `validateNotice` rejects empty link, http and malformed URLs and a template without contact name or email, naming the field per ui-design copy; `noticeDraftOf` and `purposeDraftOf` from each response variant; `samePurpose`; `formatSaved`.
- [ ] T7 — Shared parts and the Privacy and data page: `pages/privacy-parts.tsx`, `pages/privacy.tsx`, route `/settings/privacy`, Settings index row linked (ui-design SCR-APP-047; AC-6, AC-9, AC-10)
      Done when: `pnpm --filter @kaki/dashboard typecheck` and build pass; the page renders every state in ui-design against the dev API (checked in the session's Chromium via Playwright with the API stubbed where no stack exists; screenshots in notes); only `var(--…)` tokens.
- [ ] T8 — Setup step: `pages/setup-rules.tsx` at `/setup/rules`; review's Continue → `/setup/rules`; Test and Website relabelled steps 5 and 6; update `e2e/tests/review.e2e.ts` only if it follows Continue (design §5.3; D8; AC-9)
      Done when: dashboard typecheck passes; the step renders with the two forms and Continue to `/setup/test`; `grep -rn "of the setup" apps/dashboard/src` shows 2–6 in flow order.
- [ ] T9 — E2E `e2e/tests/privacy.e2e.ts` (design §5.4; AC-1, AC-2, AC-7, AC-9, AC-10)
      Done when: the spec typechecks and lints; restore in `afterEach`. Note: runs only in Ken's local CI (no stack in cloud sessions); record "pending CI".
- [ ] T10 — Verify: full `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `test:coverage` for governance, api, dashboard, contracts, db; code-map updated if anything moved; status `developer-done`
      Done when: all pass locally through `scripts/test-env.sh`; evidence below.

## Verification evidence

- AC-1 … AC-10: to be filled by T10.
