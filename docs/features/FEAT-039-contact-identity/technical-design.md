# Technical design: FEAT-039 — Contact identity, verified merge and undo

> Implements: CHN-08, LED-09 (p: duplicate leads of two contacts that are merged, D6) · Realizes: UC-26 exception 4a (staff merge contacts manually); the verified-merge entry that UC-26 step 4 and 1a call (FEAT-038) · Screens: SCR-APP-016 (new), SCR-APP-015 (p: verified marks, View contact, possible duplicates), SCR-APP-033 (p: View contact, merged-lead banner) (see [ui-design.md](ui-design.md)) · Module: `channels` (contact identity, architecture §5.2 `resolveContact`), `leads`, `inbox`; ADR-005, ADR-011, ADR-014, ADR-015
> Status: designed · 2026-11-10

## 1. Intent

One person is one contact per business, across the widget, email and Telegram, but only when the business can trust that they are the same person. An identifier the channel vouches for (a Telegram user ID, an email From address that passed DMARC, and from FEAT-038 an email or Telegram account proven with a one-time link) is **verified**; anything a visitor types (the lead form's email and phone) is **not**. Contacts join automatically only on the same verified identifier. Everything else stays separate, and staff see it on the new Contact page: every identifier with its verified mark, the contact's conversations, leads and consent records, the contacts that look like the same person, and a merge with a preview. Any merge, manual or automatic, can be undone, and both are in the audit log (CHN-08).

## 2. Codebase context

- **Contacts** (FEAT-049 `0048`, FEAT-037 `0054`): `contacts` has `name`, `email`, `phone`, `telegram_id`, `telegram_username`, unique per tenant on email, phone and Telegram ID. Three writers resolve a contact with their own SQL: leads `capture.ts` `resolveContact` (typed email, then phone, then the conversation's contact: FEAT-049 D4), channels `email/receive.ts` `contactFor` (From address, FEAT-036 D6), channels `telegram/receive.ts` `contactFor` (Telegram ID, FEAT-037 D5).
- **The gap:** D4 joins a widget visitor to whichever contact holds the email they type, unverified. That contact's consent can then be withdrawn from the chat (leads `withdrawalTarget` takes the conversation's contact), and FEAT-038/026 would carry that contact's history into the visitor's chat. This design replaces D4 (D1).
- **Contact-keyed rows** (ADR-015): `conversations.contact_id`, `consents`, `leads` (`leads_one_open_uq`: one open lead per contact), `telegram_chats`, `audit_pii`. A merge moves exactly these.
- **Readers of contact columns:** inbox `inbox_contact_hits()` (search), leads `list.ts`/`rescore.ts`/`export.ts` (`leadSelect`), leads `views.ts` `contactOf` (thread sidebar), db `setup.ts` seed. They keep reading `contacts` display columns (§4).
- **Patterns reused:** SECURITY DEFINER functions owned by a NOLOGIN role (`inbox_search_hits`, `approval_candidates`); search text in a POST body (FEAT-046); `auditId()` and the governance `audit` chain (ADR-014); `LeadConsentRecord`, `LeadConversation` contracts.

## 3. API contracts (`packages/contracts/src/index.ts`, new section `// ---- Dashboard API: contacts (CHN-08; FEAT-039 §3)`)

```ts
IdentityKind = z.enum(['email', 'phone', 'telegram'])
IdentitySource = z.enum(['email', 'telegram', 'lead_form'])        // FEAT-038 adds 'link'
ContactIdentity = { id: uuid, kind: IdentityKind, value: string,   // phone formatted "+65 9123 4567"; telegram "@user" or "Telegram account"
                    verified: boolean, source: IdentitySource, firstSeenAt: iso }
ContactDuplicate = { contactId: uuid, label: string,
                     shared: { kind: IdentityKind, value: string }[] }       // max 5 rows
ContactMergeEntry = { mergeId: uuid, otherContactId: uuid, otherLabel: string, at: iso,
                      automatic: boolean, by: string | null,                  // member name; null when automatic
                      undoneAt: iso | null, canUndo: boolean,
                      undoBlocked: 'survivor_merged' | null }
ContactLead = { id: uuid, status: LeadStatus, need: string | null, createdAt: iso,
                supersededBy: uuid | null }                                  // D6
ContactConversation = LeadConversation.extend({ channel: ConversationChannel })

// GET /api/v1/contacts/:id   (inbox.read)
ContactDetail = {
  id: uuid, label: string, name: string | null, firstSeenAt: iso,
  mergedInto: { contactId: uuid, label: string, mergeId: uuid } | null,     // a merged-away contact: the page redirects
  identities: ContactIdentity[],
  conversations: ContactConversation[] (max 20, newest first), conversationCount: int,
  leads: ContactLead[], consents: LeadConsentRecord[],                      // newest first
  duplicates: ContactDuplicate[],                                           // §5.4
  merges: ContactMergeEntry[],                                              // merges into this contact, newest first
  canMerge: boolean,                                                        // contacts.merge
}

// POST /api/v1/contacts/search  (inbox.read; text in the body, never a URL)
ContactSearchBody = z.strictObject({ q: z.string().trim().min(2).max(100), exclude: uuid.optional() })
ContactSearchResponse = { contacts: { contactId, label, email: string|null, phone: string|null,
                                      telegramUsername: string|null, lastSeenAt: iso|null }[] (max 10) }

// GET /api/v1/contacts/:id/merge/:otherId   (contacts.merge) — the preview; nothing written
ContactSide = { contactId, label, identities: ContactIdentity[], conversationCount: int,
                openLead: { id: uuid, need: string | null } | null,
                consent: { enquiry: ConsentDecision | null, marketing: ConsentDecision | null } }
MergePreview = { keep: ContactSide, merge: ContactSide,
                 after: { identities: ContactIdentity[], conversationCount: int,
                          leadOutcome: 'none' | 'keep' | 'move' | 'supersede',          // D6
                          consent: { enquiry: ConsentDecision | null, marketing: ConsentDecision | null } } }

// POST /api/v1/contacts/:id/merge   (contacts.merge)
MergeBody = z.strictObject({ otherId: uuid })        → 200 { mergeId: uuid, contact: ContactDetail }
// POST /api/v1/contacts/merges/:mergeId/undo   (contacts.merge)
                                                     → 200 { contact: ContactDetail }   // the merged-in contact, restored
ContactConflict409 = { error: z.enum(['not_mergeable', 'undo_blocked']),
                       reason: z.enum(['same_contact', 'merged', 'already_undone', 'survivor_merged']) }
```

Widened: `ContextSidebar.contact` gains `verified: { email: boolean, telegram: boolean }` (the shown value is verified) and `duplicates: z.number().int().min(0)` (possible duplicates, §5.4). `LeadDetail` gains `supersededBy: uuid | null`. Errors: 404 `not_found` for an unknown or other tenant's contact or merge (both IDs on merge), 403 without the capability, 422 `invalid_body`.

## 4. Schema changes (migration `0055_contact_identity.sql`)

- **`contact_identities`** (tenant-scoped, forced RLS, `TENANT_SCOPED_TABLES`): `tenant_id`, `id`, `contact_id` (FK `(tenant_id, contact_id)` → contacts, cascade), `kind` (`email|phone|telegram`), `value` (email lower-case, phone E.164 `+65…`, Telegram user ID as text), `source` (`email|telegram|lead_form`), `verified_at timestamptz null`, `created_at`. Indexes: `contact_identities_verified_uq` unique `(tenant_id, kind, value) where verified_at is not null` (one verified owner per identifier); `contact_identities_email_uq` unique `(tenant_id, value) where kind = 'email' and source = 'email' and verified_at is null` (one unverified mailbox contact per From, D3); `contact_identities_row_uq` unique `(tenant_id, contact_id, kind, value, source)`; `contact_identities_lookup_idx (tenant_id, kind, value)`. Checks: telegram ⇒ `source = 'telegram'` and verified; `lead_form` ⇒ not verified; phone `^[+]65[3689][0-9]{7}$`.
- **`contact_merges`** (tenant-scoped, forced RLS): `tenant_id`, `id`, `survivor_id`, `merged_id` (both FK → contacts, cascade), `automatic boolean`, `by_user_id uuid null`, `moved jsonb not null` (IDs of every moved row by table, and the survivor display columns filled, §5.3), `created_at`, `undone_at null`, `undone_by uuid null`. Index `(tenant_id, survivor_id, created_at desc)`, `(tenant_id, merged_id)`.
- **`contacts`**: + `merged_into uuid null` (FK → contacts), `merged_at`. Drop `contacts_email_uq`, `contacts_phone_uq`, `contacts_telegram_uq`: identifiers are matched only through `contact_identities` now; the columns stay as the contact's **display** values (one each), so search, leads, export and the sidebar keep reading them unchanged. `contacts_telegram_lookup` and the email/phone trigram indexes stay.
- **`leads`**: + `superseded_by uuid null` (FK `(tenant_id, superseded_by)` → leads). `leads_one_open_uq` predicate becomes `status in ('new','contacted') and superseded_by is null`.
- **Functions** (owned by NOLOGIN `kaki_contact_merge`, `SECURITY DEFINER`, `search_path` pinned, tenant from `app_current_tenant()`, EXECUTE to `app_dashboard` and `app_agent_visitor`): `contact_merge(survivor uuid, merged uuid, automatic boolean, actor uuid) returns uuid` and `contact_unmerge(merge uuid, actor uuid) returns uuid` (§5.3). `kaki_contact_merge` gets SELECT and UPDATE of only the columns they move: `conversations.contact_id`, `consents.contact_id`, `leads(contact_id, superseded_by)`, `telegram_chats.contact_id`, `audit_pii.contact_id`, `contact_identities.contact_id`, `contacts(name, email, phone, telegram_id, telegram_username, merged_into, merged_at, updated_at)`, and INSERT/UPDATE on `contact_merges`. Neither app role gets UPDATE on those columns (consents stay append-only for them).
- **Grants:** `contact_identities` SELECT, INSERT to `app_agent_visitor` (the channel writers), SELECT to `app_dashboard`; `contact_merges` SELECT to both. `inbox_contact_hits()` unchanged (a merged-away contact has no conversations left, so it can't hit).
- **Backfill** in the migration: every `contacts.telegram_id` → `telegram` identity, verified at `created_at`; every `contacts.email` → `email` identity, unverified, source `email` when the contact has an email-channel conversation else `lead_form`; every `contacts.phone` → `phone`, `lead_form`, unverified. Existing joins made under FEAT-049 D4 are not split (pre-launch data only).
- `rls.int.test.ts`: tenant B can't read A's identities or merges; the definer functions refuse IDs of another tenant; an app role can't `update consents set contact_id`.

## 5. Component design

### 5.1 Identity and resolution (`packages/channels/src/contacts/identity.ts`, export `@kaki/channels/contacts`, Zod-free and SDK-free so leads can import it)

```ts
type Identity = { kind: 'email' | 'phone' | 'telegram'; value: string; source: IdentitySource; verified: boolean }
resolveContact(tx, tenantId, identity, seed: { name?: string; telegramUsername?: string }): Promise<string>
addIdentity(tx, tenantId, contactId, identity): Promise<void>            // insert … on conflict do nothing
attachVerified(tx, tenantId, contactId, identity): Promise<{ mergedFrom: string | null }>   // FEAT-038's entry
normaliseIdentity(kind, raw): string | null                              // lower-case email, +65 phone
```

- `resolveContact` for a **verified** identity: the active contact holding it verified, else a new contact with the display column set and the identity row (insert races re-read through `contact_identities_verified_uq`). For an **unverified email from the email channel**: the contact holding the same unverified mailbox identity (`contact_identities_email_uq`), else new (D3). It never matches a lead-form identity, and never matches across verified/unverified.
- `attachVerified` adds a verified identity to a contact the caller already knows (FEAT-038: the token proved the Telegram account or email belongs to this widget visitor). If another active contact holds it verified, that contact is merged into this one automatically (`contact_merge(…, automatic = true, actor = null)`, audited `contact.merged` with `automatic: true`); the older contact survives (D5). Returns the merged contact's ID.
- **Writers changed:** email `receive.ts` `contactFor` → `resolveContact({ kind: 'email', source: 'email', verified: verdicts.dmarc === 'PASS' })` (D2); telegram `receive.ts` `contactFor` → `resolveContact({ kind: 'telegram', source: 'telegram', verified: true })`, then the username update as now; leads `capture.ts` `resolveContact` (renamed `contactForCapture`) → the conversation's contact, else the same `visitor_id`'s latest contact (as `withdrawalTarget`), else a new contact; then `addIdentity` for the typed email and phone (`lead_form`, unverified) and display columns filled when empty, the name replaced when given (D1). The open-lead upsert and its tests stay; the per-contact lock is now `select … for update` on the resolved contact.
- `@kaki/leads` adds `@kaki/channels` as a dependency (no cycle: channels never imports leads).

### 5.2 Possible duplicates (`contacts/views.ts`)

`duplicatesOf(tx, tenantId, contactId)`: other active contacts sharing any identity `(kind, value)` with this one, verified or not, newest first, at most 5, with the shared values. `duplicateCount` for the sidebar is the same query's count (capped 5). Nothing is merged; it's a suggestion for staff (D1).

### 5.3 Merge and undo (`contacts/merge.ts` + the two SQL functions)

- `mergeContacts(tx, { tenantId, survivorId, mergedId, automatic, actorId })`: calls `contact_merge`, then audits `contact.merged` `{ mergeId, survivor: auditId, merged: auditId, automatic, moved: { conversations: n, consents: n, leads: n, identities: n } }` (IDs and counts only, ADR-014). Errors: `NotMergeable('same_contact' | 'merged')`.
- `contact_merge`: locks both contacts `for update` in ID order; refuses the same ID or a contact with `merged_into` set (raises SQLSTATE `KC001`/`KC002`); moves `conversations`, `consents`, `telegram_chats`, `audit_pii` and the identities that the survivor doesn't already hold (`contact_identities_row_uq`; an identical row stays on the merged contact and comes back with undo); for leads: if both have an open lead, the merged contact's open lead gets `superseded_by` = the survivor's open lead and moves (D6), otherwise its leads just move; fills each empty survivor display column from the merged contact; sets `merged_into`, `merged_at` on the merged contact; records every moved row ID and filled column in `contact_merges.moved`; returns the merge ID.
- `undoMerge(tx, { tenantId, mergeId, actorId })` → `contact_unmerge`: refuses an undone merge (`already_undone`) and a survivor that has itself been merged away since (`survivor_merged`: undo that one first). Moves back exactly the rows in `moved`, clears `superseded_by` on the leads it set, clears the filled display columns if they still hold the filled value, clears `merged_into`, sets `undone_at`/`undone_by`. Rows created after the merge (new conversations, consents, lead updates) stay with the survivor (D7). Audits `contact.unmerged` `{ mergeId, survivor, merged }`. Undo has no time limit.
- **Consent after a merge** is the latest row per purpose across both contacts (FEAT-051's rule, unchanged); the preview shows it before staff confirm (D8).
- **Zones:** manual merge and undo run in the dashboard zone; `attachVerified` runs in the visitor zone (FEAT-038's receive paths). Both through the definer functions.

### 5.4 Contact page and API (`apps/api/src/contacts.ts` `registerContactRoutes`)

- `GET /api/v1/contacts/:id` composes channels `contactDetail` (identities, conversations with channel, merges with member names via identity `memberNames`, duplicates, `mergedInto`) with leads `contactLeads(tx, tenantId, contactId)` (new, `leads/views.ts`: leads with `supersededBy`, consent records as `LeadConsentRecord`). A merged-away contact returns its `mergedInto` and empty lists.
- `POST /api/v1/contacts/search`: active contacts whose name, email, phone or Telegram username contains `q` (`ILIKE`, escaped), excluding `exclude`, newest activity first, limit 10. Plain RLS query: a tenant's contacts are small; no index promise (D9).
- `GET …/merge/:otherId` (preview): both `ContactSide`s from channels and leads `contactLeadSummary`; `after` computed in the api (union of identities, summed conversations, `leadOutcome`, latest consent per purpose). 409 `not_mergeable` as the merge would.
- `POST …/merge`, `POST /contacts/merges/:mergeId/undo`: one transaction each, return the fresh `ContactDetail`.
- **Capability** `contacts.merge` (identity `capabilities.ts`): Owner, Admin and Agent (SCR-APP-016 "merge: all staff"). Viewing needs `inbox.read`.
- **Sidebar:** leads `contactOf` adds `verified` (from `contact_identities` for the shown email/Telegram) and `duplicates` (channels `duplicateCount`, read by the api). Leads list/export/rescore filter `superseded_by is null`; lead detail returns `supersededBy`.

### 5.5 Dev seed and E2E

- `setup.ts` seed: identities for `SEED_LEADS` contacts (`lead_form`), and one pair of bakery contacts sharing an unverified email so the demo has a suggested duplicate (D10).
- E2E `contact-merge.e2e.ts`: the seeded pair shows as possible duplicates; preview; merge; the merged contact's conversation appears on the survivor; Undo restores both; axe at desktop and phone width (tall viewport).

## 6. Acceptance criteria

- **AC-1** (CHN-08 "no automatic merge on unverified data"; D1): a widget visitor who types an email or phone that another contact holds (verified or not) gets a new contact; the other contact's conversations, leads and consents are unchanged, and withdrawing consent in the chat touches only the new contact. A returning visitor in the same browser still updates their open lead (LED-09).
- **AC-2** (CHN-08 "merged by verified … Telegram ID", D2–D3): a second Telegram chat from the same user ID joins the same contact; an email with DMARC `PASS` joins the contact holding that address verified; an email without `PASS` joins only the contact of earlier unverified mail from that address and never a verified or lead-form one.
- **AC-3** (CHN-08 verified merge, D5): `attachVerified` with an identifier another contact holds verified merges that contact into the older of the two, moves its conversations, consents, leads and Telegram chats, writes one `contact.merged` audit entry with `automatic: true`, and the merge can be undone.
- **AC-4** (CHN-08 "staff can merge manually"; UC-26 4a): a member with `contacts.merge` (any role) finds another contact by name, email, phone or Telegram username or from the duplicates list, sees a preview (identifiers, conversations, open lead outcome, consent after the merge), confirms, and the Contact page then lists everything of both. 403 without a session's capability; 404 for another tenant's contact.
- **AC-5** (CHN-08 "can be undone and is recorded in the audit log"; D7): Undo restores exactly the moved rows, the superseded lead and the filled display values, leaves rows created after the merge with the survivor, and writes `contact.unmerged`; undoing twice → 409 `already_undone`; undo after the survivor was merged elsewhere → 409 `survivor_merged`. Audit entries hold IDs and counts only (ADR-014).
- **AC-6** (LED-09 p; D6): merging two contacts with open leads leaves one open lead in the pipeline; the other is shown on the Contact page and its lead page as merged into it, and excluded from the list and export; undo makes both open again.
- **AC-7** (ADR-005): tenant B can't read A's identities or merges or merge A's contacts; app roles can't re-key consents directly; the definer functions refuse another tenant's IDs.
- **AC-8** (SCR-APP-016, -015, -033): the Contact page shows identifiers with verified marks, conversations, leads, consent records, duplicates and merge history with Undo; the thread sidebar shows verified marks, "View contact" and the duplicate hint; no serious axe violations at desktop and phone width.

## 7. Decisions

- **D1 — Typed details never join contacts (replaces FEAT-049 D4; Ken's card, 2026-11-10, recommended option, pending).** The lead form links the conversation's contact, else the same browser's (`visitor_id`) contact, else a new one; its email and phone are unverified identities. Contacts that share any identifier appear as possible duplicates for staff. Why: CHN-08, and today a visitor typing someone else's email can withdraw that person's consent, and FEAT-038/026 would carry that person's history into the chat.
- **D2 — A From address is verified only when SES's DMARC verdict is `PASS`.** `FAIL` is already dropped as spam (FEAT-036); `GRAY`/absent means the domain doesn't let us check, so it is unverified.
- **D3 — Unverified email continuity.** Mail from the same unverified address keeps joining one contact (FEAT-036 D6 continuity, the channel's own thread), but never a verified or lead-form contact. A reply goes to the From address, so a spoofer gains nothing back.
- **D4 — Identifiers live in `contact_identities`; `contacts` columns are display values.** Uniqueness moves to verified identities, so two people can hold the same typed email. Readers of the display columns stay unchanged, which keeps the change small.
- **D5 — Automatic merges keep the older contact.** Manual merges keep the contact whose page staff are on ("merge the other into this one").
- **D6 — Two open leads: the merged one is superseded, not closed.** `superseded_by` points at the survivor's open lead; the pipeline shows one; undo restores both. No new lead status.
- **D7 — Undo moves back what the merge moved, nothing else**, any time, unless the survivor was merged away since.
- **D8 — Consent after a merge follows FEAT-051's latest-row rule**; the preview shows the result so staff can stop before merging two people's consent.
- **D9 — Contact search is a plain RLS `ILIKE` with a limit**, not the FEAT-046 definer pattern; a business's contact count is small. Revisit with NFR data.
- **D10 — The dev bakery seeds one duplicate pair** for the demo and E2E.

## 8. Escalations and open items

- D1 changes FEAT-049's D4 behaviour and its tests (`leads.int` "a returning visitor…" and the concurrent-submit case, which now pass through the same `visitor_id`/conversation instead of the same typed email). This is a design change, not a weakened test; the decision card is pending with Ken.
- No verified phone source exists yet (no SMS or WhatsApp); phone identities are always unverified until one does.
- FEAT-038 calls `attachVerified` from its link-token paths (adds source `link`); FEAT-026 reads history through the conversation's contact, which is now safe to follow. FEAT-061 deletes a contact with its identities and merges (cascade).
- Telegram's shared phone number (`request_contact`) would be a verified phone; not in scope.

## 9. Self-check

- Every AC traces to CHN-08's criteria, UC-26 4a or LED-09; every decision has a reason. Tenant ID only from the session or the channel route; RLS forced on both new tables; side effects: none beyond audit (no outbox job needed). No model involvement. Module boundaries: leads → channels (`@kaki/channels/contacts`), api composes channels + leads; inbox unchanged.
