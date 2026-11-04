# Acceptance report: FEAT-049 — Consent and lead capture (verified)

> Feature: [technical-design.md](technical-design.md) · [ui-design.md](ui-design.md) · [tasks.md](tasks.md)
> Verified: 2026-11-04 by an independent verify session · Branch `feat/FEAT-049-lead-capture` · PR #53

## Verdict summary

**Accepted** (2026-11-04). Every criterion AC-1..AC-12 has a test that asserts what it says. Two criteria had clauses no test drove (AC-8's unavailable, unsure, after-hours and after-capture replies; AC-11's "logs carry no field values"); tests were added for both below. All local checks are green except the two LocalStack-only suites (`uploads.int`, `anchors.int`, unrelated, green in CI). No existing test was weakened. LED-01, LED-02 and LED-09 are complete; INB-11 is now complete with FEAT-046; GOV-08's "with lead capture" clause is complete; LED-08 is partial (CSV export with FEAT-050) and AGT-06 partial (`capture_lead` only).

## Audit standard

Re-derived from SRS v0.4 LED-01 (tenant-configured fields, "validated (SG phone format, email)"), LED-02 (purpose statement and explicit consent before collecting personal data, "recorded with a timestamp and the wording used"; "No lead is stored without a consent record"), LED-08 (separate marketing consent, off unless the visitor opts in; flag and timestamp on the lead and its CSV export), LED-09 ("at most one lead is open at a time" per contact), AGT-06 (`capture_lead`, tool calls audited), INB-11 (search by contact name, email, phone; ≤ 2 s), GOV-08 (fallback message "with lead capture"), UC-21 steps 1–5 with 2a, 2b, 4a, NFR-09, NFR-19, ADR-005, ADR-008, ADR-009, ADR-014, ADR-015, ADR-016, ADR-025, and technical-design §6. Each FR maps to at least one criterion (design §9 self-check holds). UC-21 step 5's score and step 6's alert are FEAT-050 (D8), as is LED-08's CSV export.

## Audit table

| AC | Source | Test(s) | Asserts the criterion? | Result |
|---|---|---|---|---|
| AC-1 | LED-02 fit; UC-21 2 | leads `leads.int` "needs a granted consent of the same conversation"; api `leads-widget.int` `/lead` with no consent → 409 `consent_required`; `rls.int` lead insert without `consent_id` refused (NOT NULL + FK); widget `chat.test` form only after Agree; E2E `lead-capture.e2e` | Yes | Pass |
| AC-2 | LED-02 timestamp + wording | leads `leads.int` "records the wording shown and refuses a stale one without writing"; api 409 `wording_changed` with the current `leadCapture`; `rls.int` visitor can't update a consent's `wording_id` (append-only) | Yes | Pass |
| AC-3 | UC-21 2a | leads `leads.int` decline has no contact; agent `lead.int` "never after a decline, but the visitor can still ask" (later `capture_lead` → card with valid prefill); api decline stores no contact; E2E decline | Yes | Pass |
| AC-4 | LED-08; UC-21 2b; D3 | leads `leads.int` marketing row only when shown, its own wording; widget config null marketing when off; `rls.int` `visitor_privacy` returns marketing only while on; widget `chat.test`/T8 check: unticked by default | Yes | Pass |
| AC-5 | LED-01; UC-21 4, 4a | contracts `leads.test` (spellings → `+65XXXXXXXX`, `1234 5678` refused, both-off refused); leads `leads.int` per-field codes, nothing stored; api 422 `{name: required, phone: invalid}`; agent `dispatch.test` + new `lead.test` `prefillOf` drops invalid args; widget `chat.test` inline validation | Yes | Pass |
| AC-6 | LED-09; UC-21 5; D4 | leads `leads.int` update by email and by phone (`captures` 2), closed lead → new; three concurrent submits → 1 contact, 1 open lead, `captures` 3; `rls.int` `leads_one_open_uq`; api second submit → 200 `updated` | Yes | Pass |
| AC-7 | AGT-06; ADR-025 | agent `dispatch.test` refused `consent` before, form card after, coaching scope refused, audit has no "Mei"/"9123"; registry lists `capture_lead`; `replay-dispatch` filters it; agent `lead.int` turn-level card; `turn.int` multi-task audit now `refused consent` | Yes | Pass |
| AC-8 | UC-21 1; AGT-04, AGT-09, NFR-04 | agent `lead.int` (out-of-scope offer once per conversation, none after decline, none on crisis, none without purpose); **added** `lead.test` `cardForReply` table: unavailable, unsure, out-of-scope, after-hours notice and after-hours escalation offer; none after agree, decline, offer or capture; none on safety, paused, not-live, ended, gate-closed, or without a purpose statement | Yes, after addition | Pass |
| AC-9 | GOV-08 "with lead capture"; SCR-WGT-005 | api `leads-widget.int` `/contact` while paused and while not live, refused while live, refused without purpose; leads `leads.int` contact form all-or-nothing; E2E paused contact form | Yes | Pass |
| AC-10 | INB-11 contact fields | inbox `search.int` contact name, email part, phone in each spelling with no message hit, `field` reported, message hit wins, tenant B none; `rls.int` `inbox_contact_hits` tenant-only; `search-volume.int` with 5,000 contacts ≤ 2,000 ms; api `leads.int` finds the chat by phone; E2E owner search by phone | Yes | Pass |
| AC-11 | ADR-005, ADR-014, ADR-015 | `rls.int` FEAT-049 block (A/B both zones, append-only consents, dashboard read-only on contacts/leads); leads `leads.int` audit rows carry no field values; api `leads.int` audit has no marketing wording; **added** `leads-widget.int` debug log capture: the `/lead` URL present, `Mei Ling`, `9123 4567`, `91234567`, `+6591234567`, `Cake` absent | Yes, after addition | Pass |
| AC-12 | SCR-APP-043, SCR-APP-014; NFR-09, NFR-19 | api `leads.int` settings defaults, save, stale 409, both-off 400, Owner/Admin only, sidebar and dividers; dashboard unit `lib/leads.test`, `lib/inbox`, `lib/search`; widget `chat.test`; E2E `lead-capture.e2e` (axe on the consent card, invalid form and contact form at 375; owner inbox at 1440), `leads-settings.e2e` (axe at 1280 and 375 tall, `scrollWidth` 375); ZH strings are held to EN parity by the `Strings` union type (not rendered in E2E) | Yes | Pass locally; E2E in CI (see CI) |

## Changed existing tests (reviewed, not weakened)

- `packages/agent/src/dispatch.test.ts`: the "unhandled task" case moved from `capture_lead` (now handled) to `data_request`, so it still proves unhandled tasks are audited with codes only; registry list gains `capture_lead`.
- `packages/agent/test/turn.int.test.ts`: `capture_lead` now `refused: consent` instead of `unhandled`, and `card: null` under replies. Correct for the new handler.
- `packages/contracts/src/inbox-contract.test.ts`, `search.test.ts`: new nullable contact fields and `source`/`field`.
- `packages/governance/test/audit.int.test.ts`, `verify.int.test.ts`: insert a `contacts` row because `audit_pii.contact_id` now references it.
No test deleted, skipped or loosened (`git diff origin/main...HEAD` over test files and `e2e/`).

## Corrected tests

Commit `e380351` (test artifacts only):
- **AC-8, new `packages/agent/src/lead.test.ts`:** the integration test drove only out-of-scope; the criterion names unavailable, unsure, after-hours and fallback replies and "never after a capture". The pure `cardForReply` rule now has a case for each, plus `prefillOf`.
- **AC-11, `apps/api/test/leads-widget.int.test.ts`:** T5's done-when promised "a captured log stream has no submitted email or phone", but no test captured logs. Added a debug logger capture (the FEAT-046 pattern), asserting the request URL is logged (capture works) and no submitted value is.

## Independent execution

All run fresh in this session through `scripts/test-env.sh scripts/check-summary.sh` at `26152fd` plus the corrections:

- Full: `pnpm format:check` PASS, `pnpm lint` PASS (ESLint, dependency-cruiser, RTM), `pnpm typecheck` PASS, `pnpm test` PASS (127 files, 1,531 tests).
- Coverage: `@kaki/db` 195 PASS, `@kaki/leads` 11 PASS (95.9 % statements), `@kaki/agent` 499 PASS (the FEAT-045 `suggest.int` flake didn't recur), `@kaki/inbox` 124 PASS (incl. volume), `@kaki/api` 37/38 files: the one failure is `uploads.int` (LocalStack needs a container runtime).
- `@kaki/contracts test` 57, `@kaki/widget test` 49, `@kaki/governance test:integration` 4/5 files (`anchors.int`, LocalStack), `pnpm eval --fast` PASS, widget `build` + `size`: loader 4.47 KB, panel 19.17 KB of 35, initial 4.47 KB of 30.
- Corrected tests: `leads-widget.int` + `leads.int` 7/7, `lead.test` 7/7 PASS.

## Direct verification

- **ADR-005.** The four tables have `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy in `0048_leads.sql`; grants are column-scoped (visitor zone can't change `leads.status` or a consent's `wording_id`; dashboard reads contacts and leads only). `inbox_contact_hits` follows the 0047 pattern: SECURITY DEFINER, owned by `kaki_inbox_search`, `search_path` pinned, filters `k.tenant_id = app_current_tenant()`, EXECUTE revoked from PUBLIC and granted to `app_dashboard` only. `visitor_privacy()` joins the marketing wording only while `marketing_enabled`.
- **Tenant from a trusted source.** `leads-widget.ts` takes the tenant from the verified visitor token (`v.t`); `leads.ts` from the session.
- **ADR-008/ADR-025.** `capture_lead` registers a handler; consent is the dispatcher's `needsConsent` check; the handler returns a card and writes nothing; args only prefill after the same checks as the form.
- **ADR-016.** Widget budget holds (above); `--kaki-danger`/`--kaki-success` come from tokens.json through the generator.

## Findings

- F1 (fixed here, test artifact): AC-8 clauses untested; added `lead.test.ts`.
- F2 (fixed here, test artifact): AC-11 logs clause untested; added the log capture.
- F3 (fixed here, CI run 101, `8603ea1`): the consent and lead form cards were `<li role="group">` inside the message `<ol>`, which axe's `list` rule refuses (NFR-09); seen in `lead-capture.e2e` and in `language.e2e`'s after-hours turn, which now carries a consent offer. The `<li>` now wraps a `role="group"` div.
- F4 (fixed here, `8603ea1`): never-saved lead settings returned a server default opt-in wording ("news and offers …"), so the dashboard never prefilled ui-design SCR-APP-043's default naming the business; `leads-settings.e2e` caught it. The server now returns empty text and the page prefills.
- F5 (fixed here, `dadda74`): the `lead_captured` notice text differed from ui-design SCR-WGT-003; now "Thanks, {business} has your details and will get back to you." (EN and ZH).
- F6 (test fixture, `8603ea1`, `dadda74`): the FEAT-049 seed saves a notice and purpose for the dev tenant, which broke two older specs that assumed none: `privacy.e2e` (FEAT-058) now clears the row in `beforeAll` and restores it in `afterAll`; `widget-controls.e2e` (FEAT-033) end-chat test stubs `privacyNoticeUrl: null` as its sibling stubs it on. No assertion changed.
- F7 (accepted as CI noise, Ken 2026-11-04): `search-volume.int` "2-char Chinese" took 2,260 ms (run 101), passed (run 102), 2,370 ms (run 103) and 2,249 ms (run 103 re-run) in CI, limit 2,000; main's CI run 104 took 1,663 ms. Locally the same test takes 831 ms with this PR's `search.ts` and 832 ms with main's, so the contact union adds no measurable cost. A 2-character query can't use the trigram index and scans messages, so CI runner load puts it near the limit. Ken chose to treat it as CI noise; the margin is a FEAT-046 risk in pending-actions.
- F8 (not this PR's): run 101's Firefox `kill-switch.e2e` 375 px test timed out waiting for the sign-in email page; it passed in later runs. Main's run 104 also failed `widget-controls.e2e` end-chat on Chromium (the test F6 now pins to no notice).
- Note (build deviation, accepted): the widget config carries no field labels, so the F&B "Date needed" label isn't used; every tenant sees "Preferred date or time". Cosmetic; listed in pending-actions for FEAT-050's leads work.
- Carried: FEAT-045's `suggest.int.test.ts:176` asserts no bare "55" in the audit JSON and flakes when a random UUID contains it (seen in build, not here); follow-up fix in pending-actions.
- Carried: pre-live contact-form leads are invisible to staff until FEAT-050's list (§8); LED-08 CSV export with FEAT-050.

## RTM

Test ref appended 2026-11-04: LED-01, LED-02, LED-09, INB-11 (completes it with FEAT-046), GOV-08 (lead capture on the fallback), LED-08 (partial: CSV export with FEAT-050), AGT-06 (partial: `capture_lead`). `node scripts/check-rtm.mjs FEAT-049 --stage verify`: `RTM check passed (FEAT-049).`

## CI

GitHub CI run 103 (`workflow_dispatch`, https://github.com/codeforests/kakiagent/actions/runs/41786403754) at `dadda74`: 10 of 11 jobs green, including E2E on Chromium, Firefox and WebKit (`lead-capture.e2e`, `leads-settings.e2e`, `privacy.e2e`, `widget-controls.e2e`, `language.e2e`), build and size, the eval, unit tests and lint. Integration with coverage is red only on the `search-volume.int` 2-char Chinese timing (F7), also after one re-run; every other integration suite, including `uploads.int` and `anchors.int` with LocalStack, passed. Runs 101 and 102 found F3–F6.
