# Handoff: FEAT-061 — Data-subject requests: find, export, correct, delete across stores
Branch: feat/FEAT-061-data-subject-requests · PR: none · Updated: 2026-11-20 by design
Stage done: design
Next: build (backend, T1–T8) — kickoff: "Build FEAT-061 (backend) on branch feat/FEAT-061-data-subject-requests. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Governance is the bottom module: `dsr/*` reads other modules' tables through `@kaki/db` schema only and deletes only via `dsr_erase()` (NOLOGIN `kaki_dsr_erase`, pattern `contact_merge()` in 0055). Don't import inbox/leads/channels/kb from governance.
- Before writing `dsr_erase()`, list every FK onto `conversations`, `messages` and `contacts` (`grep -n "foreignColumns: \[conversations\|foreignColumns: \[contacts\|foreignColumns: \[messages" packages/db/src/schema.ts`) and delete no-cascade children first; `leads.conversation_id` is SET NULL, `conversations.contact_id` has no cascade.
- `DSR_STORES` must classify every `TENANT_SCOPED_TABLES` entry (T3 test); T5's test asserts zero rows per `find+erase` store.
- `dataRequestHandler` keeps the escalation and adds `openDataRequest` (D6); texts unchanged.
- S3 deletion rides `conversation-turns` as `{ kind: 'dsr_objects' }` (no new outbox topic).
- All decisions D1–D14 were taken without Ken (autonomous M5 run) and are in `docs/build/m5-decision-log.md` rows 1–11.

## Left to CI or later
- E2E (T11) and screen renders run in GitHub CI (no Docker here). Terraform validate/test in CI if the registry is unreachable.

## Pending for Ken
- None blocking. Ken reviews the M5 decision log on 2026-11-27 (mockup not reviewed, D14).

## Token use (design session; /mnt/project-files missing, so noted here)
- ~40 tool calls; new context roughly 95k beyond the ~85k start (code-map and schema greps were the bulk, ~35k; the design documents ~25k output). Modern Web Guidance: skill present (y); searches "destructive confirmation dialog", "form validation errors"; guides `dialog`, `required-field-feedback` (~6k); outcome in ui-design.md "Gaps": `@kaki/ui` ConfirmDialog wins over native `<dialog>`, both agree on focusing Cancel and post-interaction errors.
- Would save more: a code-map table of "FKs onto conversations/contacts" (cost ~8k of awk over schema.ts here).
