# Tasks: FEAT-011 — KB manager

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: done (developer-done; acceptance verification follows) · Last updated: 2026-10-20

- [x] T1 — Schema: `facts` types, `valid_from`, the GST and validity checks, the list index, `fact_versions` validity columns (drizzle schema + `0010`), and `0011` with the replaced `visitor_facts` and the DELETE grants (design §4)
      Done when: `pnpm db:setup` applies 0010–0011 on the running stack; the RLS suite passes with new cases: the dashboard role deletes its own tenant's fact, chunk and versions and 0 rows of the other tenant's; the visitor role cannot delete; `visitor_facts` hides a promotion before `valid_from` and after `valid_until` and a GST-unknown promotion price at a registered tenant; and the existing view cases are unchanged.
- [x] T2 — kb: types, `dates.ts`, the policy and promotion inputs, `mergePatch` / `contentChanged` with validity and cross-field rules, `listFacts` with type, gst, search fields and keyset cursor, `deleteFact`, `chunkContent`, `searchVisitorFacts` mapping validity (design §5 kb; D1, D3, D5; AC-1, AC-2 domain half, AC-4, AC-5, AC-7)
      Done when: unit tests for `dates.ts` (SGT midnight both ways, invalid days) and kb integration tests pass: list filters and full cursor traversal with equal-millisecond timestamps, delete (rows gone, audit entry, stale version, missing fact), create/update of policies and promotions with the version row carrying validity, each cross-field rule, and `unknown` GST kept on unrelated edits.
- [x] T3 — Contracts + API: the extended `Fact`, create variants, PATCH validity, list query and `nextCursor`, `DELETE /api/v1/kb/facts/:id` and the new error mappings (design §3; D6; AC-1, AC-2, AC-4, AC-7)
      Done when: api integration tests pass for each designed success and error: list filters and cursor, a malformed cursor and `limit=0` (400), create for each type and each AC-4 rejection, DELETE 204 / 400 / 404 (twice, other tenant) / 409 / 403 (agent role), and a GST-unknown fact made visible by PATCH.
- [x] T4 — Agent: slot fields and protected fields for policy and promotion, `renderPrice` for any priced fact, the `valid_until` date rendering, `factLine` and `fakeVisitorResponder` for the new types (design §5 agent; D4; AC-6)
      Done when: agent unit tests pass for rendering each new field (promotion exclusive S$20 → `S$21.80 incl. GST`, `31 Oct 2026`), a `price` slot on a promotion without a price failing, the verifier blocking a typed refund period, promotion price and end date, the prompt's fact lines for the new types with the system text unchanged, and the fake responder's answers passing the verifier.
- [x] T5 — Agent turn: the new types end to end in `runVisitorTurn` and the delete/disable effect on the next turn (AC-3, AC-6, AC-8)
      Done when: agent integration tests pass: a turn retrieves and renders an approved policy and promotion; after `deleteFact` (and separately after a disable) the next turn cites neither the fact nor its value; an expired promotion isn't retrieved.
- [x] T6 — Evals: fixtures with a policy and a promotion, `Fixture` and `renderedPrices` for the new types, `feat-011-typed-facts.json` with groundedness, price and adversarial cases (design §5 evals; AC-6)
      Done when: `pnpm eval` and `pnpm eval --fast` pass every threshold, the existing cases unchanged; a deliberately wrong recorded output in a new case makes its subset fail (then restored).
- [x] T7 — Dev seed: the GST-unknown bakery product (design §5 dev data)
      Done when: `pnpm db:setup` is idempotent with the new seed and the fact appears under the GST filter, but not in `visitor_facts`.
- [x] T8 — UI kit: `ConfirmDialog` in `@kaki/ui` on `@radix-ui/react-dialog` (ui-design.md cross-screen; design.md §4.3)
      Done when: the dashboard builds with it, and the dialog meets its spec in the browser (focus on Cancel, Esc closes, focus returns to the trigger, bottom sheet below 640 px).
- [x] T9 — Dashboard: SCR-APP-027 filters, Load more, GST flag, row actions; SCR-APP-028 policy and promotion forms, GST review prompt, Delete (ui-design.md; AC-9 UI half)
      Done when: `pnpm --filter @kaki/dashboard build` passes and both screens render every state in ui-design.md against the running stack.
- [x] T10 — E2E: extend `e2e/tests/facts.e2e.ts` with the policy add → filter → visitor answer → delete → next answer path, axe on both screens and the open dialog (AC-9; UC-13, UC-20)
      Done when: the new spec and the existing E2E suite pass on Chromium against the local stack.
- [x] T11 — Verify: every AC in design §6 demonstrably passes; format, lint and boundaries, typecheck, unit, integration with coverage, build and size, E2E and evals green; scaffold notes, RTM design ref and the manifest updated
      Done when: all of the above pass in one fresh run, with the evidence recorded here.

## Evidence (T11, one fresh run on 2026-10-20)

| Check | Result |
|---|---|
| `pnpm format:check`, `pnpm lint` (ESLint and dependency-cruiser), `pnpm typecheck` | Pass (26 typecheck tasks) |
| `pnpm test` | Pass (21 tasks) |
| `pnpm test:coverage` (unit and integration, per-package thresholds) | Pass: db 70 (RLS suite with the FEAT-011 block), kb 30, api 44, agent 203, governance 93, platform 265, identity 30, llm-gateway 36, analytics 7, inbox 5, channels 2 |
| `pnpm build && pnpm size` | Pass: loader 1.75 KB gz (14), panel 9.34 KB gz (35), initial load 1.75 KB gz (30); no dev sign-in in any bundle |
| `pnpm test:e2e --project=chromium` | 16 passed, including the new policy add, filter, answer, delete and next-answer spec with axe on the list, form and open dialog. Firefox and WebKit run in CI. |
| `pnpm eval` / `pnpm eval --fast` | 73 / 61 cases, every threshold met (groundedness 12/12, prices 46/46, multi-task 15/15); a wrong recorded output in a new case dropped its subset below threshold, then was restored (T6) |
| `pnpm audit --prod --audit-level=high` | No known vulnerabilities |
| Screens | Every SCR-APP-027 and SCR-APP-028 state in ui-design.md checked in the browser at 1280 px and 390 px; the phone filter row was fixed so search gets its own line |
