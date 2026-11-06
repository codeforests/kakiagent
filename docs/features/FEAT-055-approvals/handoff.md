# Handoff: FEAT-055 — Approval drafts, queue, decisions, SLA, expiry
Branch: feat/FEAT-055-approvals · PR: none · Updated: 2026-11-06 by build (backend, T4–T6)
Stage done: build (T1–T6 of 11; backend complete)
Next: build (UI, T7–T11) — kickoff: "Build FEAT-055 (UI) on branch feat/FEAT-055-approvals. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build. Resume at T7."

## What the next stage needs
- Read the T4–T6 "Note (build)" lines in `tasks.md` first; `code-map.md` (Agent pipeline, Workers, API) is current.
- Routes (all session cookie): `GET /api/v1/approvals?view=pending|decided&cursor=` → `ApprovalList`; `GET /api/v1/approvals/:id` → `ApprovalDetail` (`canDecide` false for an Agent without rights, D8); `POST /api/v1/approvals/:id/decision` with `ApprovalDecision` → 200 `ApprovalDetail`, 403 `forbidden`, 409 `already_decided` (body `{ error, message, approval: ApprovalDetail }`), 409 `expired`, 422 `invalid_terms`, 400 `invalid_decision` (contract parse, e.g. blank reason). Contract names in `@kaki/contracts`: `ApprovalList`, `ApprovalDetail`, `ApprovalDecision`, `ApprovalTerms`, `AlreadyDecided`; Zod-free totals `@kaki/contracts/quote` (`totalsOf`, `formatSgd`).
- Realtime on `channels.inbox`: `{ type: 'approval', id, status }` after a draft (`pending`), a D3 auto quote (`approved`), each decision and an expiry; invalidate `['approvals']` and `['approval', id]`.
- Rules GET/PUT now carry `rules.approvalSlaMinutes` (15–2880, field error path `rules.approvalSlaMinutes`) and `approvers: { userId, name, role }[]`.
- Thread sidebar: `sidebar.approval` = `{ id, status: 'pending', slaDueAt } | null`; hand-back during a pending approval lands in `waiting_approval`.
- Widget: quote messages are `author: 'system'` with `card.kind === 'quote'` (lines, discountPct, totals, note, approvalId) and the `quoteText` body; notices `approval_waiting` / `approval_rejected` / `approval_expired` use the system-notice styling. Commitment-only turns store an empty-body system reply with `noticeKind: 'approval_waiting'`.
- Coaching: `Explainer.visitorsWouldGet` can be `approval`; `apps/dashboard/src/lib/coach.ts` `visitorsLine` already has its text (check the wording against ui-design).

## Left to CI or later
- E2E (T10) and screen renders: verify stage's GitHub CI. `apps/api` `uploads.int` needs LocalStack (no Docker here): CI only.
- Pre-existing date flake (not FEAT-055): tenancy `profile.int` fails on 5–6 Nov 2026 (Deepavali); passes from 7 Nov.

## Pending for Ken
- None.
