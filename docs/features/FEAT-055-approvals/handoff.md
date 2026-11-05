# Handoff: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry
Branch: feat/FEAT-055-approvals · PR: none · Updated: 2026-11-05 by build (backend, part 1)
Stage done: build (T1–T3 of 11)
Next: build (backend, T4–T6) — kickoff: "Build FEAT-055 (backend) on branch feat/FEAT-055-approvals. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build. Resume at T4."

## What the next stage needs
- Read `tasks.md` T1–T3 "Note (build)" lines first: they list every deviation (expiry marked by the sweep, no FK on `decided_by`, `approval_candidates()`, the tenancy/contracts cycle fixes, `isAboveMax`).
- T4 agent: call approvals `draftApproval(tx, DraftInput)` from the worker's `ConversationPort.draftApproval`. It needs `products: PricedProduct[]` (map this turn's product `VisitorFact`s; `priceCents` = the visitor-facing price, i.e. `withGst` at a GST-registered tenant for `exclusive`), `gst` (`inclusive` when registered, else `none`), `business`, the rules in force (`approvalSlaMinutes` is on `BoundaryRules` now), `rulesVersion`, hours as inbox `TenantHours`. Result `status`: `drafted` | `already_pending` | `auto` (D3; carries the quote `message` to publish).
- Triage's `request_commitment` args: `items`, `quantity`, `date`, `discount` (string or number); approvals `cleanRequest` trims them.
- T5 worker: agent-worker `main.ts` has a placeholder `approval_timer` branch (logs only) — replace it with `runApprovalTimer` (visitor zone; it returns `message`/`conversation` to publish). Scheduler calls `queueApprovalTimers(outboxDb)`.
- T5 api: `decide` (dashboard zone) throws `ApprovalNotFound` → 404, `AlreadyDecided` (has `.approval`) → 409, `ApprovalExpired` → 409 `expired`, `InvalidTerms` → 422. Build `ApprovalDetail` from `approvalById` + `summaryOf` + `totalsFor` + `termsOf`, plus the excerpt, contact name, decider name and price `current` flags. `handBack` callers pass `hasPendingApproval: (tx) => pendingApprovalOf(tx, tenant, id).then(Boolean)`. Rules GET must now return `approvers`; the sidebar must fill `approval` (currently required in the contract).
- The realtime role drops `approval` events for visitors; publish them on `channels.inbox(tenant)`.

## Left to CI or later
- E2E (T10) and screen renders: verify stage's GitHub CI. Widget `LeadCard` skips `quote` cards until T7.
- Pre-existing date flake (not FEAT-055): tenancy `profile.int` fails on 5–6 Nov 2026 because `day(3)` hits Deepavali; passes from 7 Nov. Verify should expect it if run before then.

## Pending for Ken
- None.
