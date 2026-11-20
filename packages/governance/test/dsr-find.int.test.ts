/**
 * Find, export and correction (FEAT-061 §5.2, §5.3; AC-3, AC-4, AC-5): a subject seeded across
 * every store is found by each identifier kind, mentions are opt-in, tenant B's identical email
 * is not found; the export holds the messages in order; correction swaps typed identities only.
 */
import { DsrCreateBody, sgToday } from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  correctSubject,
  createRequest,
  DsrError,
  exportSubject,
  findSubject,
  verifyRequest,
  type DsrRow,
} from '../src/index.js';
import { seedSubject, SUBJECT, type Seeded } from './dsr-seed.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userA: string;
let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)).rows[0]
    .id;
  a = await seedSubject(owner, TENANT_A);
  b = await seedSubject(owner, TENANT_B);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('dashboard'), TENANT_A, fn);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof DsrError) return e.code;
    throw e;
  }
};
async function verified(
  type: 'access' | 'correction' | 'deletion',
  requester: object,
): Promise<DsrRow> {
  const row = await dash((tx) =>
    createRequest(
      tx,
      TENANT_A,
      userA,
      DsrCreateBody.parse({ type, receivedOn: sgToday(), requester }),
    ),
  );
  return dash((tx) =>
    verifyRequest(tx, TENANT_A, userA, row.id, { version: 1, method: 'email_reply', note: 'ok' }),
  );
}

describe('findSubject (AC-3)', () => {
  it('finds the contact, its merged duplicate, conversations, stores and mentions by email', async () => {
    const f = await dash((tx) => findSubject(tx, TENANT_A, { email: SUBJECT.email }));
    expect(f.result.contacts.map((c) => c.id)).toEqual([a.contact]);
    const c = f.result.contacts[0]!;
    expect(c).toMatchObject({
      mergedFrom: 1,
      identities: 3,
      consents: 1,
      conversations: 3,
      auditPii: 1,
    });
    expect(c.leads.map((l) => l.id)).toEqual([a.lead]);
    expect(new Set(f.contactIds)).toEqual(new Set([a.contact, a.merged]));
    const byId = new Map(f.result.conversations.map((x) => [x.id, x]));
    for (const id of [a.widgetConv, a.emailConv, a.telegramConv])
      expect(byId.get(id)?.match).toBe('contact');
    expect(byId.get(a.emailConv)?.contactId).toBe(a.contact);
    expect(byId.has(a.otherConv)).toBe(false);
    expect(f.result.attachments.map((x) => x.name)).toEqual(['order.pdf']);
    expect(f.result.other).toMatchObject({
      approvals: 1,
      escalations: 1,
      suggestions: 1,
      summaries: 1,
      trackingEvents: 1,
      telegramChats: 1,
    });
    expect(f.result.kb.map((k) => [k.kind, k.id]).sort()).toEqual(
      [
        ['fact', a.fact],
        ['staged', a.staged],
      ].sort(),
    );
    for (const k of f.result.kb) expect(k.excerpt).not.toContain(SUBJECT.email);
    // Nothing of tenant B's identical subject.
    const all = JSON.stringify(f.result);
    for (const id of [b.contact, b.widgetConv, b.fact]) expect(all).not.toContain(id);
  });

  it('finds the same contact by phone (with the mention) and by Telegram ID', async () => {
    const p = await dash((tx) => findSubject(tx, TENANT_A, { phone: SUBJECT.phone }));
    expect(p.result.contacts.map((c) => c.id)).toEqual([a.contact]);
    const mention = p.result.conversations.find((x) => x.id === a.mentionConv);
    expect(mention).toMatchObject({ match: 'mention', contactId: null });
    const tg = await dash((tx) => findSubject(tx, TENANT_A, { telegramId: SUBJECT.telegramId }));
    expect(tg.result.contacts.map((c) => c.id)).toEqual([a.contact]);
    const none = await dash((tx) => findSubject(tx, TENANT_A, { email: 'nobody@example.com' }));
    expect(none.result.contacts).toEqual([]);
    expect(none.result.conversations).toEqual([]);
  });
});

describe('exportSubject (AC-4)', () => {
  it('exports the selected contact with its messages in order, attachments listed, and audits it', async () => {
    const req = await verified('access', { email: SUBJECT.email });
    // The phone's mention isn't in an email request's find result, so it can't be exported.
    expect(
      await code(
        dash((tx) =>
          exportSubject(tx, TENANT_A, userA, req.id, req.version, {
            contactIds: [a.contact],
            conversationIds: [a.mentionConv],
            factIds: [],
            stagedFactIds: [],
          }),
        ),
      ),
    ).toBe('not_in_result');
    const out = await dash((tx) =>
      exportSubject(tx, TENANT_A, userA, req.id, req.version, {
        contactIds: [a.contact],
        conversationIds: [],
        factIds: [a.fact],
        stagedFactIds: [],
      }),
    );
    expect(out.fileName).toMatch(/^data-request-DSR-[0-9A-F]{8}-\d{4}-\d{2}-\d{2}\.json$/);
    const f = out.file;
    expect(new Set(f.contacts.map((c) => c.id))).toEqual(new Set([a.contact, a.merged]));
    const widget = f.conversations.find((c) => c.id === a.widgetConv)!;
    expect(widget.messages.map((m) => m.body)).toEqual([
      'Hi, I want a birthday cake',
      'Sure, what size?',
    ]);
    expect(f.conversations.map((c) => c.id).sort()).toEqual(
      [a.widgetConv, a.emailConv, a.telegramConv].sort(),
    );
    expect(f.attachments).toEqual([expect.objectContaining({ name: 'order.pdf', size: 1200 })]);
    expect(f.leads).toHaveLength(1);
    expect(f.kb.map((k) => k.id)).toEqual([a.fact]);
    expect(JSON.stringify(f)).not.toContain('"salt"');
    const audit = (
      await owner.query(
        `select payload from audit_entries where tenant_id = $1 and event_type = 'dsr.exported' order by seq desc limit 1`,
        [TENANT_A],
      )
    ).rows[0]!.payload;
    expect(audit).toEqual({ contacts: 2, conversations: 3, messages: 4 });
  });

  it('refuses an open request, a stale version and an empty selection', async () => {
    const open = await dash((tx) =>
      createRequest(
        tx,
        TENANT_A,
        userA,
        DsrCreateBody.parse({
          type: 'access',
          receivedOn: sgToday(),
          requester: { email: SUBJECT.email },
        }),
      ),
    );
    const sel = { contactIds: [a.contact], conversationIds: [], factIds: [], stagedFactIds: [] };
    expect(await code(dash((tx) => exportSubject(tx, TENANT_A, userA, open.id, 1, sel)))).toBe(
      'state_changed',
    );
    const req = await verified('access', { email: SUBJECT.email });
    expect(await code(dash((tx) => exportSubject(tx, TENANT_A, userA, req.id, 1, sel)))).toBe(
      'state_changed',
    );
    expect(
      await code(
        dash((tx) =>
          exportSubject(tx, TENANT_A, userA, req.id, req.version, { ...sel, contactIds: [] }),
        ),
      ),
    ).toBe('nothing_selected');
    expect(
      await code(
        dash((tx) =>
          exportSubject(tx, TENANT_A, userA, req.id, req.version, {
            ...sel,
            contactIds: [b.contact],
          }),
        ),
      ),
    ).toBe('not_in_result');
  });
});

describe('correctSubject (AC-5)', () => {
  it('changes contact and lead fields, swaps the typed phone, keeps the verified email, and audits field names only', async () => {
    const req = await verified('correction', { phone: SUBJECT.phone });
    const out = await dash((tx) =>
      correctSubject(tx, TENANT_A, userA, req.id, {
        version: req.version,
        contactId: a.contact,
        contact: { name: 'Mei Ling Tan', phone: '+6598765432', email: 'mei.ling@example.com' },
        lead: { id: a.lead, need: 'Wedding cake' },
      }),
    );
    expect(out.fields).toEqual(['contact.name', 'contact.email', 'contact.phone', 'lead.need']);
    const c = (
      await owner.query(`select name, email, phone from contacts where id = $1`, [a.contact])
    ).rows[0];
    expect(c).toEqual({
      name: 'Mei Ling Tan',
      email: 'mei.ling@example.com',
      phone: '+6598765432',
    });
    const ids = (
      await owner.query(
        `select kind, value, source, verified_at is not null as v from contact_identities where contact_id = $1 order by kind, value`,
        [a.contact],
      )
    ).rows;
    expect(ids).toEqual([
      { kind: 'email', value: 'mei.ling@example.com', source: 'lead_form', v: false },
      { kind: 'email', value: SUBJECT.email, source: 'email', v: true },
      { kind: 'phone', value: '+6598765432', source: 'lead_form', v: false },
      { kind: 'telegram', value: SUBJECT.telegramId, source: 'telegram', v: true },
    ]);
    expect((await owner.query(`select need from leads where id = $1`, [a.lead])).rows[0].need).toBe(
      'Wedding cake',
    );
    const audit = (
      await owner.query(
        `select payload::text as p from audit_entries where tenant_id = $1 and event_type = 'dsr.corrected'`,
        [TENANT_A],
      )
    ).rows[0]!.p;
    expect(audit).toContain('contact.phone');
    expect(audit).not.toMatch(/Mei|9876|mei\.ling|Wedding/);
    // Restore for other suites in this file.
    await owner.query(
      `update contacts set name = 'Mei Tan', email = $2, phone = $3 where id = $1`,
      [a.contact, SUBJECT.email, SUBJECT.phone],
    );
    // A contact outside the find result, or an access request, is refused.
    const again = await verified('correction', { phone: SUBJECT.phone });
    expect(
      await code(
        dash((tx) =>
          correctSubject(tx, TENANT_A, userA, again.id, {
            version: again.version,
            contactId: a.otherContact,
            contact: { name: 'x' },
          }),
        ),
      ),
    ).toBe('not_in_result');
    const access = await verified('access', { phone: SUBJECT.phone });
    expect(
      await code(
        dash((tx) =>
          correctSubject(tx, TENANT_A, userA, access.id, {
            version: access.version,
            contactId: a.contact,
            contact: { name: 'x' },
          }),
        ),
      ),
    ).toBe('wrong_type');
  });
});
