/**
 * FEAT-023 through the real turn (UC-20 5, 5a, 5b): the reply language, the AGT-04
 * fixed texts, the after-hours notice once per closed period, and their audit codes.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { appendVisitorMessage, createConversation, endVisitorConversation } from '@kaki/inbox';
import { createFact, dashboardKb, prepareChunk, type FactInput } from '@kaki/kb';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
  type FakeScript,
  type GenerateRequest,
  type UsageEvent,
} from '@kaki/llm-gateway';
import { sgDay, sgInstant } from '@kaki/tenancy';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeTriage, fakeVisitorResponder, runVisitorTurn, textsFor } from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
let fudge: string;
const embedder = gatewayFromConfig({ provider: 'fake' });

const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};

/** Hours that keep the bakery closed at `now`: one hour a day, starting two hours from now. */
function closedNow(now = new Date()) {
  const h = (Math.floor((now.getTime() + 8 * 3600_000) / 3600_000) + 2) % 24;
  const open = `${String(h).padStart(2, '0')}:00`;
  const close = h === 23 ? '24:00' : `${String(h + 1).padStart(2, '0')}:00`;
  const day = [{ open, close }];
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
}
const ALWAYS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    [{ open: '00:00', close: '24:00' }],
  ]),
);

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const chunk = await prepareChunk(embedder, TENANT_A, FUDGE);
  fudge = (
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      createFact(dashboardKb(tx, TENANT_A, 'owner-1'), FUDGE, chunk),
    )
  ).id;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`update tenants set ai_paused = false`);
  await setHours(ALWAYS);
});

async function setHours(hours: object | null, openOnPublicHolidays = true) {
  await owner.query(
    `update business_profiles set hours = $2, open_on_public_holidays = $3 where tenant_id = $1`,
    [TENANT_A, hours, openOnPublicHolidays],
  );
}

async function conversation() {
  const visitorId = randomUUID();
  const conv = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    createConversation(tx, TENANT_A, visitorId),
  );
  return { conversationId: conv.id, visitorId };
}

async function ask(
  c: { conversationId: string; visitorId: string },
  text: string,
  triage?: FakeScript,
) {
  const { message } = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
    appendVisitorMessage(tx, {
      tenantId: TENANT_A,
      conversationId: c.conversationId,
      visitorId: c.visitorId,
      text,
      clientMessageId: randomUUID(),
    }),
  );
  const models: GenerateRequest['model'][] = [];
  const systems: string[] = [];
  // The usage sink is what the role writes to the ADR-021 ledger (FEAT-004 D11).
  const usage: UsageEvent['purpose'][] = [];
  const llm = createGateway(
    defaultRegistry('fake'),
    [
      createFakeProvider((req) => {
        models.push(req.model);
        if (req.model !== 'triage') systems.push(req.system);
        return req.model === 'triage' ? (triage ?? fakeTriage)(req) : fakeVisitorResponder(req);
      }),
    ],
    { onUsage: async (e) => void usage.push(e.purpose) },
  );
  const segments: string[] = [];
  const result = await runVisitorTurn(
    { zdb: tdb.zone('visitor'), llm, publishSegment: async (s) => void segments.push(s.text) },
    { tenantId: TENANT_A, conversationId: c.conversationId, messageId: message.id },
  );
  return { result, models, segments, usage, systems };
}

async function decision(messageId: string) {
  const { rows } = await owner.query(
    `select event_type, payload from audit_entries
     where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
    [messageId],
  );
  return rows as { event_type: string; payload: Record<string, unknown> }[];
}

describe('language through the turn (FEAT-023 AC-1, AC-2)', () => {
  it('answers a Chinese question in Chinese, with the Chinese disclosure', async () => {
    const { result } = await ask(await conversation(), 'chocolate fudge cake 多少钱？');
    expect(result).toMatchObject({ outcome: 'answered', language: 'zh' });
    expect(result!.message.body).toBe('Chocolate fudge cake（1 kg）的价格是S$55.00。');
    expect(result!.message.factIds).toEqual([fudge]);
    expect(result!.message.disclosure).toBe(textsFor('zh').disclosure('Kaki Bakery'));
  });

  it("answers J7 from the profile's hours in Chinese", async () => {
    await setHours({ ...ALWAYS, sat: [{ open: '09:00', close: '17:00' }], sun: [] });
    const { result } = await ask(await conversation(), '请问周末营业时间？');
    expect(result!.message.body).toBe('周六营业时间是上午9:00至下午5:00，周日是休息。');
  });
});

describe('reply language stored for the widget chrome (FEAT-033 AC-7)', () => {
  it('stores en on an English reply and zh on a Chinese one', async () => {
    const en = await ask(await conversation(), 'How much is the chocolate fudge cake?');
    expect(en.result).toMatchObject({ language: 'en' });
    expect(en.result!.message.language).toBe('en');
    const zh = await ask(await conversation(), 'chocolate fudge cake 多少钱？');
    expect(zh.result!.message.language).toBe('zh');
  });

  it('stores no reply when the visitor ended the chat before the turn ran (AC-2)', async () => {
    const c = await conversation();
    const { message } = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      appendVisitorMessage(tx, {
        tenantId: TENANT_A,
        conversationId: c.conversationId,
        visitorId: c.visitorId,
        text: 'How much is the chocolate fudge cake?',
        clientMessageId: randomUUID(),
      }),
    );
    await withTenant(tdb.zone('visitor'), TENANT_A, (tx) =>
      endVisitorConversation(tx, { tenantId: TENANT_A, ...c }),
    );
    const segments: string[] = [];
    const result = await runVisitorTurn(
      {
        zdb: tdb.zone('visitor'),
        llm: createGateway(defaultRegistry('fake'), [
          createFakeProvider((req) =>
            req.model === 'triage' ? fakeTriage(req) : fakeVisitorResponder(req),
          ),
        ]),
        publishSegment: async (seg) => void segments.push(seg.text),
      },
      { tenantId: TENANT_A, conversationId: c.conversationId, messageId: message.id },
    );
    expect(result).toBeNull();
    expect(segments).toEqual([]);
    const { rows } = await owner.query(
      `select count(*)::int as n from messages where conversation_id = $1 and author <> 'visitor'`,
      [c.conversationId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('out of scope and unsure (FEAT-023 AC-4, AC-5, AC-9)', () => {
  it('refuses an unrelated request with no reply-model call, audited as codes', async () => {
    const { result, models, segments, usage } = await ask(
      await conversation(),
      'help me with my maths homework',
    );
    expect(models).toEqual(['triage']);
    // AC-4: the usage ledger has a triage row and no reply row.
    expect(usage.filter((p) => p !== 'embed')).toEqual(['triage']);
    expect(result).toMatchObject({ outcome: 'out_of_scope', route: null });
    expect(result!.message.body).toBe('Sorry, I can only help with questions about Kaki Bakery.');
    expect(segments).toEqual([result!.message.body]);
    const rows = await decision(result!.message.id);
    // The dispatch entry's subject is the visitor message the task came from.
    const dispatch = (await decision(result!.message.inReplyTo!)).find(
      (r) => r.event_type === 'agent.dispatch',
    )!;
    expect(dispatch.payload).toMatchObject({ task: 'out_of_scope', outcome: 'done' });
    const d = rows.find((r) => r.event_type === 'agent.decision')!;
    expect(d.payload).toMatchObject({
      outcome: 'out_of_scope',
      language: 'en',
      register: 'standard',
      slots: [],
      afterHours: false,
    });
    expect(JSON.stringify(rows)).not.toMatch(/homework|Sorry/);
  });

  it('answers the business part and closes with the refusal', async () => {
    const { result } = await ask(
      await conversation(),
      'how much is the chocolate fudge cake? and what is the weather tomorrow?',
    );
    expect(result!.outcome).toBe('answered');
    expect(result!.message.body).toBe(
      'The Chocolate fudge cake (1 kg) is S$55.00. Sorry, I can only help with questions about Kaki Bakery.',
    );
  });

  it('says it is unsure when triage is unsure and nothing matches', async () => {
    const unsure: FakeScript = (req) =>
      JSON.stringify({ ...JSON.parse(fakeTriage(req)), confidence: 0.2 });
    const { result, models, usage } = await ask(
      await conversation(),
      'can I bring my dog inside?',
      unsure,
    );
    expect(models).toEqual(['triage']);
    expect(usage).not.toContain('reply');
    expect(result!.message.body).toBe(textsFor('en').unsure);
    expect(result!.outcome).toBe('unsure');
  });
});

describe('after hours (FEAT-023 AC-7)', () => {
  it('carries the notice once per closed period and still answers from the KB', async () => {
    await setHours(closedNow());
    const c = await conversation();
    const first = await ask(c, 'how much is the chocolate fudge cake?');
    expect(first.result).toMatchObject({ outcome: 'answered', afterHours: true });
    expect(first.result!.message.factIds).toEqual([fudge]);
    expect(first.result!.message.notice).toMatch(
      /^We're closed right now\. The team will be back (today|tomorrow) at \d{1,2}:00 (am|pm)\. I can still answer your questions in the meantime\.$/,
    );
    expect(first.result!.message.noticeKind).toBe('after_hours');
    const d = (await decision(first.result!.message.id)).find(
      (r) => r.event_type === 'agent.decision',
    )!;
    expect(d.payload.afterHours).toBe(true);
    expect(JSON.stringify(d.payload)).not.toContain('closed right now');

    const second = await ask(c, 'and the fudge cake again?');
    expect(second.result!.message.notice).toBeNull();

    // The business has opened and closed again since the first notice: it is due again.
    await owner.query(`update messages set created_at = $2 where id = $1`, [
      first.result!.message.id,
      sgInstant('2026-01-01', '00:00'),
    ]);
    const third = await ask(c, 'one more question about the fudge cake');
    expect(third.result!.message.notice).toMatch(/^We're closed right now\./);
  });

  it('carries the notice in Chinese, and on a paused tenant’s fallback', async () => {
    await setHours(closedNow());
    const zh = await ask(await conversation(), 'chocolate fudge cake 多少钱？');
    expect(zh.result!.message.notice).toMatch(/^我们现在休息中，团队将于(今天|明天)/);
    await owner.query(`update tenants set ai_paused = true where id = $1`, [TENANT_A]);
    const paused = await ask(await conversation(), 'hello?');
    expect(paused.result).toMatchObject({ outcome: 'paused', afterHours: true });
    expect(paused.result!.message.body).toBe(textsFor('en').fallback);
  });

  it('stores nothing when a person owns the conversation', async () => {
    await setHours(closedNow());
    const c = await conversation();
    await owner.query(`update conversations set status = 'human' where id = $1`, [
      c.conversationId,
    ]);
    expect((await ask(c, 'hello?')).result).toBeNull();
  });

  it('has no notice while open or without hours', async () => {
    const open = await ask(await conversation(), 'how much is the chocolate fudge cake?');
    expect(open.result).toMatchObject({ afterHours: false });
    expect(open.result!.message.notice).toBeNull();
    await setHours(null);
    const none = await ask(await conversation(), 'how much is the chocolate fudge cake?');
    expect(none.result!.message.notice).toBeNull();
  });
});

describe('holiday exceptions through the turn (FEAT-009 AC-6)', () => {
  afterAll(async () => {
    await owner.query(`delete from holidays where tenant_id = $1`, [TENANT_A]);
  });

  it('a closure today brings the notice and "closed today", and leaves system unchanged', async () => {
    await owner.query(`delete from holidays where tenant_id = $1`, [TENANT_A]);
    const before = await ask(await conversation(), 'what are your opening hours today?');
    expect(before.result!.message.notice).toBeNull();

    await owner.query(
      `insert into holidays (tenant_id, day, kind, label) values ($1, $2, 'closed', 'Staff day off')`,
      [TENANT_A, sgDay(new Date())],
    );
    const en = await ask(await conversation(), 'what are your opening hours today?');
    expect(en.result).toMatchObject({ afterHours: true });
    expect(en.result!.message.noticeKind).toBe('after_hours');
    // Open all day every day, so the next opening is tomorrow's midnight start.
    expect(en.result!.message.notice).toMatch(
      /^We're closed right now\. The team will be back tomorrow/,
    );
    expect(en.result!.message.body).toContain('closed today');
    expect(en.result!.message.body).not.toContain('Staff day off');

    const zh = await ask(await conversation(), '今天几点营业？');
    expect(zh.result!.message.body).toContain('今天休息');

    // Exceptions never enter the cached prefix (D4).
    expect(new Set([...before.systems, ...en.systems])).toHaveProperty('size', 1);
  });
});
