# Tasks: FEAT-039 — Contact identity, verified merge and undo

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: designed · Last updated: 2026-11-10 (design)

- [x] T1 — Schema: `0055_contact_identity.sql` and `schema.ts`: `contact_identities` (checks, the four indexes), `contact_merges`, `contacts.merged_into`/`merged_at`, drop the three `contacts` unique indexes, `leads.superseded_by` and the new `leads_one_open_uq` predicate; forced RLS, policies, grants, `TENANT_SCOPED_TABLES`; NOLOGIN `kaki_contact_merge` with column grants; `contact_merge()` and `contact_unmerge()` (§5.3); the backfill; `rls.int.test.ts` cases (design §4, §5.3; D4, D6, D7; AC-5, AC-7)
      Done when: `drizzle-kit generate` reports no drift after 0055; `scripts/test-env.sh pnpm --filter @kaki/db test:integration` passes with: tenant B can't read A's identities or merges, and `contact_merge` with A's IDs under B's context raises; `app_dashboard` and `app_agent_visitor` can't `update consents set contact_id`; two verified identities with one value fail, two unverified lead-form ones don't; `contact_merge` then `contact_unmerge` on two seeded contacts with conversations, consents, open leads and a Telegram chat restores every row (superseded lead included) and a second unmerge raises; the backfill gives an existing Telegram contact a verified identity.
- [x] T2 — Contracts and capability: the contacts section (§3), `ContextSidebar.contact.verified`/`duplicates`, `LeadDetail.supersededBy`; identity `contacts.merge` for all three roles (design §3, §5.4)
      Done when: `pnpm --filter @kaki/contracts test` (round-trips; `ContactSearchBody` refuses one character and extra keys) and `pnpm --filter @kaki/identity test` pass, and dependants typecheck (`pnpm --filter @kaki/leads --filter @kaki/api --filter @kaki/dashboard typecheck`, fixtures updated).
- [x] T3 — Identity resolution: `channels/src/contacts/identity.ts` (`normaliseIdentity`, `resolveContact`, `addIdentity`, `attachVerified`), the `@kaki/channels/contacts` export; email and Telegram receive switched to it (DMARC `PASS` → verified) (design §5.1; D2, D3, D5; AC-2, AC-3)
      Done when: `pnpm --filter @kaki/channels test` passes (`normaliseIdentity`) and `scripts/test-env.sh pnpm --filter @kaki/channels test:integration` passes a new `contacts.int.test.ts`: verified email → same contact twice, unverified mail joins only the unverified mailbox contact, never a lead-form or verified one; Telegram ID → one contact; concurrent `resolveContact` for one verified value → one contact; `attachVerified` merges the other holder into the older contact with one `contact.merged` (`automatic: true`) audit row; plus `scripts/test-env.sh pnpm --filter @kaki/agent-worker test:integration` (`email-receive.int`) and `pnpm --filter @kaki/api test:integration` (`telegram-hook.int`) still green.
- [x] T4 — Lead capture without typed-detail matching: leads `capture.ts` `contactForCapture` (conversation → same `visitor_id` → new), lead-form identities, display fill; leads list/export/rescore skip `superseded_by`; `contactLeads`, `contactLeadSummary`, `contactOf` with `verified` (design §5.1, §5.4; D1, D6; AC-1, AC-6)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/leads test:integration` passes, with FEAT-049's "returning visitor" and concurrent cases rewritten to the same browser per D1 (note the change in the commit message), and new cases: a typed email held by another contact creates a new contact and leaves the other's leads and consents alone; withdrawing in that chat changes only the new contact; a superseded lead is out of `listLeads` and `exportLeads`.
- [x] T5 — Merge, undo and views: `contacts/merge.ts` (`mergeContacts`, `undoMerge`, errors, audits), `contacts/views.ts` (`contactDetail`, `duplicatesOf`, `duplicateCount`, `searchContacts`) (design §5.2, §5.3; D5–D8; AC-3–AC-6)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/channels test:integration` passes `contact-merge.int.test.ts`: merge moves conversations, consents, leads, Telegram chats, `audit_pii` and identities, fills empty display values, supersedes the second open lead; audit entries carry IDs and counts only; undo restores exactly that and keeps a consent and a conversation created after the merge on the survivor; `already_undone`, `survivor_merged`, `same_contact`, `merged` refusals; duplicates list shared values and skip merged-away contacts; search matches name, email, phone, username.
- [ ] T6 — API: `apps/api/src/contacts.ts` (`GET /contacts/:id`, `POST /contacts/search`, `GET …/merge/:otherId`, `POST …/merge`, `POST /contacts/merges/:mergeId/undo`), the sidebar's `verified`/`duplicates`, lead detail `supersededBy`; dev seed identities and the duplicate pair (design §3, §5.4, §5.5; D10; AC-4, AC-5, AC-7)
      Done when: `scripts/test-env.sh pnpm --filter @kaki/api test:integration` passes `contacts.int.test.ts`: detail as Agent 200 with identities, conversations, leads, consents, duplicates; search 200 (text only in the body); preview `after` (lead outcome `supersede`, latest consent); merge 200 as Agent, 409 `not_mergeable` for the same or a merged contact, 404 for tenant B's contact either side, 401 without a session; a merged-away contact returns `mergedInto`; undo 200 then 409 `already_undone`; sidebar shows `duplicates: 1` for the seeded pair; and `pnpm db:setup`'s seed runs twice without duplicating identities.

## Build session 2 (UI)

- [ ] T7 — Contact page SCR-APP-016: route `/contacts/:contactId`, `pages/contact.tsx` (+ `contact-parts.tsx`): identifiers with verified marks, conversations, leads, consent records, possible duplicates, merge history with Undo, merged-away redirect notice; "Merge with another contact" search dialog, merge preview dialog, toast with Undo; `lib/contacts.ts` client (ui-design SCR-APP-016; AC-4, AC-5, AC-8)
      Done when: `pnpm --filter @kaki/dashboard test` passes unit tests for the label helpers (`identityLabel`, `leadOutcomeText`, `consentAfterText`) and `pnpm --filter @kaki/dashboard typecheck` passes; a stubbed-API Playwright check of the page in the cloud Chromium logs: preview dialog focus lands on its heading, merge → toast with Undo, undo → the other contact back in duplicates.
- [ ] T8 — Sidebar and lead page: SCR-APP-015 verified marks, "View contact", duplicate hint; SCR-APP-033 "View contact" and the merged-lead banner (ui-design SCR-APP-015, SCR-APP-033; AC-6, AC-8)
      Done when: `pnpm --filter @kaki/dashboard test` and `typecheck` pass; existing inbox and lead unit tests still green.
- [ ] T9 — E2E `e2e/tests/contact-merge.e2e.ts` (design §5.5; AC-1, AC-4, AC-5, AC-8) and the final checks
      Done when: `pnpm format:check`, `pnpm lint` (incl. `check-rtm`), `pnpm typecheck` and `pnpm test` pass via `scripts/check-summary.sh`; the spec is written to: open the seeded duplicate from the sidebar hint, preview, merge, see the merged conversation, Undo, axe at desktop and at `{ width: 375, height: 5000 }`; restores the seeded pair in `afterEach` (undo) on failure.
      Note: no Docker in cloud sessions, so the E2E runs in the verify stage's GitHub CI.
- [ ] T10 — Verify (verify stage): acceptance report, RTM Test refs, STATE.md.

## Verification evidence

- AC-1: _(verify)_
- AC-2: _(verify)_
- AC-3: _(verify)_
- AC-4: _(verify)_
- AC-5: _(verify)_
- AC-6: _(verify)_
- AC-7: _(verify)_
- AC-8: _(verify)_
