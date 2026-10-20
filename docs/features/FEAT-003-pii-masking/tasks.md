# Tasks: FEAT-003 — PII masking at the edge

> Executes: [technical-design.md](technical-design.md) (screens: [ui-design.md](ui-design.md))
> Status: pending | in-progress | done per task · Last updated: 2026-10-20

- [x] T1 — Domain: the masker in `platform/src/pii-mask.ts` (`findPii`, `piiMask`, fold, NRIC checksum, Luhn, digit runs, bank keywords) and the corpus `pii-corpus.json`; replace the pass-through test (design §3.1, §5.1, §5.3; GOV-04; AC-1–AC-4, AC-10)
      Done when: unit tests over the corpus pass for every positive and negative case, idempotence holds for every case, and the 4000-character adversarial input runs under 20 ms.
- [x] T2 — Logs: `maskLogText`, the `@kaki/platform/pii-mask` subpath export, the logger's `logMethod` hook, `err` serializer and redaction paths (design §3.1, §3.4; D7; AC-7)
      Done when: unit tests that log through `createLogger` into a buffer show masked NRIC, card, email and phone values in messages and error messages, and `[redacted]` for the new fields.
- [x] T3 — Audit: `assertAuditEntry` rejects IDs and codes that contain PII (design §3.3; AC-8)
      Done when: governance unit tests reject `s1234567d` and a card number as `actorId`, subject ID, related ID and payload code, and the existing payload tests still pass.
- [x] T4 — Gateway backstop in `createGateway` (design §3.2; D3; AC-6 second half)
      Done when: llm-gateway unit tests show a raw NRIC in a `user` message (generate and stream) and in a `query` embedding reaching the provider masked, and unchanged in the system prompt, an `assistant` message and a `document` embedding; dependency-cruiser passes.
- [x] T5 — Storage and payload: integration tests on the real path (design §5.2; AC-5, AC-6)
      Done when: the api integration test posts a message with an NRIC, a card and a bank number, gets the masked body back (and the same message on retry), and a scan of `messages`, `conversations`, `outbox`, `audit_entries` and `audit_pii` finds none of the raw values; the agent turn test records every provider request and finds none of the raw values and the tokens present.
- [x] T6 — E2E: extend the widget journey (UC-20, J2/J7) so a message with an NRIC shows the masked token in the visitor's bubble and still gets a reply (AC-9)
      Done when: the new spec passes in chromium against the local stack with `pnpm dev`.
- [x] T7 — Docs: scaffold-notes §4 stub row marked done (design §2)
      Done when: the row names the masker, the log scrubbing and the gateway backstop.
- [ ] T8 — Verify: every acceptance criterion (design §6) demonstrably passes; format, lint (with boundaries), typecheck, unit, integration, coverage, build and size green; E2E skeleton, facts and masking flows pass
      Done when: the commands in AGENTS.md "Checks" pass and each AC is mapped to the test or run that shows it.
