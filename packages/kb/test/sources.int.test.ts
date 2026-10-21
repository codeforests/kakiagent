import { createHash } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createWebsiteSource,
  dashboardKb,
  deleteSource,
  getSource,
  InvalidStateError,
  listFacts,
  listSources,
  parseWebsite,
  retrySource,
  SourceExistsError,
  SourceNotFoundError,
  VersionConflictError,
} from '../src/index.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = 'user-owner-1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
afterEach(async () => {
  await owner.query(`delete from kb_staged_facts`);
  await owner.query(`delete from kb_source_pages`);
  await owner.query(
    `delete from kb_chunks where fact_id in (select id from facts where source_id is not null)`,
  );
  await owner.query(
    `delete from fact_versions where fact_id in (select id from facts where source_id is not null)`,
  );
  await owner.query(`delete from facts where source_id is not null`);
  await owner.query(`delete from kb_sources`);
});

const dash = <T>(tenantId: string, fn: (ctx: ReturnType<typeof dashboardKb>) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), tenantId, (tx) => fn(dashboardKb(tx, tenantId, USER)));

const add = (tenantId: string, url = 'https://www.kakibakery.sg/', subs: string[] = []) =>
  dash(tenantId, (ctx) => createWebsiteSource(ctx, parseWebsite(url, subs), { pageLimit: 100 }));

async function auditOf(id: string) {
  return (
    await owner.query(
      `select event_type, actor_ref, payload from audit_entries
       where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [id],
    )
  ).rows;
}

describe('website sources (FEAT-012 §5.5)', () => {
  it('records the attestation before the source, adds the origins and writes the crawl job', async () => {
    const before = (
      await owner.query(`select allowed_origins from tenants where id = $1`, [TENANT_B])
    ).rows[0].allowed_origins as string[];
    try {
      const s = await add(TENANT_B, 'https://www.kakibakery.sg/', ['shop.kakibakery.sg']);
      expect(s).toMatchObject({
        status: 'queued',
        stage: 'crawl',
        attempt: 1,
        version: 1,
        domain: 'kakibakery.sg',
        subdomains: ['shop.kakibakery.sg'],
        pageLimit: 100,
        attestedBy: USER,
      });
      expect(s.attestedAt).toBeInstanceOf(Date);
      expect(await auditOf(s.id)).toEqual([
        {
          event_type: 'kb_source.attested',
          actor_ref: USER,
          payload: {
            kind: 'website',
            domainHash: createHash('sha256').update('kakibakery.sg').digest('hex'),
            subdomains: 1,
          },
        },
        {
          event_type: 'kb_source.created',
          actor_ref: USER,
          payload: { kind: 'website', pageLimit: 100 },
        },
      ]);
      const origins = (
        await owner.query(`select allowed_origins from tenants where id = $1`, [TENANT_B])
      ).rows[0].allowed_origins as string[];
      expect(origins).toEqual(
        [
          ...new Set([
            ...before,
            'https://kakibakery.sg',
            'https://www.kakibakery.sg',
            'https://shop.kakibakery.sg',
          ]),
        ].sort(),
      );
      const jobs = await owner.query(
        `select topic, group_key, payload from outbox where group_key = $1`,
        [s.id],
      );
      expect(jobs.rows).toEqual([
        {
          topic: 'ingest',
          group_key: s.id,
          payload: { tenantId: TENANT_B, sourceId: s.id, attempt: 1, stage: 'crawl' },
        },
      ]);
      await expect(add(TENANT_B, 'kakibakery.sg')).rejects.toBeInstanceOf(SourceExistsError);
    } finally {
      await owner.query(`update tenants set allowed_origins = $2 where id = $1`, [
        TENANT_B,
        before,
      ]);
    }
  });

  it("lists and gets the tenant's own sources only, pages of the current attempt in order", async () => {
    const a = await add(TENANT_A, 'https://a-bakery.sg/');
    const b = await add(TENANT_B, 'https://b-bakery.sg/');
    for (const [attempt, seq, url] of [
      [1, 1, 'https://b-bakery.sg/z'],
      [1, 0, 'https://b-bakery.sg/'],
    ] as const)
      await owner.query(
        `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, reason, http_status)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          TENANT_B,
          b.id,
          attempt,
          seq,
          url,
          seq ? 'failed' : 'included',
          seq ? 'http_error' : null,
          seq ? 404 : 200,
        ],
      );
    expect((await dash(TENANT_B, listSources)).map((s) => s.id)).toEqual([b.id]);
    const got = await dash(TENANT_B, (ctx) => getSource(ctx, b.id));
    expect(got.pages).toEqual([
      expect.objectContaining({ url: 'https://b-bakery.sg/', status: 'included', reason: null }),
      expect.objectContaining({
        url: 'https://b-bakery.sg/z',
        status: 'failed',
        reason: 'http_error',
        httpStatus: 404,
      }),
    ]);
    await expect(dash(TENANT_B, (ctx) => getSource(ctx, a.id))).rejects.toBeInstanceOf(
      SourceNotFoundError,
    );
  });

  it('retries only a failed source, with its version, as a new attempt', async () => {
    const s = await add(TENANT_A);
    await expect(dash(TENANT_A, (ctx) => retrySource(ctx, s.id, 1))).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    await owner.query(
      `update kb_sources set status = 'failed', stage = null, failure = 'no_pages', pages_found = 3 where id = $1`,
      [s.id],
    );
    await owner.query(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, reason)
       values ($1, $2, 1, 0, 'https://kakibakery.sg/', 'excluded', 'robots')`,
      [TENANT_A, s.id],
    );
    await expect(dash(TENANT_A, (ctx) => retrySource(ctx, s.id, 2))).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    const r = await dash(TENANT_A, (ctx) => retrySource(ctx, s.id, 1));
    expect(r).toMatchObject({
      status: 'queued',
      stage: 'crawl',
      failure: null,
      attempt: 2,
      version: 2,
      pagesFound: 0,
    });
    expect(
      (await owner.query(`select 1 from kb_source_pages where source_id = $1`, [s.id])).rowCount,
    ).toBe(0);
    expect((await auditOf(s.id)).at(-1)).toEqual({
      event_type: 'kb_source.retried',
      actor_ref: USER,
      payload: { attempt: 2 },
    });
    const jobs = await owner.query(
      `select payload from outbox where group_key = $1 order by created_at`,
      [s.id],
    );
    expect(jobs.rows.at(-1).payload).toMatchObject({ attempt: 2, stage: 'crawl' });
  });

  it('deletes a source with its pages, staging and facts of any status, unless it is processing', async () => {
    const s = await add(TENANT_A);
    const page = await owner.query<{ id: string }>(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status) values ($1, $2, 1, 0, 'https://kakibakery.sg/', 'included') returning id`,
      [TENANT_A, s.id],
    );
    await owner.query(
      `insert into kb_staged_facts (tenant_id, source_id, attempt, page_id, type, value, quote, quote_start, quote_end, confidence, dedupe_key)
       values ($1, $2, 1, $3, 'faq', '{"question":"q","answer":"a"}', 'q a', 0, 3, 0.9, 'faq:q')`,
      [TENANT_A, s.id, page.rows[0]!.id],
    );
    const facts: string[] = [];
    for (const status of ['needs_review', 'approved']) {
      const f = await owner.query<{ id: string }>(
        `insert into facts (tenant_id, type, status, value, gst_treatment, source, source_id, confidence, provenance)
         values ($1, 'faq', $2, '{"question":"Open on Sunday?","answer":"Yes"}', null, 'website', $3, 0.9,
           '{"url":"https://kakibakery.sg/","title":null,"quote":"Open on Sunday? Yes","start":0,"end":19}') returning id`,
        [TENANT_A, status, s.id],
      );
      facts.push(f.rows[0]!.id);
      await owner.query(
        `insert into fact_versions (tenant_id, fact_id, version, status, value) values ($1, $2, 1, $3, '{}')`,
        [TENANT_A, f.rows[0]!.id, status],
      );
      await owner.query(
        `insert into kb_chunks (tenant_id, fact_id, fact_version, content, embedding) values ($1, $2, 1, 'x', array_fill(0.1, array[1024])::vector)`,
        [TENANT_A, f.rows[0]!.id],
      );
    }
    const listed = await dash(TENANT_A, (ctx) => listFacts(ctx, { sourceId: s.id }));
    expect(listed.facts.map((f) => f.id).sort()).toEqual([...facts].sort());
    expect(listed.facts[0]).toMatchObject({
      sourceId: s.id,
      confidence: expect.closeTo(0.9, 5),
      provenance: { quote: 'Open on Sunday? Yes' },
    });

    await owner.query(`update kb_sources set status = 'processing' where id = $1`, [s.id]);
    await expect(dash(TENANT_A, (ctx) => deleteSource(ctx, s.id, 1))).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    await owner.query(`update kb_sources set status = 'ready', stage = null where id = $1`, [s.id]);
    await expect(dash(TENANT_A, (ctx) => deleteSource(ctx, s.id, 9))).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    await expect(dash(TENANT_B, (ctx) => deleteSource(ctx, s.id, 1))).rejects.toBeInstanceOf(
      SourceNotFoundError,
    );
    expect(await dash(TENANT_A, (ctx) => deleteSource(ctx, s.id, 1))).toBe(2);
    for (const [table, col] of [
      ['kb_sources', 'id'],
      ['kb_source_pages', 'source_id'],
      ['kb_staged_facts', 'source_id'],
      ['facts', 'source_id'],
    ])
      expect(
        (await owner.query(`select 1 from ${table} where ${col} = $1`, [s.id])).rowCount,
        table,
      ).toBe(0);
    for (const table of ['kb_chunks', 'fact_versions'])
      expect(
        (await owner.query(`select 1 from ${table} where fact_id = any($1)`, [facts])).rowCount,
        table,
      ).toBe(0);
    expect((await auditOf(s.id)).at(-1)).toEqual({
      event_type: 'kb_source.deleted',
      actor_ref: USER,
      payload: { kind: 'website', facts: 2 },
    });
  });
});
