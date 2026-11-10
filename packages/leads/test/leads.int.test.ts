/**
 * Consent and lead capture (FEAT-049 §5.1, §5.2; AC-1–AC-6, AC-11): consent rows name the wording
 * shown, nothing is captured without a granted consent, fields are checked against the settings,
 * duplicates update the contact's one open lead, and audit entries carry IDs and codes only.
 */
import { withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { savePurposeStatement, verifyChain } from '@kaki/governance';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  captureLead,
  ConsentRequired,
  consentState,
  contactOf,
  getLeadSettings,
  leadCaptureConfig,
  LeadFieldsInvalid,
  LeadSettingsInvalid,
  LeadSettingsStale,
  leadSummaryOf,
  NotCapturing,
  recordConsent,
  saveLeadSettings,
  submitContactForm,
  WordingChanged,
  DEFAULT_FIELDS,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userA: string;

const dash = <T>(fn: (tx: Tx) => Promise<T>, t = TENANT_A) =>
  withTenant(tdb.zone('dashboard'), t, fn);
const vis = <T>(fn: (tx: Tx) => Promise<T>, t = TENANT_A) => withTenant(tdb.zone('visitor'), t, fn);

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)).rows[0]
    .id;
});
afterEach(async () => {
  await owner.query(`delete from messages where card is not null or notice_kind = 'lead_captured'`);
  await owner.query(`delete from leads`);
  await owner.query(`delete from consents`);
  await owner.query(`update conversations set contact_id = null`);
  await owner.query(`delete from contacts`);
  await owner.query(`delete from lead_settings`);
  await owner.query(`delete from privacy_settings`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const savePurpose = () =>
  dash((tx) =>
    savePurposeStatement(tx, {
      tenantId: TENANT_A,
      userId: userA,
      version: 0,
      purpose: { en: 'To reply to you.', zh: null },
    }),
  );
const conversation = async (t = TENANT_A) =>
  (
    await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', gen_random_uuid()) returning id`,
      [t],
    )
  ).rows[0]!.id;
const marketingOn = (version = 0) =>
  dash((tx) =>
    saveLeadSettings(tx, {
      tenantId: TENANT_A,
      userId: userA,
      version,
      fields: DEFAULT_FIELDS,
      marketing: { enabled: true, text: { en: 'Send me offers', zh: null } },
    }),
  );
const agree = async (conversationId: string | null, marketing?: boolean) => {
  const config = (await vis(leadCaptureConfig))!;
  return vis((tx) =>
    recordConsent(tx, {
      tenantId: TENANT_A,
      conversationId,
      purposeWordingId: config.purpose.wordingId,
      agreed: true,
      ...(marketing !== undefined && config.marketing
        ? { marketing: { wordingId: config.marketing.wordingId, agreed: marketing } }
        : {}),
    }),
  );
};
const fields = (over: Partial<Record<string, string>> = {}) => ({
  name: 'Mei',
  phone: '',
  email: '',
  need: '',
  budget: '',
  preferredTime: '',
  ...over,
});

describe('lead settings (SCR-APP-043; D3)', () => {
  it('defaults follow the industry; saves compare-and-set and keep marketing wordings', async () => {
    const first = await dash((tx) => getLeadSettings(tx, TENANT_A));
    expect(first.version).toBe(0);
    expect(first.fields.find((f) => f.key === 'preferredTime')?.mode).toBe('optional'); // F&B
    expect(first.marketing).toMatchObject({ enabled: false, wording: null });
    expect((await dash((tx) => getLeadSettings(tx, TENANT_B), TENANT_B)).fields).toEqual(
      DEFAULT_FIELDS,
    );
    const saved = await marketingOn();
    expect(saved).toMatchObject({ version: 1, marketing: { enabled: true, wording: { seq: 1 } } });
    await expect(marketingOn(0)).rejects.toBeInstanceOf(LeadSettingsStale);
    // Same text: no new wording.
    expect((await marketingOn(1)).marketing.wording?.seq).toBe(1);
    await expect(
      dash((tx) =>
        saveLeadSettings(tx, {
          tenantId: TENANT_A,
          userId: userA,
          version: 2,
          fields: DEFAULT_FIELDS,
          marketing: { enabled: true, text: { en: '  ', zh: null } },
        }),
      ),
    ).rejects.toBeInstanceOf(LeadSettingsInvalid);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });

  it('the widget config is null without a purpose statement, and shows marketing only when on', async () => {
    expect(await vis(leadCaptureConfig)).toBeNull();
    await savePurpose();
    const off = (await vis(leadCaptureConfig))!;
    expect(off.marketing).toBeNull();
    expect(off.purpose.text).toEqual({ en: 'To reply to you.', zh: 'To reply to you.' });
    expect(off.fields.map((f) => f.key)).toEqual([
      'name',
      'phone',
      'email',
      'need',
      'preferredTime',
    ]);
    await marketingOn();
    expect((await vis(leadCaptureConfig))!.marketing?.text.en).toBe('Send me offers');
  });
});

describe('consent (LED-02, LED-08; AC-2–AC-4)', () => {
  it('records the wording shown and refuses a stale one without writing', async () => {
    await savePurpose();
    const conv = await conversation();
    const { consentId } = await agree(conv);
    const row = await owner.query(
      `select purpose, decision, wording_id, contact_id from consents where id = $1`,
      [consentId],
    );
    const config = (await vis(leadCaptureConfig))!;
    expect(row.rows[0]).toEqual({
      purpose: 'enquiry',
      decision: 'agreed',
      wording_id: config.purpose.wordingId,
      contact_id: null,
    });
    await dash((tx) =>
      savePurposeStatement(tx, {
        tenantId: TENANT_A,
        userId: userA,
        version: 1,
        purpose: { en: 'A new purpose.', zh: null },
      }),
    );
    await expect(
      vis((tx) =>
        recordConsent(tx, {
          tenantId: TENANT_A,
          conversationId: conv,
          purposeWordingId: config.purpose.wordingId,
          agreed: true,
        }),
      ),
    ).rejects.toBeInstanceOf(WordingChanged);
    expect((await owner.query(`select count(*)::int n from consents`)).rows[0].n).toBe(1);
  });

  it('a decline records no contact; the state says so; marketing gets its own row', async () => {
    await savePurpose();
    await marketingOn();
    const conv = await conversation();
    const config = (await vis(leadCaptureConfig))!;
    const declined = await vis((tx) =>
      recordConsent(tx, {
        tenantId: TENANT_A,
        conversationId: conv,
        purposeWordingId: config.purpose.wordingId,
        agreed: false,
      }),
    );
    expect(declined.consentId).toBeNull();
    expect(await vis((tx) => consentState(tx, TENANT_A, conv))).toEqual({
      enquiry: 'declined',
      consentId: null,
      withdrawn: false,
      offered: false,
      captured: false,
    });
    // With the opt-in shown, agreeing must answer it.
    await expect(
      vis((tx) =>
        recordConsent(tx, {
          tenantId: TENANT_A,
          conversationId: conv,
          purposeWordingId: config.purpose.wordingId,
          agreed: true,
        }),
      ),
    ).rejects.toBeInstanceOf(WordingChanged);
    const agreed = await agree(conv, false);
    const rows = await owner.query(
      `select purpose, decision, wording_id from consents where conversation_id = $1 order by purpose, decision`,
      [conv],
    );
    expect(rows.rows).toEqual([
      { purpose: 'enquiry', decision: 'agreed', wording_id: config.purpose.wordingId },
      { purpose: 'enquiry', decision: 'declined', wording_id: config.purpose.wordingId },
      { purpose: 'marketing', decision: 'declined', wording_id: config.marketing!.wordingId },
    ]);
    expect(await vis((tx) => consentState(tx, TENANT_A, conv))).toMatchObject({
      enquiry: 'agreed',
      consentId: agreed.consentId,
    });
  });

  it('refuses everything without a purpose statement (fail closed)', async () => {
    const conv = await conversation();
    await expect(
      vis((tx) =>
        recordConsent(tx, {
          tenantId: TENANT_A,
          conversationId: conv,
          purposeWordingId: conv,
          agreed: true,
        }),
      ),
    ).rejects.toBeInstanceOf(NotCapturing);
  });
});

describe('capture (LED-01, LED-09; AC-1, AC-5, AC-6)', () => {
  it('needs a granted consent of the same conversation', async () => {
    await savePurpose();
    const a = await conversation();
    const b = await conversation();
    const { consentId } = await agree(a);
    await expect(
      vis((tx) =>
        captureLead(tx, {
          tenantId: TENANT_A,
          conversationId: b,
          consentId: consentId!,
          input: fields({ phone: '91234567' }),
        }),
      ),
    ).rejects.toBeInstanceOf(ConsentRequired);
    expect((await owner.query(`select count(*)::int n from leads`)).rows[0].n).toBe(0);
  });

  it('rejects bad fields with per-field codes and stores nothing', async () => {
    await savePurpose();
    const conv = await conversation();
    const { consentId } = await agree(conv);
    const err = await vis((tx) =>
      captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: conv,
        consentId: consentId!,
        input: fields({ name: '', phone: '1234' }),
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeadFieldsInvalid);
    expect((err as LeadFieldsInvalid).body).toEqual({
      error: 'invalid_fields',
      fields: { name: 'required', phone: 'invalid' },
      needsContact: false,
    });
    const none = await vis((tx) =>
      captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: conv,
        consentId: consentId!,
        input: fields(),
      }),
    ).catch((e: unknown) => e);
    expect((none as LeadFieldsInvalid).body.needsContact).toBe(true);
    expect((await owner.query(`select count(*)::int n from contacts`)).rows[0].n).toBe(0);
  });

  it('creates the contact and lead, links consent and conversation, and posts the notice', async () => {
    await savePurpose();
    await marketingOn();
    const conv = await conversation();
    const { consentId } = await agree(conv, true);
    const out = await vis((tx) =>
      captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: conv,
        consentId: consentId!,
        input: fields({ phone: '+65 9123-4567', email: 'Mei@Example.com', need: 'A cake for 20' }),
      }),
    );
    expect(out.status).toBe('created');
    expect(out.notice).toMatchObject({ author: 'system', noticeKind: 'lead_captured' });
    expect(out.notice!.notice).toContain('Kaki Bakery');
    const contact = await owner.query(`select name, email, phone from contacts where id = $1`, [
      out.contactId,
    ]);
    expect(contact.rows[0]).toEqual({
      name: 'Mei',
      email: 'mei@example.com',
      phone: '+6591234567',
    });
    const linked = await owner.query(
      `select count(*)::int n from consents where conversation_id = $1 and contact_id = $2`,
      [conv, out.contactId],
    );
    expect(linked.rows[0].n).toBe(2); // enquiry and marketing
    expect(await dash((tx) => contactOf(tx, TENANT_A, conv))).toEqual({
      contactId: out.contactId,
      name: 'Mei',
      email: 'mei@example.com',
      phone: '+65 9123 4567',
      telegramUsername: null,
    });
    expect(await dash((tx) => leadSummaryOf(tx, TENANT_A, conv))).toMatchObject({
      id: out.leadId,
      status: 'new',
      consent: { marketing: { agreed: true } },
    });
    expect(await vis((tx) => consentState(tx, TENANT_A, conv))).toMatchObject({ captured: true });
    // Tenant B sees none of it.
    expect(await dash((tx) => contactOf(tx, TENANT_B, conv), TENANT_B)).toBeNull();
    // Audit entries carry IDs and codes only (AC-11).
    const audit = await owner.query<{ event_type: string; payload: unknown }>(
      `select event_type, payload from audit_entries where tenant_id = $1 and event_type in ('lead.created', 'consent.recorded') order by seq`,
      [TENANT_A],
    );
    expect(JSON.stringify(audit.rows)).not.toMatch(/Mei|9123|example/i);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });

  it('a returning visitor updates their open lead; a closed lead starts a new one', async () => {
    await savePurpose();
    const first = await conversation();
    const c1 = (await agree(first)).consentId!;
    const a = await vis((tx) =>
      captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: first,
        consentId: c1,
        input: fields({ email: 'ah@kow.sg', need: 'Cake' }),
      }),
    );
    const second = await conversation();
    const c2 = (await agree(second)).consentId!;
    const b = await vis((tx) =>
      captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: second,
        consentId: c2,
        input: fields({ name: 'Ah Kow', email: 'AH@kow.sg', phone: '81234567' }),
      }),
    );
    expect(b).toMatchObject({ status: 'updated', leadId: a.leadId, contactId: a.contactId });
    const lead = await owner.query(
      `select need, captures, consent_id, conversation_id from leads where id = $1`,
      [a.leadId],
    );
    expect(lead.rows[0]).toEqual({
      need: 'Cake',
      captures: 2,
      consent_id: c2,
      conversation_id: second,
    });
    const contact = await owner.query(`select name, phone from contacts where id = $1`, [
      a.contactId,
    ]);
    expect(contact.rows[0]).toEqual({ name: 'Ah Kow', phone: '+6581234567' });
    await owner.query(`update leads set status = 'won' where id = $1`, [a.leadId]);
    const third = await conversation();
    const c3 = (await agree(third)).consentId!;
    const c = await vis((tx) =>
      captureLead(tx, {
        tenantId: TENANT_A,
        conversationId: third,
        consentId: c3,
        input: fields({ phone: '8123 4567' }),
      }),
    );
    expect(c.status).toBe('created');
    expect(c.contactId).toBe(a.contactId);
  });

  it('concurrent submits for one person leave one contact and one open lead', async () => {
    await savePurpose();
    const convs = await Promise.all([conversation(), conversation(), conversation()]);
    const consents = await Promise.all(convs.map((c) => agree(c)));
    await Promise.all(
      convs.map((conv, i) =>
        vis((tx) =>
          captureLead(tx, {
            tenantId: TENANT_A,
            conversationId: conv,
            consentId: consents[i]!.consentId!,
            input: fields({ email: 'same@person.sg' }),
          }),
        ),
      ),
    );
    const counts = await owner.query(
      `select (select count(*)::int from contacts) contacts, (select count(*)::int from leads where status = 'new') leads, (select max(captures) from leads) captures`,
    );
    expect(counts.rows[0]).toEqual({ contacts: 1, leads: 1, captures: 3 });
  });

  it('the contact form records consent and the lead together, or nothing on bad fields (AC-9)', async () => {
    await savePurpose();
    const config = (await vis(leadCaptureConfig))!;
    await expect(
      vis((tx) =>
        submitContactForm(tx, {
          tenantId: TENANT_A,
          conversationId: null,
          purposeWordingId: config.purpose.wordingId,
          input: fields({ email: 'bad' }),
        }),
      ),
    ).rejects.toBeInstanceOf(LeadFieldsInvalid);
    expect((await owner.query(`select count(*)::int n from consents`)).rows[0].n).toBe(0);
    const out = await vis((tx) =>
      submitContactForm(tx, {
        tenantId: TENANT_A,
        conversationId: null,
        purposeWordingId: config.purpose.wordingId,
        input: fields({ phone: '61234567' }),
      }),
    );
    expect(out).toMatchObject({ status: 'created', notice: null });
    const row = await owner.query(`select contact_id, conversation_id from consents`);
    expect(row.rows).toEqual([{ contact_id: out.contactId, conversation_id: null }]);
  });
});
