/**
 * Coaching through the real turn on the fake provider (AGT-17, ONB-05; FEAT-027 §5.2,
 * §5.3; AC-2, AC-3, AC-4, AC-5, AC-8, AC-9, AC-11).
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { usageSink } from '@kaki/analytics';
import {
  confirmCorrection,
  correctionFactInput,
  CorrectionStaleError,
  createFact,
  dashboardKb,
  prepareChunk,
  type FactInput,
} from '@kaki/kb';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  gatewayFromConfig,
  type GenerateRequest,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStatus, visitorTenantState } from '@kaki/tenancy';
import {
  applyHoursWith,
  COACH_TEXTS,
  CoachingSessionNotFoundError,
  createSession,
  fakeAgentScript,
  reanswer,
  runCoachingTurn,
  systemSlots,
  textsFor,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = '00000000-0000-4000-8000-0000000000a1';
const embedder = gatewayFromConfig({ provider: 'fake' });
let fudge: string;
let tart: string;

const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};
const TART: FactInput = {
  type: 'product',
  value: { name: 'Lemon tart', priceCents: 900, currency: 'SGD' },
  gstTreatment: 'inclusive',
};

async function create(input: FactInput) {
  const chunk = await prepareChunk(embedder, TENANT_A, input);
  return (
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      createFact(dashboardKb(tx, TENANT_A, USER), input, chunk),
    )
  ).id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  fudge = await create(FUDGE);
  tart = await create(TART);
  await owner.query(`update facts set status = 'needs_review' where id = $1`, [tart]);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`update tenants set ai_paused = false`);
});

function gateway() {
  const models: GenerateRequest['model'][] = [];
  const llm = createGateway(
    defaultRegistry('fake'),
    [
      createFakeProvider((req) => {
        models.push(req.model);
        return fakeAgentScript(req);
      }),
    ],
    { onUsage: usageSink(tdb.zone('dashboard'), { warn: () => {} }) },
  );
  return { llm, models };
}

async function session() {
  return withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    createSession(tx, { tenantId: TENANT_A, userId: USER, origin: 'coach' }),
  );
}

async function turn(
  sessionId: string,
  text: string,
  includeUnreviewed = false,
  extra: { channelLive?: () => Promise<boolean> } = {},
) {
  const { llm, models } = gateway();
  const result = await runCoachingTurn(
    { zdb: tdb.zone('dashboard'), llm, ...extra },
    { tenantId: TENANT_A, userId: USER, sessionId, text, includeUnreviewed },
  );
  return { ...result, models };
}

async function count(table: string) {
  return Number((await owner.query(`select count(*) from ${table}`)).rows[0].count);
}

describe('a coaching answer (AC-2, AC-3)', () => {
  it('is grounded and verified, with an explainer of the facts considered and used', async () => {
    const s = await session();
    const r = await turn(s.id, 'How much is the chocolate fudge cake?');
    expect(r.answer).toMatchObject({ author: 'agent', kind: 'answer', outcome: 'answered' });
    expect(r.answer.body).toContain('$55.00');
    expect(r.answer.factIds).toEqual([fudge]);
    const ex = r.answer.explainer as Record<string, unknown>;
    expect(ex).toMatchObject({
      outcome: 'answered',
      usedFactIds: [fudge],
      visitorsWouldGet: 'same',
      reasons: expect.arrayContaining(['matched_facts']),
    });
    expect(ex.route).toMatch(/^reply\./);
    expect(ex.facts).toEqual(
      expect.arrayContaining([
        {
          id: fudge,
          type: 'product',
          label: 'Chocolate fudge cake',
          status: 'approved',
          used: true,
        },
      ]),
    );
    expect(r.question).toMatchObject({ seq: 1, kind: 'question', author: 'owner' });
    expect(r.answer.seq).toBe(2);
    const title = (await owner.query(`select title from coaching_sessions where id = $1`, [s.id]))
      .rows[0].title;
    expect(title).toBe('How much is the chocolate fudge cake?');
  });

  it('leaves unreviewed facts out unless asked, and labels them when used', async () => {
    const s = await session();
    const without = await turn(s.id, 'How much is the lemon tart?', false);
    expect(without.answer.factIds).not.toContain(tart);
    const ex1 = without.answer.explainer as { facts: { id: string }[] };
    expect(ex1.facts.map((f) => f.id)).not.toContain(tart);
    const withIt = await turn(s.id, 'How much is the lemon tart?', true);
    expect(withIt.answer.factIds).toContain(tart);
    expect(withIt.answer.explainer).toMatchObject({
      visitorsWouldGet: 'without_unreviewed',
      reasons: expect.arrayContaining(['unreviewed_used']),
      facts: expect.arrayContaining([
        expect.objectContaining({ id: tart, status: 'needs_review', used: true }),
      ]),
    });
  });

  it('gives the AGT-04 text to an out-of-scope question (AC-4)', async () => {
    const s = await session();
    const r = await turn(s.id, 'help me with my maths homework');
    const business = (await owner.query(`select name from tenants where id = $1`, [TENANT_A]))
      .rows[0].name;
    expect(r.answer.body).toBe(textsFor('en').outOfScope(business));
    expect(r.answer.explainer).toMatchObject({
      outcome: 'out_of_scope',
      reasons: expect.arrayContaining(['out_of_scope']),
      route: null,
    });
  });

  it('works while paused or not live, and says what visitors get instead (AC-11)', async () => {
    const s = await session();
    await owner.query(`update tenants set ai_paused = true where id = $1`, [TENANT_A]);
    const paused = await turn(s.id, 'How much is the chocolate fudge cake?');
    expect(paused.answer.body).toContain('$55.00');
    expect(paused.answer.explainer).toMatchObject({ visitorsWouldGet: 'fallback_paused' });
    await owner.query(`update tenants set ai_paused = false where id = $1`, [TENANT_A]);
    const notLive = await turn(s.id, 'How much is the chocolate fudge cake?', false, {
      channelLive: async () => false,
    });
    expect(notLive.answer.body).toContain('$55.00');
    expect(notLive.answer.explainer).toMatchObject({ visitorsWouldGet: 'not_live' });
  });

  it("an unknown or another tenant's session is not found", async () => {
    await expect(turn('00000000-0000-4000-8000-00000000dead', 'hi')).rejects.toThrow(
      CoachingSessionNotFoundError,
    );
  });
});

describe('a correction (AC-5)', () => {
  it('stores an open proposal and makes no reply-model call; then a confirm and re-answer', async () => {
    const s = await session();
    await turn(s.id, 'How much is the chocolate fudge cake?');
    const r = await turn(s.id, 'Chocolate fudge cake went up to $58');
    expect(r.models).not.toContain('reply.simple');
    expect(r.models).not.toContain('reply.complex');
    expect(r.models).toContain('extract');
    expect(r.answer).toMatchObject({
      kind: 'proposal',
      body: COACH_TEXTS.proposal,
      explainer: null,
    });
    expect(r.correction).toMatchObject({
      status: 'open',
      coachingMessageId: r.answer.id,
      factRefs: [fudge],
      change: {
        kind: 'edit_fact',
        before: { value: { priceCents: 5500 } },
        after: { value: { priceCents: 5800 } },
      },
    });
    expect(r.answer.correctionId).toBe(r.correction!.id);

    // Confirm (the api's path), then re-ask the coached question (UC-04 step 7, D7).
    const c = r.correction!;
    const chunk = await prepareChunk(embedder, TENANT_A, correctionFactInput(c)!);
    const done = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      confirmCorrection(dashboardKb(tx, TENANT_A, USER), c.id, { chunk }),
    );
    const { llm } = gateway();
    const ba = await reanswer(
      { zdb: tdb.zone('dashboard'), llm },
      { tenantId: TENANT_A, userId: USER, correction: done },
    );
    expect(ba.before?.body).toContain('$55.00');
    expect(ba.after).toMatchObject({ kind: 'after', correctionId: c.id });
    expect(ba.after?.body).toContain('$58.00');
  });

  it('asks the owner to name the item when it cannot tell', async () => {
    const s = await session();
    const r = await turn(s.id, 'That is wrong');
    expect(r.answer).toMatchObject({ kind: 'answer', body: COACH_TEXTS.unclear });
    expect(r.correction).toBeNull();
    expect(r.models).not.toContain('reply.simple');
  });
});

describe('isolation and audit (AC-8, AC-9)', () => {
  it('writes no conversations, messages or outbox rows; usage is keyed by the session', async () => {
    const before = await Promise.all(['conversations', 'messages', 'outbox'].map(count));
    const s = await session();
    await turn(s.id, 'How much is the chocolate fudge cake?');
    const after = await Promise.all(['conversations', 'messages', 'outbox'].map(count));
    expect(after).toEqual(before);
    const usage = (
      await owner.query(
        `select conversation_id, coaching_session_id from usage_events where coaching_session_id = $1`,
        [s.id],
      )
    ).rows;
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) expect(u.conversation_id).toBeNull();
  });

  it('stores the masked text and audits codes and IDs only', async () => {
    const s = await session();
    const r = await turn(s.id, 'My NRIC is S1234567D, how much is the chocolate fudge cake?');
    expect(r.question.body).not.toContain('S1234567D');
    const rows = (
      await owner.query(
        `select event_type, payload::text as p from audit_entries
         where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
        [s.id],
      )
    ).rows as { event_type: string; p: string }[];
    expect(rows.map((x) => x.event_type)).toContain('coach.turn');
    for (const x of rows) expect(x.p).not.toMatch(/fudge|NRIC|S1234567D/i);
  });
});

describe('an hours correction (D10, AC-12)', () => {
  it('proposes sat and sun, and confirming saves the profile that the visitor slot reads', async () => {
    const s = await session();
    const r = await turn(s.id, "We're open 9am to 5pm on weekends now");
    expect(r.correction).toMatchObject({
      status: 'open',
      change: {
        kind: 'edit_hours',
        after: {
          sat: [{ open: '09:00', close: '17:00' }],
          sun: [{ open: '09:00', close: '17:00' }],
        },
      },
    });
    expect(Object.keys((r.correction!.change as { after: object }).after).sort()).toEqual([
      'sat',
      'sun',
    ]);
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      confirmCorrection(dashboardKb(tx, TENANT_A, USER), r.correction!.id, {
        applyHours: applyHoursWith({ tenantId: TENANT_A, userId: USER }),
      }),
    );
    const state = await withTenant(tdb.zone('visitor'), TENANT_A, (tx) => visitorTenantState(tx));
    expect(state!.hours!.sat).toEqual([{ open: '09:00', close: '17:00' }]);
    expect(state!.hours!.sun).toEqual([{ open: '09:00', close: '17:00' }]);
    const now = new Date();
    const slots = systemSlots(
      {
        hours: state!.hours!,
        openOnPublicHolidays: state!.openOnPublicHolidays,
        status: openStatus(state!.hours!, state!.openOnPublicHolidays, now, state!.holidays),
        now,
      },
      'en',
    );
    expect(slots.get('hours.sat')).toMatch(/9(:00)?\s?am.*5(:00)?\s?pm/i);
  });

  it('a profile saved in between makes the confirm stale, and nothing changes', async () => {
    const s = await session();
    const r = await turn(s.id, "We're open 8am to 2pm on Sundays now");
    expect(r.correction?.change.kind).toBe('edit_hours');
    await owner.query(`update business_profiles set version = version + 1 where tenant_id = $1`, [
      TENANT_A,
    ]);
    await expect(
      withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
        confirmCorrection(dashboardKb(tx, TENANT_A, USER), r.correction!.id, {
          applyHours: applyHoursWith({ tenantId: TENANT_A, userId: USER }),
        }),
      ),
    ).rejects.toThrow(CorrectionStaleError);
    const status = (
      await owner.query(`select status from corrections where id = $1`, [r.correction!.id])
    ).rows[0].status;
    expect(status).toBe('open');
  });
});
