# Handoff: FEAT-039 — Contact identity, verified merge and undo
Branch: feat/FEAT-039-contact-identity · PR: none · Updated: 2026-11-10 by design
Stage done: design
Next: build (backend, T1–T6) — kickoff: "Build FEAT-039 (backend) on branch feat/FEAT-039-contact-identity. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- D1 (pending Ken's card, recommended option assumed): the lead form no longer matches contacts by typed email/phone. FEAT-049's "returning visitor" and concurrent-submit cases in `leads.int.test.ts` change to same-conversation / same-`visitor_id`; say so in T4's commit. If Ken picks "keep FEAT-049's matching", T4 keeps `resolveContact`'s D4 lookups and only adds lead-form identities; everything else stands.
- Identifiers are matched only through `contact_identities`; `contacts.email/phone/telegram_*` stay as display values (D4), so search, leads list/export and the sidebar don't change their reads. The three unique indexes on `contacts` are dropped.
- Merge and undo are the SQL functions `contact_merge()`/`contact_unmerge()` (SECURITY DEFINER, NOLOGIN `kaki_contact_merge`); app roles never get UPDATE on `consents.contact_id`. `contact_merges.moved` records every moved row ID so undo is exact.
- `@kaki/channels/contacts` must stay Zod- and SDK-free; leads adds `@kaki/channels` as a dependency (check dependency-cruiser in T4).
- Email verified = SES DMARC `PASS` (`email-receive.int` already passes `dmarc: 'PASS'` by default).
- `attachVerified` has no in-feature caller; FEAT-038's link token calls it. It is covered by `contacts.int`.

## Left to CI or later
- E2E `contact-merge.e2e.ts` and the page renders: verify stage's GitHub CI (no Docker here).

## Pending for Ken
- D1 decision card (typed details never join contacts). Also in /mnt/project-files/pending-actions.md.
