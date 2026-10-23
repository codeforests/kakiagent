import { createHash } from 'node:crypto';
import { withTenant } from '@kaki/db';
import { fakeEmbed } from '@kaki/llm-gateway';
import { startTestDatabase, TENANT_A, TENANT_B, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createFileSource,
  createWebsiteSource,
  FileLimitError,
  NotRetryableError,
  quarantineKey,
  retryable,
  listReviewFacts,
  dashboardKb,
  deleteSource,
  getSource,
  InvalidStateError,
  listFacts,
  listSources,
  parseWebsite,
  retrySource,
  SourceExistsError,
  searchVisitorFacts,
  SourceNotFoundError,
  VersionConflictError,
  visitorKb,
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

/** The fact IDs a visitor turn's retrieval would see for the tenant (ADR-010). */
const visitorHits = (tenantId: string) =>
  withTenant(tdb.zone('visitor'), tenantId, async (tx) =>
    (
      await searchVisitorFacts(
        visitorKb(tx, tenantId, '00000000-0000-4000-8000-0000000000c1'),
        fakeEmbed('open on sunday'),
        { k: 50, maxDistance: 2 },
      )
    ).map((h) => h.id),
  );

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

    // The approved fact is what a visitor turn retrieves before the delete (AC-9).
    const approved = facts[1]!;
    expect(await visitorHits(TENANT_A)).toContain(approved);

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
    expect(await visitorHits(TENANT_A)).not.toContain(approved);
    expect((await auditOf(s.id)).at(-1)).toEqual({
      event_type: 'kb_source.deleted',
      actor_ref: USER,
      payload: { kind: 'website', facts: 2 },
    });
  });
});

describe('file sources (FEAT-015 §5.6, §5.7)', () => {
  const UPLOAD = '00000000-0000-4000-8000-0000000000f1';
  const addFile = (
    tenantId: string,
    uploadId = UPLOAD,
    fileLimit = 50,
    fileName = 'Price list.pdf',
  ) =>
    dash(tenantId, (ctx) =>
      createFileSource(ctx, { uploadId, fileName, sizeBytes: 2048 }, { fileLimit }),
    );
  const jobs = async (id: string) =>
    (
      await owner.query(`select payload from outbox where group_key = $1 order by created_at`, [id])
    ).rows.map((r) => r.payload);

  it('adds an upload as a source queued at scan, audited without its name, with the scan job', async () => {
    const s = await addFile(TENANT_A);
    expect(s).toMatchObject({
      kind: 'file',
      status: 'queued',
      stage: 'scan',
      name: 'Price list.pdf',
      uploadKey: `uploads/${TENANT_A}/${UPLOAD}`,
      fileSize: 2048,
      fileKey: null,
      url: null,
      domain: null,
      attestedAt: null,
    });
    expect(quarantineKey(TENANT_A, UPLOAD)).toBe(s.uploadKey);
    expect(await auditOf(s.id)).toEqual([
      {
        event_type: 'kb_source.created',
        actor_ref: USER,
        payload: { kind: 'file', ext: 'pdf', sizeBytes: 2048 },
      },
    ]);
    expect(JSON.stringify(await auditOf(s.id))).not.toContain('Price list');
    expect(await jobs(s.id)).toEqual([
      { tenantId: TENANT_A, sourceId: s.id, attempt: 1, stage: 'scan' },
    ]);
    // The upload is the tenant's own: tenant B's key for the same ID is a different object.
    const b = await addFile(TENANT_B);
    expect(b.uploadKey).toBe(`uploads/${TENANT_B}/${UPLOAD}`);
    await expect(dash(TENANT_A, (ctx) => getSource(ctx, b.id))).rejects.toBeInstanceOf(
      SourceNotFoundError,
    );
  });

  it('refuses a second source for the same upload and a file over the plan limit', async () => {
    const s = await addFile(TENANT_A);
    await expect(addFile(TENANT_A)).rejects.toMatchObject({ sourceId: s.id });
    await expect(addFile(TENANT_A)).rejects.toBeInstanceOf(SourceExistsError);
    await addFile(TENANT_A, '00000000-0000-4000-8000-0000000000f2', 2);
    await expect(
      addFile(TENANT_A, '00000000-0000-4000-8000-0000000000f3', 2),
    ).rejects.toBeInstanceOf(FileLimitError);
    // Websites don't count towards the file limit.
    await add(TENANT_A);
    expect(
      (await dash(TENANT_A, (ctx) => listSources(ctx))).filter((x) => x.kind === 'file'),
    ).toHaveLength(2);
  });

  it('retries a file from parse with a stored copy, from scan without, and never after a rejection', async () => {
    const s = await addFile(TENANT_A);
    const failAs = (failure: string, fileKey: string | null) =>
      owner.query(
        `update kb_sources set status = 'failed', stage = null, failure = $2, file_key = $3,
           version = version + 1 where id = $1 returning version`,
        [s.id, failure, fileKey],
      );
    for (const failure of [
      'upload_missing',
      'too_large',
      'unsupported_type',
      'encrypted',
      'malware',
      'unreadable',
      'no_text',
    ]) {
      const v = (await failAs(failure, null)).rows[0].version;
      expect(retryable({ kind: 'file', status: 'failed', failure: failure as never })).toBe(false);
      await expect(dash(TENANT_A, (ctx) => retrySource(ctx, s.id, v))).rejects.toBeInstanceOf(
        NotRetryableError,
      );
    }
    let v = (await failAs('scan_unavailable', null)).rows[0].version;
    expect(await dash(TENANT_A, (ctx) => retrySource(ctx, s.id, v))).toMatchObject({
      status: 'queued',
      stage: 'scan',
      attempt: 2,
    });
    v = (await failAs('extraction_unavailable', `files/${TENANT_A}/${s.id}`)).rows[0].version;
    expect(await dash(TENANT_A, (ctx) => retrySource(ctx, s.id, v))).toMatchObject({
      status: 'queued',
      stage: 'parse',
      attempt: 3,
    });
    expect((await jobs(s.id)).map((j) => j.stage)).toEqual(['scan', 'scan', 'parse']);
    // A website's failure is always retryable.
    expect(retryable({ kind: 'website', status: 'failed', failure: 'no_pages' })).toBe(true);
  });

  it('deletes a file source and writes the purge job for its objects; review names it by file name', async () => {
    const s = await addFile(TENANT_A);
    await owner.query(
      `update kb_sources set status = 'ready', stage = null, file_key = $2, finished_at = now() where id = $1`,
      [s.id, `files/${TENANT_A}/${s.id}`],
    );
    await owner.query(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, content)
       values ($1, $2, 1, 0, 'page/1', 'included', 'Q: Open on Sunday? A: Yes')`,
      [TENANT_A, s.id],
    );
    await owner.query(
      `insert into facts (tenant_id, type, status, value, gst_treatment, source, source_id, confidence, provenance)
       values ($1, 'faq', 'needs_review', '{"question":"Open on Sunday?","answer":"Yes"}', null, 'file', $2, 0.9,
         '{"url":"page/1","title":null,"quote":"Open on Sunday?","start":3,"end":18}')`,
      [TENANT_A, s.id],
    );
    const review = await dash(TENANT_A, (ctx) => listReviewFacts(ctx, { sourceId: s.id }));
    expect(review.facts[0]).toMatchObject({
      sourceName: 'Price list.pdf',
      passage: { quote: 'Open on Sunday?' },
    });
    expect(await dash(TENANT_A, (ctx) => deleteSource(ctx, s.id, 1))).toBe(1);
    expect((await jobs(s.id)).at(-1)).toEqual({
      tenantId: TENANT_A,
      sourceId: s.id,
      stage: 'purge',
      keys: { quarantine: `uploads/${TENANT_A}/${UPLOAD}`, sources: `files/${TENANT_A}/${s.id}` },
    });
    expect((await auditOf(s.id)).at(-1)).toMatchObject({
      event_type: 'kb_source.deleted',
      payload: { kind: 'file', facts: 1 },
    });
  });
});
