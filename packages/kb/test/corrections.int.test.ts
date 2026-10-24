/**
 * Coaching search and the corrections queue (AGT-17, KB-16, KB-18; FEAT-027 §5.1, AC-3,
 * AC-5, AC-6, AC-7 kb half).
 */
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  coachingKb,
  confirmCorrection,
  correctionFactInput,
  CorrectionClosedError,
  CorrectionNotFoundError,
  CorrectionStaleError,
  createFact,
  dashboardKb,
  dismissCorrection,
  getCorrection,
  getFact,
  InvalidCorrectionError,
  prepareChunk,
  proposeCorrection,
  searchCoachingFacts,
  searchVisitorFacts,
  updateFact,
  visitorKb,
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

const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};

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
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

const dash = () => tdb.zone('dashboard');

async function create(tenantId: string, input: FactInput) {
  const chunk = await prepareChunk(llm, tenantId, input);
  return withTenant(dash(), tenantId, (tx) =>
    createFact(dashboardKb(tx, tenantId, USER), input, chunk),
  );
}

async function embed(tenantId: string, q: string) {
  const { vectors } = await llm.embed({ texts: [q], purpose: 'query', meta: { tenantId } });
  return vectors[0]!;
}

async function coachSearch(tenantId: string, q: string, includeUnreviewed: boolean) {
  const e = await embed(tenantId, q);
  return withTenant(dash(), tenantId, (tx) =>
    searchCoachingFacts(coachingKb(tx, tenantId, USER, SESSION), e, { includeUnreviewed }),
  );
}

async function visitorSearch(tenantId: string, q: string) {
  const e = await embed(tenantId, q);
  return withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    searchVisitorFacts(visitorKb(tx, tenantId, CONV), e),
  );
}

function propose(tenantId: string, proposal: ProposalInput) {
  return withTenant(dash(), tenantId, (tx) =>
    proposeCorrection(coachingKb(tx, tenantId, USER, SESSION), { proposal }),
  );
}

async function confirm(tenantId: string, c: CorrectionRecord) {
  const input = correctionFactInput(c);
  const chunk = input ? await prepareChunk(llm, tenantId, input) : undefined;
  return withTenant(dash(), tenantId, (tx) =>
    confirmCorrection(dashboardKb(tx, tenantId, USER), c.id, chunk ? { chunk } : {}),
  );
}

async function setStatus(id: string, status: string) {
  await owner.query(`update facts set status = $2 where id = $1`, [id, status]);
}

async function auditPayloads(subjectId: string) {
  return (
    await owner.query(
      `select event_type as action, payload from audit_entries where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [subjectId],
    )
  ).rows as { action: string; payload: Record<string, unknown> }[];
}

describe('searchCoachingFacts (AC-3)', () => {
  it('excludes unreviewed facts unless asked, and never returns rejected, conflicted or disabled ones', async () => {
    const tart = await create(TENANT_A, {
      type: 'product',
      value: { name: 'Lemon tart', priceCents: 900, currency: 'SGD' },
      gstTreatment: 'inclusive',
    });
    await setStatus(tart.id, 'needs_review');
    expect((await coachSearch(TENANT_A, 'Lemon tart', false)).map((f) => f.id)).not.toContain(
      tart.id,
    );
    const included = await coachSearch(TENANT_A, 'Lemon tart', true);
    expect(included.find((f) => f.id === tart.id)).toMatchObject({ status: 'needs_review' });
    for (const status of ['rejected', 'conflicted', 'disabled']) {
      await setStatus(tart.id, status);
      expect((await coachSearch(TENANT_A, 'Lemon tart', true)).map((f) => f.id)).not.toContain(
        tart.id,
      );
    }
  });

  it("returns only the tenant's own facts", async () => {
    const own = await create(TENANT_B, {
      type: 'product',
      value: { name: 'Kaya toast', priceCents: 300, currency: 'SGD' },
      gstTreatment: 'inclusive',
    });
    const found = await coachSearch(TENANT_A, 'Kaya toast', true);
    expect(found.map((f) => f.id)).not.toContain(own.id);
  });
});

describe('proposeCorrection (AC-5)', () => {
  it('stores an open coaching correction with before and after, and leaves the fact alone', async () => {
    const fudge = await create(TENANT_A, FUDGE);
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: fudge.id,
      patch: { value: { ...FUDGE.value, priceCents: 5800 } as typeof FUDGE.value },
    });
    expect(c).toMatchObject({
      status: 'open',
      sourceType: 'coaching',
      coachingSessionId: SESSION,
      factRefs: [fudge.id],
      change: {
        kind: 'edit_fact',
        factId: fudge.id,
        factVersion: 1,
        label: 'Chocolate fudge cake',
        before: { value: { priceCents: 5500 } },
        after: { value: { priceCents: 5800 } },
      },
    });
    const row = (await owner.query(`select proposed_by from corrections where id = $1`, [c.id]))
      .rows[0];
    expect(row.proposed_by).toBe('coaching');
    const still = await visitorSearch(TENANT_A, 'Chocolate fudge cake');
    expect(still.find((f) => f.id === fudge.id)?.value).toMatchObject({ priceCents: 5500 });
    const [entry] = await auditPayloads(c.id);
    expect(entry).toEqual({
      action: 'correction.proposed',
      payload: { kind: 'edit_fact', sourceType: 'coaching', factIds: [fudge.id] },
    });
  });

  it('rejects an unknown fact, a patch that breaks the rules, and a change that changes nothing', async () => {
    const fudge = await create(TENANT_A, FUDGE);
    await expect(
      propose(TENANT_A, {
        kind: 'edit_fact',
        factId: '00000000-0000-4000-8000-00000000dead',
        patch: { value: FUDGE.value },
      }),
    ).rejects.toThrow(InvalidCorrectionError);
    await expect(
      propose(TENANT_A, {
        kind: 'edit_fact',
        factId: fudge.id,
        patch: { validity: { validUntil: new Date() } },
      }),
    ).rejects.toThrow(InvalidCorrectionError);
    await expect(
      propose(TENANT_A, { kind: 'edit_fact', factId: fudge.id, patch: { value: FUDGE.value } }),
    ).rejects.toThrow(InvalidCorrectionError);
    await expect(
      propose(TENANT_A, { kind: 'add_faq', question: ' ', answer: 'x' }),
    ).rejects.toThrow(InvalidCorrectionError);
    // Tenant B can't propose a change to tenant A's fact: RLS hides it.
    await expect(
      propose(TENANT_B, {
        kind: 'edit_fact',
        factId: fudge.id,
        patch: { value: { ...FUDGE.value, priceCents: 1 } as typeof FUDGE.value },
      }),
    ).rejects.toThrow(InvalidCorrectionError);
  });
});

describe('confirm and dismiss (AC-6, AC-7)', () => {
  it('confirming makes a new approved version and chunk that visitors see on commit', async () => {
    const fudge = await create(TENANT_A, {
      ...FUDGE,
      value: { ...FUDGE.value, name: 'Black forest cake' },
    } as FactInput);
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: fudge.id,
      patch: {
        value: {
          ...FUDGE.value,
          name: 'Black forest cake',
          priceCents: 6100,
        } as typeof FUDGE.value,
      },
    });
    const done = await confirm(TENANT_A, c);
    expect(done).toMatchObject({ status: 'accepted' });
    expect(done.decidedAt).toBeInstanceOf(Date);
    const fact = await withTenant(dash(), TENANT_A, (tx) =>
      getFact(dashboardKb(tx, TENANT_A, USER), fudge.id),
    );
    expect(fact).toMatchObject({ status: 'approved', version: 2, value: { priceCents: 6100 } });
    const seen = await visitorSearch(TENANT_A, 'Black forest cake');
    expect(seen.find((f) => f.id === fudge.id)).toMatchObject({
      version: 2,
      value: { priceCents: 6100 },
    });
    const actions = (await auditPayloads(c.id)).map((e) => e.action);
    expect(actions).toEqual(['correction.proposed', 'correction.accepted']);
    await expect(confirm(TENANT_A, c)).rejects.toThrow(CorrectionClosedError);
  });

  it('a new FAQ is created approved, from coaching', async () => {
    const c = await propose(TENANT_A, {
      kind: 'add_faq',
      question: 'Do you deliver to Sentosa?',
      answer: 'Yes, for orders above $80.',
    });
    await confirm(TENANT_A, c);
    const seen = await visitorSearch(TENANT_A, 'Do you deliver to Sentosa?');
    expect(seen[0]).toMatchObject({
      type: 'faq',
      value: { question: 'Do you deliver to Sentosa?' },
    });
    const src = (await owner.query(`select source from facts where id = $1`, [seen[0]!.id]))
      .rows[0];
    expect(src.source).toBe('coaching');
  });

  it('a fact changed since the proposal makes the confirm stale, and nothing changes', async () => {
    const fudge = await create(TENANT_A, {
      ...FUDGE,
      value: { ...FUDGE.value, name: 'Pandan chiffon' },
    } as FactInput);
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: fudge.id,
      patch: {
        value: { ...FUDGE.value, name: 'Pandan chiffon', priceCents: 4000 } as typeof FUDGE.value,
      },
    });
    const next = { ...FUDGE.value, name: 'Pandan chiffon', priceCents: 4200 } as typeof FUDGE.value;
    const chunk = await prepareChunk(llm, TENANT_A, { ...FUDGE, value: next } as FactInput);
    await withTenant(dash(), TENANT_A, (tx) =>
      updateFact(dashboardKb(tx, TENANT_A, USER), fudge.id, { version: 1, value: next }, chunk),
    );
    await expect(confirm(TENANT_A, c)).rejects.toThrow(CorrectionStaleError);
    const after = await withTenant(dash(), TENANT_A, (tx) =>
      getCorrection(dashboardKb(tx, TENANT_A, USER), c.id),
    );
    expect(after.status).toBe('open');
    const fact = await withTenant(dash(), TENANT_A, (tx) =>
      getFact(dashboardKb(tx, TENANT_A, USER), fudge.id),
    );
    expect(fact.value).toMatchObject({ priceCents: 4200 });
  });

  it('dismissing closes the item with no fact change; deciding twice is closed', async () => {
    const fudge = await create(TENANT_A, {
      ...FUDGE,
      value: { ...FUDGE.value, name: 'Ondeh ondeh cake' },
    } as FactInput);
    const c = await propose(TENANT_A, {
      kind: 'edit_fact',
      factId: fudge.id,
      patch: {
        value: { ...FUDGE.value, name: 'Ondeh ondeh cake', priceCents: 1 } as typeof FUDGE.value,
      },
    });
    const d = await withTenant(dash(), TENANT_A, (tx) =>
      dismissCorrection(dashboardKb(tx, TENANT_A, USER), c.id),
    );
    expect(d.status).toBe('dismissed');
    await expect(
      withTenant(dash(), TENANT_A, (tx) =>
        dismissCorrection(dashboardKb(tx, TENANT_A, USER), c.id),
      ),
    ).rejects.toThrow(CorrectionClosedError);
    await expect(confirm(TENANT_A, d)).rejects.toThrow(CorrectionClosedError);
    const fact = await withTenant(dash(), TENANT_A, (tx) =>
      getFact(dashboardKb(tx, TENANT_A, USER), fudge.id),
    );
    expect(fact).toMatchObject({ version: 1, value: { priceCents: 5500 } });
    expect((await auditPayloads(c.id)).map((e) => e.action)).toEqual([
      'correction.proposed',
      'correction.dismissed',
    ]);
    // Tenant B can't see or decide it.
    await expect(
      withTenant(dash(), TENANT_B, (tx) => getCorrection(dashboardKb(tx, TENANT_B, USER), c.id)),
    ).rejects.toThrow(CorrectionNotFoundError);
  });

  it('audit payloads carry codes and IDs only', async () => {
    const rows = (
      await owner.query(
        `select payload::text as p from audit_entries where event_type like 'correction.%'`,
      )
    ).rows as { p: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.p).not.toMatch(/fudge|forest|Sentosa|chiffon|ondeh/i);
    }
  });
});
