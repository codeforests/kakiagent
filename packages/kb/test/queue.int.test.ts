/**
 * The corrections queue (KB-18, KB-17, UC-16; FEAT-018 §5.1; AC-2–AC-6, AC-9 kb half):
 * listing, accepting as proposed or edited, closing, re-confirming stale facts.
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptCorrection,
  coachingKb,
  CorrectionClosedError,
  correctionCounts,
  correctionFactInput,
  correctionFacts,
  CorrectionStaleError,
  createFact,
  dashboardKb,
  dismissCorrection,
  editedChange,
  getCorrection,
  getFact,
  InvalidCorrectionError,
  listCorrections,
  NotEditableError,
  prepareChunk,
  proposeCorrection,
  reviewSummary,
  runStaleScan,
  searchVisitorFacts,
  visitorKb,
  type CorrectionEdit,
  type CorrectionRecord,
  type FactInput,
  type ProposalInput,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const llm = gatewayFromConfig({ provider: 'fake' });
const USER = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-0000000000b1';
const CONV = '00000000-0000-4000-8000-0000000000c1';

const product = (name: string, priceCents: number): FactInput => ({
  type: 'product',
  value: { name, priceCents, currency: 'SGD' },
  gstTreatment: 'inclusive',
});

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  for (const t of [TENANT_A, TENANT_B])
    await owner.query(
      `insert into coaching_sessions (tenant_id, id, created_by, origin) values ($1, $2, $3, 'coach')`,
      [t, SESSION, USER],
    );
});
beforeEach(async () => {
  await owner.query(`delete from corrections`);
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = () => tdb.zone('dashboard');
const ctx = (tenantId: string) => (tx: Parameters<typeof dashboardKb>[0]) =>
  dashboardKb(tx, tenantId, USER);

async function create(tenantId: string, input: FactInput) {
  const chunk = await prepareChunk(llm, tenantId, input);
  return withTenant(dash(), tenantId, (tx) => createFact(ctx(tenantId)(tx), input, chunk));
}

const fact = (tenantId: string, id: string) =>
  withTenant(dash(), tenantId, (tx) => getFact(ctx(tenantId)(tx), id));

function propose(tenantId: string, proposal: ProposalInput) {
  return withTenant(dash(), tenantId, (tx) =>
    proposeCorrection(coachingKb(tx, tenantId, USER, SESSION), { proposal }),
  );
}

/** As the API does it: build the edited fix, embed the effective fact, then accept. */
async function accept(tenantId: string, c: CorrectionRecord, edit: CorrectionEdit | null = null) {
  const accepted = edit
    ? await withTenant(dash(), tenantId, (tx) =>
        editedChange({ tx, tenantId, userId: USER }, c, edit),
      )
    : null;
  const input = correctionFactInput(c, accepted);
  const chunk = input ? await prepareChunk(llm, tenantId, input) : undefined;
  return withTenant(dash(), tenantId, (tx) =>
    acceptCorrection(ctx(tenantId)(tx), c.id, { edit, ...(chunk ? { chunk } : {}) }),
  );
}

async function age(id: string, months: number) {
  await owner.query(
    `update facts set last_confirmed_at = now() - make_interval(months => $2) - interval '1 day' where id = $1`,
    [id, months],
  );
}

async function staleItem(tenantId: string, factId: string) {
  await runStaleScan(tdb.zone('outbox'));
  const { rows } = await owner.query(
    `select id from corrections where tenant_id = $1 and source_type = 'stale' and status = 'open' and fact_refs[1] = $2`,
    [tenantId, factId],
  );
  return withTenant(dash(), tenantId, (tx) => getCorrection({ tx, tenantId }, rows[0].id));
}

async function visitorSearch(tenantId: string, q: string) {
  const { vectors } = await llm.embed({ texts: [q], purpose: 'query', meta: { tenantId } });
  return withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    searchVisitorFacts(visitorKb(tx, tenantId, CONV), vectors[0]!),
  );
}

const list = (tenantId: string, q: Parameters<typeof listCorrections>[1]) =>
  withTenant(dash(), tenantId, (tx) => listCorrections({ tx, tenantId }, q));

describe('the queue (AC-2, AC-10)', () => {
  it('lists open items newest first, by source, then closed ones by decision; tenant B sees none', async () => {
    const f = await create(TENANT_A, product('Ondeh ondeh', 1200));
    const a = await propose(TENANT_A, { kind: 'add_faq', question: 'Halal?', answer: 'Yes.' });
    const b = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: f.id,
      patch: { value: { name: 'Ondeh ondeh', priceCents: 1300, currency: 'SGD' } },
    });
    await age(f.id, 7);
    const s = await staleItem(TENANT_A, f.id);
    const open = await list(TENANT_A, { status: 'open' });
    expect(open.corrections.map((c) => c.id)).toEqual([s.id, b.id, a.id]);
    expect(open.nextCursor).toBeNull();
    expect((await list(TENANT_A, { status: 'open', source: 'stale' })).corrections).toHaveLength(1);
    expect((await list(TENANT_B, { status: 'open' })).corrections).toEqual([]);

    const counts = await withTenant(dash(), TENANT_A, (tx) =>
      correctionCounts({ tx, tenantId: TENANT_A }),
    );
    expect(counts).toEqual({ open: 3, overdueFacts: 1 });
    const summary = await withTenant(dash(), TENANT_A, (tx) => reviewSummary(ctx(TENANT_A)(tx)));
    expect(summary).toMatchObject({ openCorrections: 3, overdueFacts: 1 });

    const facts = await withTenant(dash(), TENANT_A, (tx) =>
      correctionFacts({ tx, tenantId: TENANT_A }, [s]),
    );
    expect(facts.get(s.id)).toEqual([
      expect.objectContaining({
        id: f.id,
        label: 'Ondeh ondeh',
        status: 'approved',
        overdue: true,
      }),
    ]);

    await withTenant(dash(), TENANT_A, (tx) => dismissCorrection(ctx(TENANT_A)(tx), a.id));
    await withTenant(dash(), TENANT_A, (tx) => dismissCorrection(ctx(TENANT_A)(tx), s.id));
    const closed = await list(TENANT_A, { status: 'closed' });
    expect(closed.corrections.map((c) => c.id)).toEqual([s.id, a.id]);
  });

  it('pages 20 at a time with a cursor', async () => {
    for (let i = 0; i < 21; i++)
      await propose(TENANT_B, { kind: 'add_faq', question: `Q${i}?`, answer: 'A.' });
    const first = await list(TENANT_B, { status: 'open' });
    expect(first.corrections).toHaveLength(20);
    const second = await list(TENANT_B, { status: 'open', cursor: first.nextCursor! });
    expect(second.corrections).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(first.corrections.map((c) => c.id)).not.toContain(second.corrections[0]!.id);
  });
});

describe('accept, edit and close (AC-3, AC-4)', () => {
  it('an open item leaves the fact alone; accepting applies it', async () => {
    const f = await create(TENANT_A, product('Kueh lapis', 2000));
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: f.id,
      patch: { value: { name: 'Kueh lapis', priceCents: 2200, currency: 'SGD' } },
    });
    expect((await visitorSearch(TENANT_A, 'Kueh lapis')).find((v) => v.id === f.id)).toMatchObject({
      version: 1,
      value: { priceCents: 2000 },
    });
    const done = await accept(TENANT_A, c);
    expect(done).toMatchObject({ status: 'accepted', acceptedChange: null, decidedBy: USER });
    expect(await fact(TENANT_A, f.id)).toMatchObject({ version: 2, value: { priceCents: 2200 } });
    await expect(accept(TENANT_A, c)).rejects.toThrow(CorrectionClosedError);
  });

  it('edit then accept applies the edited value and keeps the proposal', async () => {
    const f = await create(TENANT_A, product('Kaya puff', 300));
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: f.id,
      patch: { value: { name: 'Kaya puff', priceCents: 350, currency: 'SGD' } },
    });
    const done = await accept(TENANT_A, c, {
      kind: 'edit_fact',
      patch: { value: { name: 'Kaya puff', priceCents: 380, currency: 'SGD' } },
    });
    expect(done.status).toBe('edited_and_accepted');
    expect(done.change).toMatchObject({ after: { value: { priceCents: 350 } } });
    expect(done.acceptedChange).toMatchObject({
      kind: 'edit_fact',
      factVersion: 1,
      after: { value: { priceCents: 380 } },
    });
    expect(await fact(TENANT_A, f.id)).toMatchObject({ version: 2, value: { priceCents: 380 } });
  });

  it('an edit equal to the proposal is a plain accept; a FAQ edit replaces the text', async () => {
    const f = await create(TENANT_A, product('Curry puff', 250));
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: f.id,
      patch: { value: { name: 'Curry puff', priceCents: 280, currency: 'SGD' } },
    });
    const same = await accept(TENANT_A, c, {
      kind: 'edit_fact',
      patch: { value: { name: 'Curry puff', priceCents: 280, currency: 'SGD' } },
    });
    expect(same).toMatchObject({ status: 'accepted', acceptedChange: null });

    const q = await propose(TENANT_A, { kind: 'add_faq', question: 'Parking?', answer: 'Yes' });
    const edited = await accept(TENANT_A, q, {
      kind: 'add_faq',
      question: 'Is there parking?',
      answer: 'Yes, at the back.',
    });
    expect(edited.acceptedChange).toEqual({
      kind: 'add_faq',
      question: 'Is there parking?',
      answer: 'Yes, at the back.',
    });
    const found = await visitorSearch(TENANT_A, 'Is there parking?');
    expect(found.some((v) => (v.value as { answer?: string }).answer === 'Yes, at the back.')).toBe(
      true,
    );
  });

  it('rejects invalid, no-op and mismatched edits, and an hours edit', async () => {
    const f = await create(TENANT_A, product('Pineapple tart', 1800));
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: f.id,
      patch: { value: { name: 'Pineapple tart', priceCents: 1900, currency: 'SGD' } },
    });
    await expect(
      accept(TENANT_A, c, {
        kind: 'edit_fact',
        patch: { value: { name: 'Pineapple tart', priceCents: 1800, currency: 'SGD' } },
      }),
    ).rejects.toThrow(InvalidCorrectionError);
    await expect(
      accept(TENANT_A, c, {
        kind: 'edit_fact',
        patch: { validity: { validFrom: null, validUntil: new Date('2027-01-01') } },
      }),
    ).rejects.toThrow(InvalidCorrectionError);
    await expect(
      accept(TENANT_A, c, { kind: 'add_faq', question: 'x?', answer: 'y' }),
    ).rejects.toThrow(NotEditableError);
    const h = await propose(TENANT_A, {
      kind: 'edit_hours',
      profileVersion: 0,
      before: {},
      after: { mon: [{ open: '09:00', close: '17:00' }] },
    });
    await expect(
      accept(TENANT_A, h, { kind: 'add_faq', question: 'x?', answer: 'y' }),
    ).rejects.toThrow(NotEditableError);
    expect(await fact(TENANT_A, f.id)).toMatchObject({ version: 1 });
  });

  it('a fact changed since gives stale; closing changes nothing', async () => {
    const f = await create(TENANT_A, product('Kueh salat', 1500));
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: f.id,
      patch: { value: { name: 'Kueh salat', priceCents: 1600, currency: 'SGD' } },
    });
    await owner.query(`update facts set version = version + 1 where id = $1`, [f.id]);
    await expect(
      accept(TENANT_A, c, {
        kind: 'edit_fact',
        patch: { value: { name: 'Kueh salat', priceCents: 1700, currency: 'SGD' } },
      }),
    ).rejects.toThrow(CorrectionStaleError);
    await expect(accept(TENANT_A, c)).rejects.toThrow(CorrectionStaleError);
    const closed = await withTenant(dash(), TENANT_A, (tx) =>
      dismissCorrection(ctx(TENANT_A)(tx), c.id),
    );
    expect(closed.status).toBe('dismissed');
    expect(await fact(TENANT_A, f.id)).toMatchObject({ version: 2, value: { priceCents: 1500 } });
  });
});

describe('re-confirm a stale fact (AC-5, AC-6)', () => {
  it('makes a new version with the same value, stays searchable, and the next scan skips it', async () => {
    const f = await create(TENANT_A, product('Huat kueh', 900));
    await age(f.id, 7);
    const s = await staleItem(TENANT_A, f.id);
    expect(s.change).toMatchObject({ kind: 'reconfirm', factId: f.id, factVersion: 1 });
    const done = await accept(TENANT_A, s);
    expect(done.status).toBe('accepted');
    const after = await fact(TENANT_A, f.id);
    expect(after).toMatchObject({ version: 2, status: 'approved', value: { priceCents: 900 } });
    const { rows } = await owner.query(
      `select (select count(*) from fact_versions where fact_id = $1)::int as versions,
              (select fact_version from kb_chunks where fact_id = $1) as chunk,
              (select last_confirmed_at > now() - interval '1 minute' from facts where id = $1) as fresh`,
      [f.id],
    );
    expect(rows[0]).toEqual({ versions: 2, chunk: 2, fresh: true });
    expect((await visitorSearch(TENANT_A, 'Huat kueh')).find((v) => v.id === f.id)).toMatchObject({
      version: 2,
    });
    expect(
      (await runStaleScan(tdb.zone('outbox'))).find((r) => r.tenantId === TENANT_A),
    ).toBeUndefined();
  });

  it('an edited re-confirm becomes a fact edit; a fact changed since is stale', async () => {
    const f = await create(TENANT_A, product('Kuih bahulu', 600));
    await age(f.id, 7);
    const s = await staleItem(TENANT_A, f.id);
    const done = await accept(TENANT_A, s, {
      kind: 'edit_fact',
      patch: { value: { name: 'Kuih bahulu', priceCents: 650, currency: 'SGD' } },
    });
    expect(done).toMatchObject({
      status: 'edited_and_accepted',
      acceptedChange: { kind: 'edit_fact', after: { value: { priceCents: 650 } } },
    });
    expect(await fact(TENANT_A, f.id)).toMatchObject({ version: 2, value: { priceCents: 650 } });

    const g = await create(TENANT_A, product('Kuih seri muka', 700));
    await age(g.id, 7);
    const t = await staleItem(TENANT_A, g.id);
    await owner.query(`update facts set status = 'disabled' where id = $1`, [g.id]);
    await expect(accept(TENANT_A, t)).rejects.toThrow(CorrectionStaleError);
  });

  it('audit payloads carry codes and IDs only', async () => {
    const { rows } = await owner.query(
      `select payload::text as p from audit_entries where event_type in ('correction.accepted', 'correction.edited', 'correction.dismissed', 'fact.reconfirmed')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.p).not.toMatch(/kueh|kuih|puff|tart|parking|ondeh/i);
  });
});
