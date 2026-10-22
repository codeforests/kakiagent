# Tasks: FEAT-013 — Fact review, bulk approval and Approve all

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: not started · Last updated: 2026-10-22

- [ ] T1 — kb review domain, single decisions: `review.ts` with `approveFact` (with optional edit and GST choice), `rejectFact`, `approveRows`/`rejectRows` set-based writes, chunk versions, `last_confirmed_at`, the audit entries; `GstRequiredError`; `updateFact` audits `fact.approved` on an approving edit (design §5.1, §5.2; D1, D3, D8; AC-1, AC-3, AC-7)
      Done when: kb integration tests pass: approve/edit-and-approve/reject transitions with versions, chunk at the new version, `last_confirmed_at`, audit entries in order with the actor; the fact enters `visitor_facts`/`visitor_chunks` on approve and not on reject; stale version, wrong status and GST-unknown errors change nothing; an approving PATCH-path edit audits `fact.approved`.
- [ ] T2 — kb review domain, lists and bulk: `listReviewFacts` (order, scope, cursor, passage context), `reviewSummary`, `previewApproveAll` and `approveAll` (hash, stale check), `approveSelected`/`rejectSelected` with skip reasons, `undoReview` (design §5.1; D2, D4, D5, D6, D7; AC-2, AC-4, AC-5, AC-6)
      Done when: kb integration tests pass for ordering and paging, passage slices equal to the page text, filters, the preview counts and exclusions, execute with a matching hash, `preview_stale` after an added, edited and decided fact with nothing approved, scoped execution, bulk skips per reason, the summary entries, undo and its refusals, and another tenant's facts invisible.
- [ ] T3 — Contracts and API: the review section in contracts; `apps/api/src/review.ts` with every route; the error mapping (design §3; AC-2..AC-6, AC-8)
      Done when: api integration tests pass for each designed success and error (list, summary, preview, approve-all 200/409, single approve 200/400 `gst_required`/409/404, edit-and-approve re-embeds, reject, bulk with skips, undo), 403 for `agent`, 401 without a session, and tenant B getting 404/`not_found` with A's rows unchanged.
- [ ] T4 — Scale and audit: a 500-fact Approve all timed on the local stack, and the audit chain verified after it (AC-8 chain half, AC-10)
      Done when: an integration test approves 500 facts within 10 s and `verifyChain` passes; the timing is recorded in the evidence.
- [ ] T5 — Dashboard refactor: `FactForm`'s fields and draft rules move to `pages/fact-fields.tsx` and `lib/fact-draft.ts` with no behaviour change (design §5.4)
      Done when: the dashboard builds and type-checks, and the existing facts E2E spec passes unchanged.
- [ ] T6 — Dashboard Review: `ReviewQueue` and SCR-APP-019 at `/review` (tabs, filters, groups, `fact-card` with passage, flags and the GST choice, single decisions with Undo, edit-and-approve dialog, bulk bar, scoped Approve all dialog with preview and stale handling, keyboard, states), the Review nav count, the hub's placeholder tabs (ui-design SCR-APP-019)
      Done when: `pnpm --filter @kaki/dashboard build` passes and every state in ui-design.md renders against the running stack at 1280 px and 390 px.
- [ ] T7 — Dashboard setup step: SCR-APP-008 at `/setup/review` and the "Next: review your facts" link on `/setup/sources` (ui-design SCR-APP-008)
      Done when: the route renders loading, still-extracting, populated, all-approved and error against the running stack.
- [ ] T8 — E2E: `e2e/tests/review.e2e.ts`: crawl the fixture site, the nav count, single approve with Undo, edit and approve, reject, keyboard, Approve all cancel and confirm with counts and the GST-unknown exclusion, the GST choice, the widget answering with an approved price, `/setup/review`, axe on SCR-APP-019, its dialogs and SCR-APP-008 (AC-9; UC-15)
      Done when: the new spec and the existing E2E suite pass on Chromium against the local stack.
- [ ] T9 — Verify: every AC in design §6 demonstrably passes; format, lint and boundaries, typecheck, unit, integration with coverage, build and size, E2E and evals green; scaffold notes, RTM design refs and the manifest updated
      Done when: all of the above pass in one fresh run, with the evidence recorded here.

## Evidence
