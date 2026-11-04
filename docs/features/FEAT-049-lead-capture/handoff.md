# Handoff: FEAT-049 — Consent and lead capture
Branch: feat/FEAT-049-lead-capture · PR: none · Updated: 2026-11-04 by build (backend)
Stage done: build (backend, T1–T7)
Next: build (UI, T8–T12) — kickoff: "Build FEAT-049 (UI) on branch feat/FEAT-049-lead-capture. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the UI session needs
- Widget routes (`apps/api/src/leads-widget.ts`): `POST /widget/v1/conversations/:id/consent` (`ConsentBody` → `ConsentResponse`, `consentId` null when declined), `POST …/:id/lead` (`LeadSubmitBody` → 201/200 `LeadSubmitResponse` with the `lead_captured` notice `Message`), `POST /widget/v1/contact` (`ContactFormBody` → 201 created / 200 updated). Errors: 422 `LeadFieldErrors` (per-field `required`/`invalid`, `needsContact`), 409 `LeadConflict` (`wording_changed` carries the new `leadCapture`; `consent_required`; `not_capturing`, and `/contact` returns it when the widget is live and not paused).
- Config: `WidgetConfigResponse.leadCapture` (`LeadCaptureConfig`: purpose, prompt, marketing or null, enabled fields in order) is null when nothing is saved: no cards, no contact form.
- Cards: `Message.card` is `{kind:'consent', prefill}` or `{kind:'lead_form', consentId, prefill}` on agent or system messages. Dashboard thread messages carry `card` as the kind only.
- Panel checks: `checkLead(modes, input)` / `leadOk` / `normaliseSgPhone` / `isEmail` from `@kaki/contracts/lead-check` (Zod-free; same checks as the server). `LeadInput` values are plain strings (empty = not given).
- Dashboard: `GET`/`PUT /api/v1/settings/leads` (`LeadSettings`/`LeadSettingsBody`, settings.manage). 400 `invalid_lead_settings` with `code` `phone_or_email` | `marketing_text` | `invalid`; 409 `stale` with the current settings. `version` 0 = defaults (industry template).
- Sidebar: `ContextSidebar.contact` has `contactId`, `name`, `email`, `phone` (formatted); `ContextSidebar.lead` is `LeadSummary | null`. Label is the contact's name, else 'Website visitor'.
- Thread dividers: `ThreadEvent.kind` `consent` (reason `agreed`/`declined`) and `lead` (`created`/`updated`).
- Search: `SearchMatch.source` `message` | `contact`; a contact hit has `field` (name/email/phone), `messageId`/`author` null. `lib/search.ts` `authorLabel` returns 'Contact' as a stub: T11 renders the field label ("Email matches", ui-design).
- Seed: Kaki Bakery has a purpose statement, notice and marketing on; second-tenant has marketing off. Test DBs (`@kaki/db/testing`) save nothing.

## Deviations from the design
- `LeadInput` is plain strings checked by `checkLead`, so a 422 names each field.
- The sidebar reads leads in the api (`contactOf`, `leadSummaryOf`), not via an inbox port; inbox never imports leads.
- `messages_card_ck` allows system authors (the fallback reply is a system message).
- `visitor_privacy()` also returns `industry` (industry-default fields in the visitor zone).
- The card rule is `cardForReply`/`consentCardFor` in agent `lead.ts`, shared with the eval runner. Replay excludes `capture_lead`. Fake triage: "call me back" is a lead, not an escalation.

## Left to CI or later
- Env-only failures here (no container runtime/S3): governance `anchors.int.test.ts`, api `uploads.int.test.ts`. CI runs them.
- E2E (T12) and screen renders in the verify stage's GitHub CI.

## Pending for Ken
- None.
