## Summary

<!-- Before: what a reader saw. After: what they see now. -->

**Feature:** FEAT-NNN · **Requirements:** FR/NFR/UC IDs · **Screens:** SCR IDs

## Acceptance report

<!-- From docs/features/FEAT-NNN-<slug>/acceptance-report.md (plan §3, step 4). -->

- **Verdict:** accepted / rework / design defect
- **Report:** `docs/features/FEAT-NNN-<slug>/acceptance-report.md`

| AC | Evidence (test, output or screenshot) | Result |
|---|---|---|
| AC-1 | | |

- [ ] Fresh full test run passed
- [ ] Binding NFRs measured (or marked "pending environment" / "real-model check pending")
- [ ] Test-diff review: no test weakened, skipped or deleted
- [ ] RTM Test ref appended

## Invariant review

<!-- Tick each, or say why it does not apply (CLAUDE.md, "Architecture invariants"). -->

- [ ] RLS forced on new tables; tenant context only from a trusted source; table added to the cross-tenant suite
- [ ] Facts reach visitors only through `visitor_facts`
- [ ] Visitor and coaching scopes fixed by entry point
- [ ] The model never writes protected values
- [ ] The core does not branch on channel kind
- [ ] Side effects go only through the outbox
- [ ] The AI send gate is checked before each turn and send
- [ ] No PII in the audit log
- [ ] The widget uses only `--kaki-*` variables
- [ ] Models are reached only through `llm-gateway`
