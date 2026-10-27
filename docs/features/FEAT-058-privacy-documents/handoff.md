# Handoff: FEAT-058 — Privacy notice and template, consent wording, data-processing documents
Branch: feat/FEAT-058-privacy-documents · PR: none · Updated: 2026-10-27 by design
Stage done: design
Next: build (backend, T1–T5) — kickoff: "Build FEAT-058 (backend) on branch feat/FEAT-058-privacy-documents. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Everything lives in `@kaki/governance` (D1): `registry.ts`, `privacy.ts`, `notice-template.ts`, `documents.ts`; API in a new `apps/api/src/privacy.ts` wired at the end of `app.ts`.
- Wordings are immutable `wording_versions` rows (insert-only grants); `privacy_settings` only points at the current ones, with an optimistic `version` like assistant settings (D3). Identical content saves nothing.
- The visitor zone reads through a new SECURITY DEFINER `visitor_privacy()` (owner `kaki_tenant_state`, like `visitor_tenant_state()` in 0019), never table grants.
- `privacyNoticeUrl` in `/widget/v1/config`: link URL, or `${PUBLIC_API_URL}/privacy/${key}` for the template. The hosted page is server-rendered HTML on the api with strict CSP; its CSS is `@kaki/design-tokens/tokens.css` read at start-up (new api dependency; check the token build runs before api tests).
- PDFs with pdf-lib (D2), deterministic dates; registry text must stay WinAnsi (Helvetica). Check Ken's decision card answer first: if he chose print-page or static PDFs, rewrite T4/T5's PDF parts only.
- Don't seed a notice for the dev tenants: FEAT-033's E2E stubs the URL and the new E2E restores "no notice" in `afterEach`.
- UI session: setup step `/setup/rules` becomes step 4; renumber test (5) and website (6); review's Continue → `/setup/rules`.

## Left to CI or later
- E2E `privacy.e2e.ts` and screen renders: Ken's local CI. The lockfile changes (pdf-lib), so Ken's local CI is due before merge.

## Pending for Ken
- Decision card: how the DPA and data-flow PDFs are produced (recommended: pdf-lib on the server). Build can start on the recommendation.
- Legal review of the notice template, consent question and DPA before pilot (added to pending-actions.md).
