/**
 * Scoring, the hot-lead alert, the pipeline and the export (FEAT-050 §5.2–§5.4; AC-1–AC-4,
 * AC-6–AC-9): scores are written at capture and on a criteria save, the alert fires once per
 * lead, status moves are compare-and-set, and audit entries carry IDs and codes only.
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { savePurposeStatement, verifyChain } from '@kaki/governance';
import type { Mailer } from '@kaki/platform';
import { sendDueNotifications } from '@kaki/platform/notifications';
import type { Qualification } from '@kaki/contracts';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  captureLead,
  exportLeads,
  leadCaptureConfig,
  leadDetail,
  LeadNotFound,
  LeadStale,
  leadSummaryOf,
  listLeads,
  OpenLeadExists,
  recordConsent,
  saveLeadSettings,
  setLeadStatus,
  submitContactForm,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let userA: string;

const dash = <T>(fn: (tx: Tx) => Promise<T>, t = TENANT_A) =>
  withTenant(tdb.zone('dashboard'), t, fn);
const vis = <T>(fn: (tx: Tx) => Promise<T>, t = TENANT_A) => withTenant(tdb.zone('visitor'), t, fn);

const ALL_OPTIONAL = [
  { key: 'name', mode: 'required' },
  { key: 'phone', mode: 'optional' },
  { key: 'email', mode: 'optional' },
  { key: 'need', mode: 'optional' },
  { key: 'budget', mode: 'optional' },
  { key: 'preferredTime', mode: 'optional' },
] as const;
const RIGHTS = { canManage: true, canExport: true };

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  userA = (await owner.query(`select id from users where email = 'owner@kaki-bakery.test'`)).rows[0]
    .id;
});
afterEach(async () => {
  await owner.query(`delete from notifications`);
  await owner.query(
    `delete from messages where card is not null or notice_kind = 'lead_captured' or task_kinds is not null`,
  );
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

const setup = async (
  qualification: Qualification = { keywords: ['wedding', '婚礼'], minBudget: 300 },
) => {
  await dash((tx) =>
    savePurposeStatement(tx, {
      tenantId: TENANT_A,
      userId: userA,
      version: 0,
      purpose: { en: 'To reply to you.', zh: '为了回复您。' },
    }),
  );
  return dash((tx) =>
    saveLeadSettings(tx, {
      tenantId: TENANT_A,
      userId: userA,
      version: 0,
      fields: ALL_OPTIONAL,
      marketing: { enabled: true, text: { en: 'Send me offers', zh: null } },
      qualification,
    }),
  );
};
/** Pass a `visitorId` for another chat from the same browser (FEAT-039 D1). */
const conversation = async (visitorId: string = randomUUID()) =>
  (
    await owner.query<{ id: string }>(
      `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'widget', $2) returning id`,
      [TENANT_A, visitorId],
    )
  ).rows[0]!.id;
const fields = (over: Partial<Record<string, string>> = {}) => ({
  name: 'Mei',
  phone: '',
  email: '',
  need: '',
  budget: '',
  preferredTime: '',
  ...over,
});
/** Consent then capture in one conversation (a new one unless given). */
const capture = async (
  over: Partial<Record<string, string>>,
  conv?: string,
  marketing?: boolean,
) => {
  const c = conv ?? (await conversation());
  const config = (await vis(leadCaptureConfig))!;
  const { consentId } = await vis((tx) =>
    recordConsent(tx, {
      tenantId: TENANT_A,
      conversationId: c,
      purposeWordingId: config.purpose.wordingId,
      agreed: true,
      ...(config.marketing
        ? { marketing: { wordingId: config.marketing.wordingId, agreed: marketing ?? false } }
        : {}),
    }),
  );
  const out = await vis((tx) =>
    captureLead(tx, {
      tenantId: TENANT_A,
      conversationId: c,
      consentId: consentId!,
      input: fields(over),
    }),
  );
  return { ...out, conversationId: c };
};
const hotAlerts = async (leadId: string) =>
  (
    await owner.query<{ n: number }>(
      `select count(*)::int n from notifications where kind = 'hot_lead' and subject_id = $1`,
      [leadId],
    )
  ).rows[0]!.n;
const activeMembers = async () =>
  (
    await vis((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int n from escalation_candidates()`),
    )
  ).rows[0]!.n;
const status = (leadId: string, to: 'new' | 'contacted' | 'won' | 'lost', version: number) =>
  dash((tx) =>
    setLeadStatus(tx, { tenantId: TENANT_A, leadId, status: to, version, userId: userA }),
  );

describe('scoring at capture and the hot-lead alert (AC-1–AC-3)', () => {
  it('scores at once; a hot capture alerts every active member once, never again', async () => {
    await setup();
    const cold = await capture({ email: 'cold@example.com' });
    expect(cold.scoring).toMatchObject({ score: 'cold', points: 0, alerted: false });
    expect(await hotAlerts(cold.leadId)).toBe(0);

    const hot = await capture({
      phone: '91234567',
      email: 'mei@example.com',
      need: 'A wedding cake, three tiers',
      budget: 'abt S$500',
    });
    expect(hot.scoring).toMatchObject({ score: 'hot', points: 6, previous: null, alerted: true });
    expect(hot.scoring.reasons.map((r) => r.code)).toEqual([
      'keyword',
      'budget_met',
      'both_contacts',
      'need_given',
    ]);
    const members = await activeMembers();
    expect(members).toBeGreaterThan(0);
    expect(await hotAlerts(hot.leadId)).toBe(members);
    const row = await owner.query(
      `select hot_alerted_at, score, scored_at from leads where id = $1`,
      [hot.leadId],
    );
    expect(row.rows[0].hot_alerted_at).not.toBeNull();
    // The sidebar and the detail show it at once (AC-2).
    expect(
      (await dash((tx) => leadSummaryOf(tx, TENANT_A, hot.conversationId)))?.scoring,
    ).toMatchObject({ score: 'hot', points: 6 });

    // A second capture (same person, same lead) and a criteria save write no further alert.
    const again = await capture(
      { email: 'mei@example.com', preferredTime: 'Sat' },
      hot.conversationId,
    );
    expect(again).toMatchObject({ status: 'updated', leadId: hot.leadId });
    expect(again.scoring).toMatchObject({ score: 'hot', alerted: false });
    const saved = await dash((tx) =>
      saveLeadSettings(tx, {
        tenantId: TENANT_A,
        userId: userA,
        version: 1,
        fields: ALL_OPTIONAL,
        marketing: { enabled: true, text: { en: 'Send me offers', zh: null } },
        qualification: { keywords: ['corporate'], minBudget: null },
      }),
    );
    expect(saved.rescored).toBe(2);
    expect(await hotAlerts(hot.leadId)).toBe(members);

    // Acceptance (AC-3): a won lead reopened later doesn't alert again.
    await status(hot.leadId, 'won', 1);
    await status(hot.leadId, 'new', 2);
    expect(await hotAlerts(hot.leadId)).toBe(members);
  });

  it('acceptance AC-3: the hot-lead alert is not urgent, so quiet hours hold it', async () => {
    await setup();
    const hot = await capture({
      phone: '91234567',
      email: 'quiet@example.com',
      need: 'A wedding cake',
      budget: 'S$500',
    });
    expect(hot.scoring).toMatchObject({ score: 'hot', alerted: true });
    const rows = await owner.query<{ urgent: boolean; status: string }>(
      `select urgent, status from notifications where kind = 'hot_lead' and subject_id = $1`,
      [hot.leadId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((r) => !r.urgent && r.status === 'pending')).toBe(true);
    // 23:00 in Singapore is inside the default quiet hours (22:00–08:00).
    const lateNight = new Date('2026-11-01T15:00:00Z');
    await owner.query(
      `update notifications set created_at = $1, next_attempt_at = $1 where subject_id = $2`,
      [lateNight, hot.leadId],
    );
    const sent: unknown[] = [];
    const mailer: Mailer = {
      async send(e) {
        sent.push(e);
      },
      async close() {},
    };
    const r = await sendDueNotifications(tdb.zone('identity'), mailer, {
      appUrl: 'https://app.test',
      now: lateNight,
    });
    expect(r.held).toBe(rows.rows.length);
    expect(sent).toHaveLength(0);
    const after = await owner.query<{ status: string }>(
      `select distinct status from notifications where kind = 'hot_lead' and subject_id = $1`,
      [hot.leadId],
    );
    expect(after.rows).toEqual([{ status: 'held' }]);
  });

  it('wants_to_order and returning come from the contact conversations', async () => {
    await setup({ keywords: [], minBudget: null });
    // FEAT-039 D1: the returning person is the same browser, not the same typed email.
    const browser = randomUUID();
    const first = await capture({ email: 'ah.kow@example.com' }, await conversation(browser));
    expect(first.scoring.points).toBe(0);
    const conv2 = await conversation(browser);
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body, task_kinds)
       values ($1, $2, 'agent', 'Sure, I can ask the team.', '{request_commitment}')`,
      [TENANT_A, conv2],
    );
    const second = await capture({ email: 'ah.kow@example.com' }, conv2);
    expect(second.leadId).toBe(first.leadId);
    expect(second.scoring.reasons.map((r) => r.code)).toEqual(['wants_to_order', 'returning']);
    expect(second.scoring.score).toBe('warm');
  });
});

describe('criteria save rescoring (AC-1)', () => {
  it('rescores open leads only, audits the count, and returns the template defaults first', async () => {
    await setup({ keywords: [], minBudget: null });
    const open = await capture({ email: 'open@example.com', need: 'Wedding cake' });
    const won = await capture({ email: 'won@example.com', need: 'Wedding cake' });
    await status(won.leadId, 'won', 1);
    expect(open.scoring.score).toBe('cold');
    const saved = await dash((tx) =>
      saveLeadSettings(tx, {
        tenantId: TENANT_A,
        userId: userA,
        version: 1,
        fields: ALL_OPTIONAL,
        marketing: { enabled: true, text: { en: 'Send me offers', zh: null } },
        qualification: { keywords: ['  WEDDING ', 'wedding', '婚礼'], minBudget: 100 },
      }),
    );
    expect(saved.qualification).toEqual({ keywords: ['wedding', '婚礼'], minBudget: 100 });
    expect(saved.rescored).toBe(1);
    const scores = await owner.query(
      `select id, score, score_points from leads order by created_at`,
    );
    expect(scores.rows).toEqual([
      { id: open.leadId, score: 'warm', score_points: 3 },
      { id: won.leadId, score: 'cold', score_points: 1 },
    ]);
    const a = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'settings.lead_fields_updated' order by seq desc limit 1`,
      [TENANT_A],
    );
    expect(a.rows[0].payload).toMatchObject({ changed: ['qualification'], rescored: 1 });
    // Same criteria again: nothing rescored.
    const same = await dash((tx) =>
      saveLeadSettings(tx, {
        tenantId: TENANT_A,
        userId: userA,
        version: 2,
        fields: ALL_OPTIONAL,
        marketing: { enabled: true, text: { en: 'Send me offers', zh: null } },
        qualification: { keywords: ['wedding', '婚礼'], minBudget: 100 },
      }),
    );
    expect(same.rescored).toBe(0);
  });
});

describe('status pipeline (AC-4)', () => {
  it('compare-and-set, stale with the row, same status unaudited, reopen guarded', async () => {
    await setup();
    // FEAT-039 D1: the same person is the same browser, not the same typed email.
    const browser = randomUUID();
    const a = await capture({ email: 'pipe@example.com' }, await conversation(browser));
    const moved = await status(a.leadId, 'contacted', 1);
    expect(moved).toMatchObject({ status: 'contacted', version: 2 });
    await expect(status(a.leadId, 'won', 1)).rejects.toSatisfy(
      (e) => e instanceof LeadStale && e.lead.version === 2 && e.lead.status === 'contacted',
    );
    expect(await status(a.leadId, 'contacted', 2)).toMatchObject({ version: 2 });
    await status(a.leadId, 'won', 2);
    // The same person comes back: a new open lead; reopening the won one is refused.
    const b = await capture({ email: 'pipe@example.com' }, await conversation(browser));
    expect(b.leadId).not.toBe(a.leadId);
    await expect(status(a.leadId, 'new', 3)).rejects.toBeInstanceOf(OpenLeadExists);
    await status(b.leadId, 'lost', 1);
    expect(await status(a.leadId, 'new', 3)).toMatchObject({ status: 'new', version: 4 });
    await expect(
      dash(
        (tx) =>
          setLeadStatus(tx, {
            tenantId: TENANT_B,
            leadId: a.leadId,
            status: 'won',
            version: 4,
            userId: userA,
          }),
        TENANT_B,
      ),
    ).rejects.toBeInstanceOf(LeadNotFound);
    const audits = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'lead.status_changed'
         and payload->>'leadId' = any($2) order by seq`,
      [TENANT_A, [a.leadId, b.leadId]],
    );
    expect(audits.rows.map((r) => [r.payload.from, r.payload.to])).toEqual([
      ['new', 'contacted'],
      ['contacted', 'won'],
      ['new', 'lost'],
      ['won', 'new'],
    ]);
    expect((await verifyChain(tdb.zone('dashboard'), TENANT_A)).ok).toBe(true);
  });
});

describe('list, detail and export (AC-4, AC-6, AC-8, AC-9)', () => {
  it('keyset pages, filters, counts, a contact-form lead, and tenant B sees none', async () => {
    await setup();
    const ids: string[] = [];
    for (const n of ['one', 'two', 'three'])
      ids.push(
        (await capture({ email: `${n}@example.com`, need: n === 'two' ? 'Wedding' : '' })).leadId,
      );
    const config = (await vis(leadCaptureConfig))!;
    const form = await vis((tx) =>
      submitContactForm(tx, {
        tenantId: TENANT_A,
        conversationId: null,
        purposeWordingId: config.purpose.wordingId,
        marketing: { wordingId: config.marketing!.wordingId, agreed: true },
        input: fields({ email: 'form@example.com', phone: '61234567' }),
      }),
    );
    await status(ids[0]!, 'won', 1);

    const p1 = await dash((tx) => listLeads(tx, TENANT_A, { status: 'open', limit: 2 }));
    expect(p1.items.map((i) => i.id)).toEqual([form.leadId, ids[2]]);
    expect(p1.counts).toEqual({ new: 3, contacted: 0, won: 1, lost: 0 });
    expect(p1.items[0]).toMatchObject({
      source: 'contact_form',
      phone: '+65 6123 4567',
      marketing: { agreed: true },
    });
    const p2 = await dash((tx) =>
      listLeads(tx, TENANT_A, { status: 'open', limit: 2, cursor: p1.nextCursor! }),
    );
    expect(p2.items.map((i) => i.id)).toEqual([ids[1]]);
    expect(p2.nextCursor).toBeNull();
    expect(p2.items[0]).toMatchObject({ source: 'chat', marketing: { agreed: false } });
    const all = await dash((tx) => listLeads(tx, TENANT_A, { status: 'all', limit: 50 }));
    expect(all.items).toHaveLength(4);
    const warm = await dash((tx) =>
      listLeads(tx, TENANT_A, { status: 'all', score: 'warm', limit: 50 }),
    );
    expect(warm.items.map((i) => i.id)).toEqual([ids[1]]);
    const won = await dash((tx) => listLeads(tx, TENANT_A, { status: 'won', limit: 50 }));
    expect(won.items.map((i) => i.id)).toEqual([ids[0]]);

    const b = await dash((tx) => listLeads(tx, TENANT_B, { status: 'all', limit: 50 }), TENANT_B);
    expect(b).toEqual({
      items: [],
      nextCursor: null,
      counts: { new: 0, contacted: 0, won: 0, lost: 0 },
    });
    expect(
      (await dash((tx) => exportLeads(tx, TENANT_B, { status: 'all' }), TENANT_B)).rows,
    ).toEqual([]);
    expect((await dash((tx) => exportLeads(tx, TENANT_A, { status: 'open' }))).rows.length).toBe(3);
  });

  it('the detail lists every consent with its exact wording and the conversations', async () => {
    await setup();
    const conv = await conversation();
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body, language) values ($1, $2, 'agent', '你好', 'zh')`,
      [TENANT_A, conv],
    );
    const a = await capture({ email: 'zh@example.com', need: '婚礼蛋糕' }, conv, false);
    const d = await dash((tx) => leadDetail(tx, TENANT_A, a.leadId, RIGHTS));
    expect(d).toMatchObject({
      id: a.leadId,
      need: '婚礼蛋糕',
      captures: 1,
      source: 'chat',
      canManage: true,
      scoring: { score: 'warm' },
    });
    expect(d.consents.map((c) => [c.purpose, c.decision, c.wording?.text])).toEqual(
      expect.arrayContaining([
        ['enquiry', 'agreed', '为了回复您。'],
        ['marketing', 'declined', 'Send me offers'],
      ]),
    );
    expect(d.consents).toHaveLength(2);
    expect(d.conversations.map((c) => c.id)).toEqual([conv]);
    await expect(
      dash((tx) => leadDetail(tx, TENANT_B, a.leadId, RIGHTS), TENANT_B),
    ).rejects.toBeInstanceOf(LeadNotFound);
  });

  it('no audit entry carries a name, email, phone or need', async () => {
    await setup();
    const a = await capture({
      email: 'secret.person@example.com',
      phone: '98765432',
      need: 'Wedding cake for Jasmine',
      budget: 'S$900',
    });
    await status(a.leadId, 'contacted', 1);
    const rows = await owner.query(`select payload from audit_entries where tenant_id = $1`, [
      TENANT_A,
    ]);
    expect(JSON.stringify(rows.rows)).not.toMatch(/Mei|secret|Jasmine|Wedding cake|example/);
    const scored = await owner.query(
      `select payload from audit_entries where tenant_id = $1 and event_type = 'lead.scored'
         and payload->>'leadId' = $2`,
      [TENANT_A, a.leadId],
    );
    expect(scored.rows[0].payload).toMatchObject({ score: 'hot', alerted: true });
  });
});
