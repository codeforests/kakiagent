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
- [x] T8 — Verify: every acceptance criterion (design §6) demonstrably passes; format, lint (with boundaries), typecheck, unit, integration, coverage, build and size green; E2E skeleton, facts and masking flows pass
      Done when: the commands in AGENTS.md "Checks" pass and each AC is mapped to the test or run that shows it.
      Evidence (2026-10-20, Docker with Testcontainers and the compose stack): format, lint and boundaries, typecheck, unit (21 tasks; platform 132 incl. 58 corpus cases × 2, the seeded random set and the adversarial timing), integration (db 40, platform 4, governance 19, kb 9, inbox 5, api 12, agent 11), coverage (`src/pii-mask.ts` 100% lines), build, size (loader 1.75 kB, lazy panel 9.34 kB, initial 1.75 kB gz), `eval --fast` (prices 44/44), and E2E chromium 5/5 against `pnpm dev`. After the E2E run, the local `messages` table holds the `[NRIC ••••567D]` token and no raw `S1234567D`, and the dev log has no raw value. Mutation check: with `appendVisitorMessage` storing raw text, the api (AC-5) and agent (AC-6) integration tests both fail.
- [x] T9 — Rework after acceptance (design D10–D12; acceptance DD-1, M1–M4, M7, M8): fold other spaces and dashes, allow two-space and spaced-hyphen separators, let identifiers touch letters, find bank numbers as chunk windows, make the email pattern linear, mask `log.error(err)`; corpus cases for each
      Done when: the new corpus cases (cards with U+3000, no-break spaces, double spaces, tabs and en-dashes; NRICs with double and no-break spaces; banks followed by a date or quantity; identifiers glued to letters; and negatives for each relaxed rule) pass, the 16,000-character log-line timing passes, and the full check suite is green.
      Evidence (2026-10-20): 22 new corpus cases (80 in all) and the 16,000-character log-line timing pass; the verifier's probe set gives the expected output for every case it listed. The worst adversarial 4000-character input now takes about 2 ms (card windows use digit arrays, bank keywords are indexed once). Format, lint and boundaries, typecheck, unit, integration, coverage (`--concurrency=2`, as CI runs it) and E2E chromium 5/5 pass. Coverage with unbounded turbo concurrency on this 4-core container, with `pnpm dev` running, pushed the timing test over 20 ms; CI's `--concurrency=2` doesn't.
- [x] T10 — Card prefix rule (design D13), after CI's firefox E2E masked a Luhn-valid 13-digit timestamp in the skeleton test
      Done when: corpus negatives for the timestamp, a 1-prefixed Luhn-valid order number and a non-Visa 13-digit number pass (each was masked before), and the random-input check counts only issued-prefix 16-digit cards.
- [x] T11 — AC-10 timing measures CPU time (design D14), after CI's shared runner took 25 ms of wall time for the adversarial input
      Done when: both timing tests read `process.cpuUsage()` (best of five) and pass under `pnpm test:coverage` with unbounded concurrency on this container.
