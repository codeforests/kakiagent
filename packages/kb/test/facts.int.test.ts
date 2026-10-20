import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import { gatewayFromConfig } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFact,
  dashboardKb,
  FactNotFoundError,
  getFact,
  InvalidStateError,
  listFacts,
  mergePatch,
  prepareChunk,
  searchVisitorFacts,
  updateFact,
  VersionConflictError,
  visitorKb,
  type FactInput,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const llm = gatewayFromConfig({ provider: 'fake' });
const USER = 'user-owner-1';
const CONV = '00000000-0000-4000-8000-0000000000c1';

const FUDGE: FactInput = {
  type: 'product',
  value: { name: 'Chocolate fudge cake', priceCents: 5500, currency: 'SGD', unit: '1 kg' },
  gstTreatment: 'inclusive',
};
const EGGLESS: FactInput = {
  type: 'faq',
  value: { question: 'Do you have eggless cakes?', answer: 'Yes, on request, 3 days ahead.' },
  gstTreatment: null,
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

async function create(tenantId: string, input: FactInput) {
  const chunk = await prepareChunk(llm, tenantId, input);
  return withTenant(tdb.zone('dashboard'), tenantId, (tx) =>
    createFact(dashboardKb(tx, tenantId, USER), input, chunk),
  );
}

async function edit(tenantId: string, id: string, patch: Parameters<typeof updateFact>[2]) {
  const dash = tdb.zone('dashboard');
  const current = await withTenant(dash, tenantId, (tx) =>
    getFact(dashboardKb(tx, tenantId, USER), id),
  );
  const chunk = await prepareChunk(llm, tenantId, mergePatch(current, patch));
  return withTenant(dash, tenantId, (tx) =>
    updateFact(dashboardKb(tx, tenantId, USER), id, patch, chunk),
  );
}

async function search(tenantId: string, query: string) {
  const { vectors } = await llm.embed({ texts: [query], purpose: 'query', meta: { tenantId } });
  return withTenant(tdb.zone('visitor'), tenantId, (tx) =>
    searchVisitorFacts(visitorKb(tx, tenantId, CONV), vectors[0]!),
  );
}

describe('fact repository (KB-07, ADR-010)', () => {
  it('creates an approved fact with version 1, its version row, chunk and audit entry', async () => {
    const fact = await create(TENANT_A, FUDGE);
    expect(fact).toMatchObject({
      status: 'approved',
      version: 1,
      type: 'product',
      source: 'manual',
    });
    const versions = await owner.query(
      `select version, status from fact_versions where fact_id = $1`,
      [fact.id],
    );
    expect(versions.rows).toEqual([{ version: 1, status: 'approved' }]);
    const chunks = await owner.query(`select fact_version from kb_chunks where fact_id = $1`, [
      fact.id,
    ]);
    expect(chunks.rows).toEqual([{ fact_version: 1 }]);
    const audit = await owner.query(
      `select event_type as action, actor_ref as actor_id from audit_entries where split_part(subject_refs[1], ':', 2) = $1`,
      [fact.id],
    );
    expect(audit.rows).toEqual([{ action: 'fact.created', actor_id: USER }]);
  });

  it('edits bump the version, re-embed and keep a version row each', async () => {
    const fact = await create(TENANT_A, FUDGE);
    const edited = await edit(TENANT_A, fact.id, {
      version: 1,
      value: { ...FUDGE.value, priceCents: 5800 } as never,
    });
    expect(edited).toMatchObject({ version: 2, status: 'approved' });
    const rows = await owner.query(
      `select version, value->>'priceCents' as cents from fact_versions where fact_id = $1 order by version`,
      [fact.id],
    );
    expect(rows.rows).toEqual([
      { version: 1, cents: '5500' },
      { version: 2, cents: '5800' },
    ]);
    const chunk = await owner.query(`select fact_version from kb_chunks where fact_id = $1`, [
      fact.id,
    ]);
    expect(chunk.rows).toEqual([{ fact_version: 2 }]);
    const audit = await owner.query(
      `select event_type, actor_ref, payload from audit_entries
       where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [fact.id],
    );
    expect(audit.rows.at(-1)).toEqual({
      event_type: 'fact.updated',
      actor_ref: USER,
      payload: { version: 2 },
    });
  });

  it('rejects a stale version (409 version_conflict)', async () => {
    const fact = await create(TENANT_A, EGGLESS);
    await edit(TENANT_A, fact.id, {
      version: 1,
      value: { ...EGGLESS.value, answer: 'Yes.' } as never,
    });
    await expect(
      edit(TENANT_A, fact.id, { version: 1, value: { ...EGGLESS.value, answer: 'No.' } as never }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('disables and re-enables, with audit entries, and refuses rejected facts', async () => {
    const fact = await create(TENANT_A, FUDGE);
    const off = await edit(TENANT_A, fact.id, { version: 1, status: 'disabled' });
    expect(off.status).toBe('disabled');
    const on = await edit(TENANT_A, fact.id, { version: 2, status: 'approved' });
    expect(on.status).toBe('approved');
    const audit = await owner.query(
      `select event_type as action from audit_entries where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [fact.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'fact.created',
      'fact.disabled',
      'fact.enabled',
    ]);
    await owner.query(`update facts set status = 'rejected' where id = $1`, [fact.id]);
    await expect(
      edit(TENANT_A, fact.id, { version: 3, status: 'approved' }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('a hand edit approves a fact waiting for review (KB-07); approving without an edit is refused', async () => {
    const fact = await create(TENANT_A, EGGLESS);
    await owner.query(`update facts set status = 'needs_review' where id = $1`, [fact.id]);
    await expect(
      edit(TENANT_A, fact.id, { version: 1, status: 'approved' }),
    ).rejects.toBeInstanceOf(InvalidStateError);
    const edited = await edit(TENANT_A, fact.id, {
      version: 1,
      value: { ...EGGLESS.value, answer: 'Yes, with 3 days notice.' } as never,
    });
    expect(edited.status).toBe('approved');
  });

  it("lists and filters, and never shows another tenant's facts", async () => {
    await create(TENANT_B, {
      ...FUDGE,
      value: { ...FUDGE.value, name: 'Tenant B cake' },
    } as FactInput);
    const dash = tdb.zone('dashboard');
    const { facts: list } = await withTenant(dash, TENANT_A, (tx) =>
      listFacts(dashboardKb(tx, TENANT_A, USER)),
    );
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((f) => f.type === 'product' && f.value.name === 'Tenant B cake')).toBe(false);
    const { facts: q } = await withTenant(dash, TENANT_A, (tx) =>
      listFacts(dashboardKb(tx, TENANT_A, USER), { q: 'EGGLESS' }),
    );
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((f) => f.type === 'faq')).toBe(true);
    const { facts: disabled } = await withTenant(dash, TENANT_A, (tx) =>
      listFacts(dashboardKb(tx, TENANT_A, USER), { status: 'disabled' }),
    );
    expect(disabled.every((f) => f.status === 'disabled')).toBe(true);
    const bFact = (
      await withTenant(dash, TENANT_B, (tx) => listFacts(dashboardKb(tx, TENANT_B, USER)))
    ).facts[0]!;
    await expect(
      withTenant(dash, TENANT_A, (tx) => getFact(dashboardKb(tx, TENANT_A, USER), bFact.id)),
    ).rejects.toBeInstanceOf(FactNotFoundError);
  });
});

describe('visitor search (AGT-16, ADR-005)', () => {
  it('finds approved facts of the tenant only, best match first', async () => {
    const results = await search(TENANT_A, 'got eggless cake or not? how much ah');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.type !== 'product' || r.value.name !== 'Tenant B cake')).toBe(
      true,
    );
    expect(results[0]!.type).toBe('faq');
  });

  it('never returns a disabled fact, and returns an edited one at once (AC-9)', async () => {
    const fact = await create(TENANT_A, {
      ...FUDGE,
      value: { name: 'Durian pengat', priceCents: 1200, currency: 'SGD' },
    } as FactInput);
    expect((await search(TENANT_A, 'durian pengat')).map((r) => r.id)).toContain(fact.id);
    await edit(TENANT_A, fact.id, { version: 1, status: 'disabled' });
    expect((await search(TENANT_A, 'durian pengat')).map((r) => r.id)).not.toContain(fact.id);
    await edit(TENANT_A, fact.id, { version: 2, status: 'approved' });
    await edit(TENANT_A, fact.id, {
      version: 3,
      value: { name: 'Durian pengat', priceCents: 1500, currency: 'SGD' } as never,
    });
    const hit = (await search(TENANT_A, 'durian pengat')).find((r) => r.id === fact.id);
    expect(hit?.type === 'product' && hit.value.priceCents).toBe(1500);
  });

  it('returns nothing for an unrelated question', async () => {
    expect(await search(TENANT_A, 'zzzz qqqq')).toEqual([]);
  });
});
