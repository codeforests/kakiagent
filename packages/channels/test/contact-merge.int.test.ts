/**
 * Merge, undo and the Contact page's reads (CHN-08; FEAT-039 §5.2–§5.4, D5–D7; AC-3–AC-6):
 * a merge moves every contact-keyed row and fills empty display values, undo moves back
 * exactly that, refusals are typed, and duplicates and search see only active contacts.
 */
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contactDetail,
  duplicateCount,
  duplicatesOf,
  mergeContacts,
  NotMergeable,
  searchContacts,
  undoMerge,
  UndoBlocked,
} from '../src/contacts/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userId: string;
let wording: string;
const dash = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('dashboard'), TENANT_A, fn);
const q = <T extends pg.QueryResultRow = { id: string }>(text: string, args: unknown[] = []) =>
  owner.query<T>(text, args);
const names = async (ids: string[]) => new Map(ids.map((id) => [id, 'Mei Ling']));

/** A contact with a conversation, a consent and an open lead. */
async function person(v: {
  name?: string;
  email?: string;
  phone?: string;
  telegram?: number;
  username?: string;
}) {
  const id = (
    await q(
      `insert into contacts (tenant_id, name, email, phone, telegram_id, telegram_username)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        TENANT_A,
        v.name ?? null,
        v.email ?? null,
        v.phone ?? null,
        v.telegram ?? null,
        v.username ?? null,
      ],
    )
  ).rows[0]!.id;
  const conv = (
    await q(
      `insert into conversations (tenant_id, channel, visitor_id, contact_id)
       values ($1, $2, gen_random_uuid(), $3) returning id`,
      [TENANT_A, v.telegram ? 'telegram' : 'widget', id],
    )
  ).rows[0]!.id;
  const consent = (
    await q(
      `insert into consents (tenant_id, contact_id, conversation_id, purpose, decision, wording_id, channel)
       values ($1, $2, $3, 'enquiry', 'agreed', $4, 'widget') returning id`,
      [TENANT_A, id, conv, wording],
    )
  ).rows[0]!.id;
  await q(
    `insert into leads (tenant_id, contact_id, consent_id, conversation_id, need) values ($1, $2, $3, $4, 'Cake')`,
    [TENANT_A, id, consent, conv],
  );
  const ident = (kind: string, value: string, source: string, verified: boolean) =>
    q(
      `insert into contact_identities (tenant_id, contact_id, kind, value, source, verified_at)
       values ($1, $2, $3, $4, $5, ${verified ? 'now()' : 'null'})`,
      [TENANT_A, id, kind, value, source],
    );
  if (v.email) await ident('email', v.email, 'lead_form', false);
  if (v.phone) await ident('phone', v.phone, 'lead_form', false);
  if (v.telegram) {
    await ident('telegram', String(v.telegram), 'telegram', true);
    await q(
      `insert into telegram_chats (tenant_id, chat_id, bot_id, contact_id) values ($1, $2, 1, $3)`,
      [TENANT_A, v.telegram, id],
    );
  }
  return id;
}

/** Where each contact-keyed row of the tenant is, plus the display columns. */
async function where() {
  const rows = async (text: string) => (await q<Record<string, unknown>>(text, [TENANT_A])).rows;
  return {
    conversations: await rows(
      `select id, contact_id from conversations where tenant_id = $1 and contact_id is not null order by id`,
    ),
    consents: await rows(`select id, contact_id from consents where tenant_id = $1 order by id`),
    leads: await rows(
      `select id, contact_id, superseded_by from leads where tenant_id = $1 order by id`,
    ),
    chats: await rows(`select chat_id, contact_id from telegram_chats where tenant_id = $1`),
    pii: await rows(
      `select id, contact_id from audit_pii where tenant_id = $1 and contact_id is not null order by id`,
    ),
    identities: await rows(
      `select id, contact_id from contact_identities where tenant_id = $1 order by id`,
    ),
    contacts: await rows(
      `select id, name, email, phone, telegram_id, telegram_username, merged_into
       from contacts where tenant_id = $1 order by id`,
    ),
  };
}

let siti: string;
let other: string;
let third: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userId = (await q(`select id from users where email = 'owner@kaki-bakery.test'`)).rows[0]!.id;
  wording = (
    await q(
      `insert into wording_versions (tenant_id, kind, seq, content)
       values ($1, 'purpose_statement', 1, '{"en":"To reply."}') returning id`,
      [TENANT_A],
    )
  ).rows[0]!.id;
});

beforeEach(async () => {
  for (const table of ['contact_merges', 'telegram_chats', 'leads', 'consents'])
    await q(`delete from ${table}`);
  await q(`delete from audit_pii where contact_id is not null`);
  await q(`update conversations set contact_id = null`);
  await q(`update contacts set merged_into = null, merged_at = null`);
  await q(`delete from contacts`);
  siti = await person({ name: 'Siti', email: 'siti@kaki.test' });
  other = await person({
    email: 'siti@kaki.test',
    phone: '+6591234567',
    telegram: 8001,
    username: 'siti_t',
  });
  third = await person({ name: 'Ah Kow', phone: '+6581234567' });
  await q(
    `insert into audit_pii (tenant_id, contact_id, salt, data) values ($1, $2, '\\x01', '{}')`,
    [TENANT_A, other],
  );
});

afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('duplicates and search (§5.2, §5.4)', () => {
  it('duplicates list the shared values and skip merged-away contacts', async () => {
    expect(await dash((tx) => duplicatesOf(tx, TENANT_A, siti))).toEqual([
      {
        contactId: other,
        label: 'siti@kaki.test',
        shared: [{ kind: 'email', value: 'siti@kaki.test' }],
      },
    ]);
    expect(await dash((tx) => duplicateCount(tx, TENANT_A, siti))).toBe(1);
    // A contact merged away no longer counts; its identifiers now belong to the survivor.
    await dash((tx) =>
      mergeContacts(tx, {
        tenantId: TENANT_A,
        survivorId: third,
        mergedId: other,
        automatic: false,
        actorId: userId,
      }),
    );
    expect(await dash((tx) => duplicatesOf(tx, TENANT_A, siti))).toEqual([
      { contactId: third, label: 'Ah Kow', shared: [{ kind: 'email', value: 'siti@kaki.test' }] },
    ]);
  });

  it('search matches name, email, phone and Telegram username, excluding one', async () => {
    const hits = (text: string, exclude?: string) =>
      dash((tx) => searchContacts(tx, TENANT_A, text, exclude)).then((r) =>
        r.map((h) => h.contactId),
      );
    expect(await hits('ah k')).toEqual([third]);
    expect((await hits('SITI@')).sort()).toEqual([siti, other].sort());
    expect(await hits('siti@', siti)).toEqual([other]);
    expect(await hits('9123 4567')).toEqual([other]);
    expect(await hits('siti_t')).toEqual([other]);
    expect(await hits('100%')).toEqual([]);
    const [hit] = await dash((tx) => searchContacts(tx, TENANT_A, '8123'));
    expect(hit).toMatchObject({ label: 'Ah Kow', phone: '+65 8123 4567', email: null });
  });
});

describe('merge and undo (§5.3; AC-3–AC-6)', () => {
  it('moves every row, fills empty display values, supersedes the second open lead, and audits IDs and counts', async () => {
    const before = await where();
    const { mergeId, moved } = await dash((tx) =>
      mergeContacts(tx, {
        tenantId: TENANT_A,
        survivorId: siti,
        mergedId: other,
        automatic: false,
        actorId: userId,
      }),
    );
    expect(moved).toMatchObject({ filled: ['phone', 'telegram_id', 'telegram_username'] });
    const after = await where();
    const on = (rows: Record<string, unknown>[], id: string) =>
      rows.filter((r) => r.contact_id === id).length;
    for (const k of ['conversations', 'consents', 'leads', 'chats', 'pii'] as const)
      expect(on(after[k], other), k).toBe(0);
    expect(on(after.conversations, siti)).toBe(2);
    // The identical lead-form email stays with the merged contact; phone and Telegram move.
    expect(on(after.identities, other)).toBe(1);
    expect(on(after.identities, siti)).toBe(3);
    const open = after.leads.filter((l) => l.contact_id === siti && l.superseded_by === null);
    expect(open).toHaveLength(1);
    expect(after.leads.filter((l) => l.superseded_by === open[0]!.id)).toHaveLength(1);
    expect(after.contacts.find((k) => k.id === siti)).toMatchObject({
      name: 'Siti',
      email: 'siti@kaki.test',
      phone: '+6591234567',
      telegram_id: '8001',
      telegram_username: 'siti_t',
    });

    const audit = await q<{ payload: Record<string, unknown>; actor_ref: string }>(
      `select payload, actor_ref from audit_entries
       where tenant_id = $1 and event_type = 'contact.merged' and payload->>'mergeId' = $2`,
      [TENANT_A, mergeId],
    );
    expect(audit.rows).toEqual([
      {
        actor_ref: userId,
        payload: {
          mergeId,
          survivor: siti,
          merged: other,
          automatic: false,
          conversations: 1,
          consents: 1,
          leads: 1,
          identities: 2,
        },
      },
    ]);

    // The Contact page: the survivor lists everything and the merge; the other redirects.
    const page = (await dash((tx) => contactDetail(tx, TENANT_A, siti, names)))!;
    expect(page.conversationCount).toBe(2);
    expect(page.identities.map((i) => [i.kind, i.value, i.verified])).toEqual([
      ['email', 'siti@kaki.test', false],
      ['phone', '+65 9123 4567', false],
      ['telegram', '@siti_t', true],
    ]);
    expect(page.merges).toMatchObject([
      {
        mergeId,
        otherContactId: other,
        by: 'Mei Ling',
        automatic: false,
        canUndo: true,
        undoneAt: null,
      },
    ]);
    expect(page.conversations.map((c) => c.channel).sort()).toEqual(['telegram', 'widget']);
    expect(await dash((tx) => contactDetail(tx, TENANT_A, other))).toMatchObject({
      mergedInto: { contactId: siti, label: 'Siti', mergeId },
      identities: [],
      conversations: [],
    });

    // Undo: exactly the moved rows go back; a conversation and a consent made since stay.
    const later = (
      await q(
        `insert into conversations (tenant_id, channel, visitor_id, contact_id) values ($1, 'widget', gen_random_uuid(), $2) returning id`,
        [TENANT_A, siti],
      )
    ).rows[0]!.id;
    const laterConsent = (
      await q(
        `insert into consents (tenant_id, contact_id, purpose, decision, channel) values ($1, $2, 'enquiry', 'withdrawn', 'widget') returning id`,
        [TENANT_A, siti],
      )
    ).rows[0]!.id;
    await dash((tx) => undoMerge(tx, { tenantId: TENANT_A, mergeId, actorId: userId }));
    const undone = await where();
    const drop = (rows: Record<string, unknown>[], id: string) => rows.filter((r) => r.id !== id);
    expect({
      ...undone,
      conversations: drop(undone.conversations, later),
      consents: drop(undone.consents, laterConsent),
    }).toEqual(before);
    expect(undone.conversations.find((c) => c.id === later)!.contact_id).toBe(siti);
    expect(undone.consents.find((c) => c.id === laterConsent)!.contact_id).toBe(siti);
    const unmerged = await q(
      `select payload from audit_entries
       where tenant_id = $1 and event_type = 'contact.unmerged' and payload->>'mergeId' = $2`,
      [TENANT_A, mergeId],
    );
    expect(unmerged.rows).toEqual([{ payload: { mergeId, survivor: siti, merged: other } }]);
    expect((await dash((tx) => contactDetail(tx, TENANT_A, siti, names)))!.merges[0]).toMatchObject(
      {
        canUndo: false,
      },
    );
    await expect(
      dash((tx) => undoMerge(tx, { tenantId: TENANT_A, mergeId, actorId: userId })),
    ).rejects.toEqual(new UndoBlocked('already_undone'));
  });

  it('refuses the same contact, a merged-away one, and undo after the survivor was merged elsewhere', async () => {
    const merge = (survivorId: string, mergedId: string) =>
      dash((tx) =>
        mergeContacts(tx, {
          tenantId: TENANT_A,
          survivorId,
          mergedId,
          automatic: false,
          actorId: userId,
        }),
      );
    await expect(merge(siti, siti)).rejects.toEqual(new NotMergeable('same_contact'));
    const first = await merge(siti, other);
    await expect(merge(third, other)).rejects.toEqual(new NotMergeable('merged'));
    await expect(merge(other, third)).rejects.toEqual(new NotMergeable('merged'));
    const second = await merge(third, siti);
    await expect(
      dash((tx) => undoMerge(tx, { tenantId: TENANT_A, mergeId: first.mergeId, actorId: userId })),
    ).rejects.toEqual(new UndoBlocked('survivor_merged'));
    // Undo in order works: the later merge first.
    await dash((tx) =>
      undoMerge(tx, { tenantId: TENANT_A, mergeId: second.mergeId, actorId: userId }),
    );
    await dash((tx) =>
      undoMerge(tx, { tenantId: TENANT_A, mergeId: first.mergeId, actorId: userId }),
    );
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from contacts where merged_into is not null`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});
