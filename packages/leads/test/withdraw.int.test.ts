/**
 * Consent withdrawal (FEAT-051 §5.1, §5.2; AC-3–AC-6, AC-8): append-only withdrawal rows per
 * contact, once under concurrency, the team alerted (not the recorder), hot-lead alerts
 * cancelled, the lead left out of exports, re-consent making it usable again, IDs-only audits.
 */
import { sql, withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { savePurposeStatement } from '@kaki/governance';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  auditExport,
  captureLead,
  ConsentRequired,
  ConsentWithdrawn,
  consentState,
  exportLeads,
  leadCaptureConfig,
  leadDetail,
  leadRowOf,
  recordConsent,
  saveLeadSettings,
  ScopeNotOffered,
  withdrawalTarget,
  withdrawConsent,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userA: string;

const dash = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('dashboard'), TENANT_A, fn);
const vis = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(tdb.zone('visitor'), TENANT_A, fn);

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)).rows[0]
    .id;
  await dash((tx) =>
    savePurposeStatement(tx, {
      tenantId: TENANT_A,
      userId: userA,
      version: 0,
      purpose: { en: 'To reply to you.', zh: '为了回复您。' },
    }),
  );
  await dash((tx) =>
    saveLeadSettings(tx, {
      tenantId: TENANT_A,
      userId: userA,
      version: 0,
      fields: [
        { key: 'name', mode: 'required' },
        { key: 'phone', mode: 'optional' },
        { key: 'email', mode: 'optional' },
        { key: 'need', mode: 'optional' },
        { key: 'budget', mode: 'optional' },
        { key: 'preferredTime', mode: 'optional' },
      ],
      marketing: { enabled: true, text: { en: 'Send me offers', zh: null } },
      qualification: { keywords: ['wedding'], minBudget: 300 },
    }),
  );
});
afterEach(async () => {
  await owner.query(`delete from notifications`);
  await owner.query(`delete from messages where card is not null or notice_kind is not null`);
  await owner.query(`delete from leads`);
  await owner.query(`delete from consents`);
  await owner.query(`update conversations set contact_id = null`);
  await owner.query(`delete from contacts`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const conversation = async (visitorId?: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id)
       values ($1, 'widget', coalesce($2::uuid, gen_random_uuid())) returning id`,
      [TENANT_A, visitorId ?? null],
    )
  ).rows[0]!.id;
const consent = async (conversationId: string, offers: boolean) => {
  const config = (await vis(leadCaptureConfig))!;
  return (
    await vis((tx) =>
      recordConsent(tx, {
        tenantId: TENANT_A,
        conversationId,
        purposeWordingId: config.purpose.wordingId,
        agreed: true,
        marketing: { wordingId: config.marketing!.wordingId, agreed: offers },
      }),
    )
  ).consentId!;
};
const HOT = {
  name: 'Mei',
  phone: '91234567',
  email: 'mei@example.com',
  need: 'A wedding cake, three tiers',
  budget: 'abt S$500',
  preferredTime: '',
};
/** A distinct contact per `email` (contacts resolve by email, then phone). */
const capture = async (offers: boolean, conv?: string, email = HOT.email) => {
  const c = conv ?? (await conversation());
  const consentId = await consent(c, offers);
  const out = await vis((tx) =>
    captureLead(tx, {
      tenantId: TENANT_A,
      conversationId: c,
      consentId,
      input: { ...HOT, email, phone: email === HOT.email ? HOT.phone : '' },
    }),
  );
  return { ...out, conversationId: c, consentId };
};
const withdraw = (
  contactId: string,
  scope: 'all' | 'marketing',
  conversationId: string | null,
  recordedBy: string | null = null,
) =>
  (recordedBy ? dash : vis)((tx) =>
    withdrawConsent(tx, {
      tenantId: TENANT_A,
      contactId,
      scope,
      channel: recordedBy ? 'dashboard' : 'widget',
      conversationId,
      recordedBy,
    }),
  );
const rowsOf = async (contactId: string) =>
  (
    await owner.query<{ purpose: string; decision: string; channel: string }>(
      `select purpose, decision, channel from consents
       where contact_id = $1 and decision = 'withdrawn' order by purpose`,
      [contactId],
    )
  ).rows;
const alerts = async (kind: string, status?: string) =>
  (
    await owner.query<{ n: number }>(
      `select count(*)::int n from notifications where kind = $1 and ($2::text is null or status = $2)`,
      [kind, status ?? null],
    )
  ).rows[0]!.n;
const members = async () =>
  (
    await vis((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int n from escalation_candidates()`),
    )
  ).rows[0]!.n;

describe('withdrawConsent (AC-3–AC-5)', () => {
  it('all writes enquiry and marketing rows when offers were agreed, alerts the team once', async () => {
    const a = await capture(true);
    expect(await alerts('hot_lead', 'pending')).toBe(await members());
    const w = await withdraw(a.contactId, 'all', a.conversationId);
    expect(w.status).toBe('withdrawn');
    expect(w.consentIds).toHaveLength(2);
    expect(await rowsOf(a.contactId)).toEqual([
      { purpose: 'enquiry', decision: 'withdrawn', channel: 'widget' },
      { purpose: 'marketing', decision: 'withdrawn', channel: 'widget' },
    ]);
    expect(await alerts('consent_withdrawn')).toBe(await members());
    expect(await alerts('hot_lead', 'pending')).toBe(0);
    const row = (await dash((tx) => leadRowOf(tx, TENANT_A, a.leadId)))!;
    expect(row.consentWithdrawnAt).not.toBeNull();
    expect(row.marketing).toMatchObject({ agreed: false, withdrawn: true });

    expect(await withdraw(a.contactId, 'all', a.conversationId)).toEqual({
      status: 'already_withdrawn',
      consentIds: [],
    });
    expect(await rowsOf(a.contactId)).toHaveLength(2);
    expect(await alerts('consent_withdrawn')).toBe(await members());
  });

  it('all writes only the enquiry row when offers were not agreed', async () => {
    const a = await capture(false);
    await withdraw(a.contactId, 'all', a.conversationId);
    expect(await rowsOf(a.contactId)).toEqual([
      { purpose: 'enquiry', decision: 'withdrawn', channel: 'widget' },
    ]);
  });

  it('marketing writes one row, keeps the lead usable; refused when offers were never agreed', async () => {
    const a = await capture(true);
    const w = await withdraw(a.contactId, 'marketing', a.conversationId);
    expect(w).toMatchObject({ status: 'withdrawn' });
    expect(w.consentIds).toHaveLength(1);
    const row = (await dash((tx) => leadRowOf(tx, TENANT_A, a.leadId)))!;
    expect(row.consentWithdrawnAt).toBeNull();
    expect(row.marketing).toMatchObject({ agreed: false, withdrawn: true });
    expect(await alerts('hot_lead', 'pending')).toBe(await members());
    const { rows } = await dash((tx) => exportLeads(tx, TENANT_A, { status: 'all' }));
    expect(rows.map((r) => r.id)).toEqual([a.leadId]);
    expect((await withdraw(a.contactId, 'marketing', a.conversationId)).status).toBe(
      'already_withdrawn',
    );

    const b = await capture(false, undefined, 'b@example.com');
    await expect(withdraw(b.contactId, 'marketing', b.conversationId)).rejects.toThrow(
      ScopeNotOffered,
    );
  });

  it('two concurrent presses write once', async () => {
    const a = await capture(true);
    const both = await Promise.all([
      withdraw(a.contactId, 'all', a.conversationId),
      withdraw(a.contactId, 'all', a.conversationId),
    ]);
    expect(both.map((w) => w.status).sort()).toEqual(['already_withdrawn', 'withdrawn']);
    expect(await rowsOf(a.contactId)).toHaveLength(2);
  });

  it('a staff withdrawal is a dashboard row naming its recorder, who gets no alert', async () => {
    const a = await capture(false);
    await withdraw(a.contactId, 'all', null, userA);
    expect(await rowsOf(a.contactId)).toEqual([
      { purpose: 'enquiry', decision: 'withdrawn', channel: 'dashboard' },
    ]);
    expect(await alerts('consent_withdrawn')).toBe((await members()) - 1);
    const mine = await owner.query(
      `select 1 from notifications where kind = 'consent_withdrawn' and user_id = $1`,
      [userA],
    );
    expect(mine.rowCount).toBe(0);
    const d = await dash((tx) =>
      leadDetail(tx, TENANT_A, a.leadId, { canManage: true, canExport: true }, async (ids) => {
        expect(ids).toEqual([userA]);
        return new Map([[userA, 'Ken Tan']]);
      }),
    );
    expect(d.consents[0]).toMatchObject({
      purpose: 'enquiry',
      decision: 'withdrawn',
      channel: 'dashboard',
      wording: null,
      recordedBy: 'Ken Tan',
      conversationId: null,
    });
  });

  it('no audit payload carries a name, email or phone', async () => {
    const a = await capture(true);
    await withdraw(a.contactId, 'all', a.conversationId);
    const rows = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'consent.withdrawn'
         and payload->>'contactId' = $2`,
      [TENANT_A, a.contactId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].payload).toMatchObject({ scope: 'all', channel: 'widget' });
    expect(JSON.stringify(rows.rows)).not.toMatch(/Mei|example|9123|wedding/i);
  });
});

describe('exports and re-consent (AC-6, AC-8)', () => {
  it('the export right after leaves the lead out and the audit says excluded: 1', async () => {
    const a = await capture(false);
    const other = await capture(false, undefined, 'o@example.com');
    await withdraw(a.contactId, 'all', a.conversationId);
    const out = await dash(async (tx) => {
      const e = await exportLeads(tx, TENANT_A, { status: 'all' });
      await auditExport(tx, {
        tenantId: TENANT_A,
        userId: userA,
        count: e.rows.length,
        excluded: e.excluded,
        filters: { status: 'all' },
      });
      return e;
    });
    expect(out.rows.map((r) => r.id)).toEqual([other.leadId]);
    expect(out.excluded).toBe(1);
    const audit = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'lead.exported'
       order by seq desc limit 1`,
      [TENANT_A],
    );
    expect(audit.rows[0].payload).toMatchObject({ count: 1, excluded: 1 });
  });

  it('after a withdrawal the old consent no longer captures; a new one makes the lead usable', async () => {
    const a = await capture(false);
    await withdraw(a.contactId, 'all', a.conversationId);
    const state = await vis((tx) => consentState(tx, TENANT_A, a.conversationId));
    expect(state).toMatchObject({ enquiry: 'withdrawn', consentId: null, withdrawn: true });

    const again = vis((tx) =>
      captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: a.conversationId,
        consentId: a.consentId,
        input: HOT,
      }),
    );
    await expect(again).rejects.toThrow(ConsentWithdrawn);
    await expect(again).rejects.toBeInstanceOf(ConsentRequired);

    const fresh = await consent(a.conversationId, false);
    expect((await vis((tx) => consentState(tx, TENANT_A, a.conversationId))).consentId).toBe(fresh);
    await vis((tx) =>
      captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: a.conversationId,
        consentId: fresh,
        input: HOT,
      }),
    );
    const row = (await dash((tx) => leadRowOf(tx, TENANT_A, a.leadId)))!;
    expect(row.consentWithdrawnAt).toBeNull();
    const { rows, excluded } = await dash((tx) => exportLeads(tx, TENANT_A, { status: 'all' }));
    expect(rows.map((r) => r.id)).toEqual([a.leadId]);
    expect(excluded).toBe(0);
  });
});

describe('withdrawalTarget (D2)', () => {
  it("finds the contact through the same visitor's earlier conversation, not another visitor's", async () => {
    const a = await capture(true);
    const { rows } = await owner.query<{ visitor_id: string }>(
      `select visitor_id from conversations where id = $1`,
      [a.conversationId],
    );
    const later = await conversation(rows[0]!.visitor_id);
    expect(await vis((tx) => withdrawalTarget(tx, TENANT_A, later))).toEqual({
      contactId: a.contactId,
      offers: true,
      withdrawn: false,
    });
    expect(await vis((tx) => withdrawalTarget(tx, TENANT_A, a.conversationId))).toMatchObject({
      contactId: a.contactId,
    });
    const stranger = await conversation();
    expect(await vis((tx) => withdrawalTarget(tx, TENANT_A, stranger))).toBeNull();
    await withdraw(a.contactId, 'all', later);
    expect(await vis((tx) => withdrawalTarget(tx, TENANT_A, later))).toEqual({
      contactId: a.contactId,
      offers: false,
      withdrawn: true,
    });
  });
});
