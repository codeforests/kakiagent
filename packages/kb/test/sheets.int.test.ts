import { sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  type LlmGateway,
} from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BadMappingError,
  confirmImport,
  createFileSource,
  InvalidStateError,
  prepareChunk,
  previewImport,
  updateFact,
  VersionConflictError,
  dashboardKb,
  deleteSource,
  fakeExtractScript,
  NotRetryableError,
  quarantineKey,
  retrySource,
  runIngestJob,
  sourcesKey,
  type Bucket,
  type FileDeps,
  type FileStore,
  type IngestJobBody,
} from '../src/index.js';
import { makeXlsx } from './fixtures/xlsx.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = 'user-owner-1';
const CONFIRMER = 'user-admin-2';
let uploads = 0;

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
  await owner.query(`delete from kb_chunks`);
  await owner.query(`delete from fact_versions`);
  await owner.query(`delete from facts`);
  await owner.query(`delete from kb_sources`);
  await owner.query(`delete from outbox`);
  await owner.query(`delete from business_profiles where tenant_id = $1`, [TENANT_A]);
});

function memFiles() {
  const buckets: Record<Bucket, Map<string, Uint8Array>> = {
    quarantine: new Map(),
    sources: new Map(),
  };
  const store: FileStore = {
    async head(b, key) {
      const o = buckets[b].get(key);
      return o ? { size: o.length } : null;
    },
    async get(b, key) {
      const o = buckets[b].get(key);
      if (!o) throw new Error(`no ${b}/${key}`);
      return o;
    },
    async copyToSources(from, to) {
      buckets.sources.set(to, (await store.get('quarantine', from)).slice());
    },
    async delete(b, key) {
      buckets[b].delete(key);
    },
  };
  const never = vi.fn(async () => {
    throw new Error('a spreadsheet is never OCR’d');
  });
  const deps: FileDeps = {
    store,
    scanner: { scan: vi.fn(async () => ({ infected: false as const })) },
    ocr: { recognize: never },
    rasterizer: { render: never },
    limits: { sheetRows: 50 },
  };
  return { deps, buckets };
}

const fakeLlm = () =>
  createGateway(defaultRegistry('fake'), [createFakeProvider((req) => fakeExtractScript(req))]);
/** A gateway whose embedder is down (the promote stage's transient failure). */
function embedDown(): LlmGateway {
  const llm = fakeLlm();
  return Object.assign(Object.create(llm) as LlmGateway, {
    embed: async () => {
      throw new Error('embedder down');
    },
  });
}

const PRICE_LIST = makeXlsx([
  ['Kaki Bakery price list'],
  null,
  ['Item code', 'Product', 'Size', 'Price (incl. GST)', 'Stock'],
  ['PC-01', 'Pandan chiffon', 'whole', '38', '12'],
  ['PC-02', 'Ondeh ondeh cake', '1 kg', '42.5', ''],
  ['', '', '', '', ''],
  ['PC-03', 'Kaya roll', '', '', '4'],
  ['PC-04', 'Durian cake', '1 kg', 'TBC', ''],
  ['PC-05', 'Pineapple tarts', 'box of 20', '28', '-1'],
  ['PC-01', 'Pandan chiffon', 'whole', '38', '12'],
  ['PC-06', 'Kueh lapis', 'slice', 'RM 12', ''],
]);

async function addSheet(
  files: ReturnType<typeof memFiles>,
  bytes: Uint8Array,
  fileName = 'prices.xlsx',
) {
  const uploadId = `00000000-0000-4000-8000-${String(++uploads).padStart(12, '0')}`;
  files.buckets.quarantine.set(quarantineKey(TENANT_A, uploadId), bytes);
  return withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    createFileSource(
      dashboardKb(tx, TENANT_A, USER),
      { uploadId, fileName, sizeBytes: bytes.length, kind: 'spreadsheet' },
      { fileLimit: 50 },
    ),
  );
}

async function drain(
  s: { id: string },
  files: ReturnType<typeof memFiles>,
  opts: { llm?: LlmGateway; receiveCount?: number } = {},
) {
  const outcomes = [];
  for (let i = 0; i < 10; i++) {
    const { rows } = await owner.query(
      `update outbox set dispatched_at = now() where id = (
         select id from outbox where group_key = $1 and dispatched_at is null order by created_at limit 1)
       returning payload`,
      [s.id],
    );
    if (!rows[0]) break;
    const job = rows[0].payload as IngestJobBody;
    const run = () =>
      runIngestJob(
        {
          zdb: tdb.zone('ingest'),
          llm: opts.llm ?? fakeLlm(),
          fetcher: {
            robots: async () => null,
            page: async () => ({ ok: false, reason: 'load_error' }),
          },
          files: files.deps,
        },
        job,
        opts.receiveCount ?? 1,
      );
    try {
      outcomes.push(await run());
    } catch (err) {
      outcomes.push({ thrown: (err as Error).message });
      break;
    }
  }
  return outcomes;
}

/** What `confirmImport` (T6) does, by hand: the mapping, stage `import`, its job. */
async function confirmByHand(id: string, columns: object, gst = 'inclusive') {
  const mapping = { columns, gst, confirmedBy: CONFIRMER, confirmedAt: '2026-10-23T02:00:00.000Z' };
  const { rows } = await owner.query(
    `update kb_sources set mapping = $2, stage = 'import', status = 'queued', version = version + 1
     where id = $1 returning tenant_id, attempt`,
    [id, JSON.stringify(mapping)],
  );
  await owner.query(
    `insert into outbox (tenant_id, topic, group_key, payload) values ($1, 'ingest', $2, $3)`,
    [
      rows[0].tenant_id,
      id,
      JSON.stringify({
        tenantId: rows[0].tenant_id,
        sourceId: id,
        attempt: rows[0].attempt,
        stage: 'import',
      }),
    ],
  );
}

const MAPPING = { sku: 0, product: 1, unit: 2, price: 3, stock: 4 };
const sourceRow = async (id: string) =>
  (await owner.query(`select * from kb_sources where id = $1`, [id])).rows[0];
const rowsOf = async (id: string) =>
  (
    await owner.query(
      `select url, status, reason, content, cells from kb_source_pages where source_id = $1 order by seq`,
      [id],
    )
  ).rows;
const factsOf = async (id: string) =>
  (
    await owner.query(
      `select id, status, source, confidence, provenance, value, gst_treatment, created_by from facts
       where source_id = $1 order by value->>'name'`,
      [id],
    )
  ).rows;
const pendingJobs = async (id: string) =>
  (await owner.query(`select 1 from outbox where group_key = $1 and dispatched_at is null`, [id]))
    .rowCount;
const auditOf = async (subject: string) =>
  (
    await owner.query(
      `select event_type, actor_ref as actor_id, payload from audit_entries where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [subject],
    )
  ).rows;
const dash = <T>(fn: (ctx: ReturnType<typeof dashboardKb>) => Promise<T>) =>
  withTenant(tdb.zone('dashboard'), TENANT_A, (tx) => fn(dashboardKb(tx, TENANT_A, USER)));

describe('spreadsheet stages (KB-03; FEAT-016 §5.2–§5.8)', () => {
  it('parses an XLSX to `map`: rows with cells, the layout and the suggestion, and no job', async () => {
    const files = memFiles();
    const s = await addSheet(files, PRICE_LIST);
    expect(await drain(s, files)).toEqual([
      { result: 'next', stage: 'parse', type: 'xlsx' },
      { result: 'waiting', stage: 'map', rows: 8 },
    ]);
    const src = await sourceRow(s.id);
    expect(src).toMatchObject({
      kind: 'spreadsheet',
      status: 'queued',
      stage: 'map',
      file_type: 'xlsx',
      pages_found: 8,
    });
    expect(await pendingJobs(s.id)).toBe(0);
    expect(src.sheet).toMatchObject({
      name: 'Prices',
      headerRow: 3,
      rows: 8,
      rowsSkipped: 0,
      suggested: { columns: MAPPING, gst: 'inclusive' },
    });
    expect(src.sheet.columns[1]).toEqual({
      index: 1,
      header: 'Product',
      samples: ['Pandan chiffon', 'Ondeh ondeh cake', 'Kaya roll'],
    });
    const rows = await rowsOf(s.id);
    expect(rows.map((r) => r.url)).toEqual([
      'row/4',
      'row/5',
      'row/6',
      'row/7',
      'row/8',
      'row/9',
      'row/10',
      'row/11',
    ]);
    expect(rows[0]).toEqual({
      url: 'row/4',
      status: 'included',
      reason: null,
      content: 'PC-01 | Pandan chiffon | whole | 38 | 12',
      cells: ['PC-01', 'Pandan chiffon', 'whole', '38', '12'],
    });
    expect((await auditOf(s.id)).map((a) => a.event_type)).toEqual([
      'kb_source.created',
      'kb_source.scanned',
      'kb_source.parsed',
    ]);
    // A spreadsheet is never OCR'd.
    expect(files.deps.ocr.recognize).not.toHaveBeenCalled();
  });

  it('reads a CSV, and counts rows over the limit without storing them', async () => {
    const files = memFiles();
    const csv = [
      'Service;Price',
      '"Cut; wash";25',
      ...Array.from({ length: 60 }, (_, i) => `Colour ${i};${80 + i}`),
    ].join('\r\n');
    const s = await addSheet(files, new TextEncoder().encode(`﻿${csv}`), 'services.csv');
    await drain(s, files);
    const src = await sourceRow(s.id);
    expect(src).toMatchObject({
      stage: 'map',
      file_type: 'csv',
      pages_found: 50,
      pages_skipped: 11,
    });
    expect(src.sheet).toMatchObject({
      name: null,
      rows: 50,
      rowsSkipped: 11,
      suggested: { columns: { service: 0, price: 1 } },
    });
    expect((await rowsOf(s.id))[0]!.cells).toEqual(['Cut; wash', '25']);
  });

  it('fails no_rows for a header without data, and that is not retryable', async () => {
    const files = memFiles();
    const s = await addSheet(files, makeXlsx([['Product', 'Price']]));
    expect((await drain(s, files)).at(-1)).toEqual({ result: 'failed', failure: 'no_rows' });
    const failed = await sourceRow(s.id);
    await expect(dash((ctx) => retrySource(ctx, s.id, failed.version))).rejects.toThrow(
      NotRetryableError,
    );
  });

  it('imports the confirmed rows as approved facts, with row results, provenance and audit (AC-5)', async () => {
    const files = memFiles();
    const s = await addSheet(files, PRICE_LIST);
    await drain(s, files);
    await confirmByHand(s.id, MAPPING);
    expect(await drain(s, files)).toEqual([
      { result: 'next', stage: 'promote' },
      { result: 'ready', facts: 2 },
    ]);
    expect((await rowsOf(s.id)).map((r) => [r.url, r.status, r.reason])).toEqual([
      ['row/4', 'included', null],
      ['row/5', 'included', null],
      ['row/6', 'excluded', 'empty_row'],
      ['row/7', 'failed', 'no_price'],
      ['row/8', 'failed', 'bad_price'],
      ['row/9', 'failed', 'bad_stock'],
      ['row/10', 'excluded', 'duplicate'],
      ['row/11', 'failed', 'not_sgd'],
    ]);
    const src = await sourceRow(s.id);
    expect(src).toMatchObject({
      status: 'ready',
      stage: null,
      facts_count: 2,
      pages_included: 2,
      pages_failed: 4,
      pages_excluded: 2,
    });
    const facts = await factsOf(s.id);
    expect(facts).toHaveLength(2);
    expect(facts[1]).toMatchObject({
      status: 'approved',
      source: 'spreadsheet',
      confidence: 1,
      gst_treatment: 'inclusive',
      created_by: CONFIRMER,
      value: {
        name: 'Pandan chiffon',
        priceCents: 3800,
        currency: 'SGD',
        unit: 'whole',
        sku: 'PC-01',
        stock: 12,
        stockAsOf: '2026-10-23',
      },
      provenance: {
        url: 'row/4',
        title: null,
        quote: 'PC-01 | Pandan chiffon | whole | 38 | 12',
        start: 0,
        end: 40,
      },
    });
    expect(facts[0]!.value).toEqual({
      name: 'Ondeh ondeh cake',
      priceCents: 4250,
      currency: 'SGD',
      unit: '1 kg',
      sku: 'PC-02',
    });
    // Versions and chunks with each fact; the staging is gone.
    for (const f of facts) {
      expect(
        (await owner.query(`select status from fact_versions where fact_id = $1`, [f.id])).rows,
      ).toEqual([{ status: 'approved' }]);
      expect(
        (await owner.query(`select 1 from kb_chunks where fact_id = $1`, [f.id])).rowCount,
      ).toBe(1);
      expect(await auditOf(f.id)).toEqual([
        {
          event_type: 'fact.approved',
          actor_id: CONFIRMER,
          payload: { version: 1, mode: 'import', source: s.id },
        },
      ]);
    }
    expect((await owner.query(`select 1 from kb_staged_facts`)).rowCount).toBe(0);
    expect((await auditOf(s.id)).at(-1)).toMatchObject({
      event_type: 'kb_source.promoted',
      payload: { facts: 2, approved: 2 },
    });
    // Approved and GST inclusive: in the visitor view.
    const visible = await withTenant(tdb.zone('visitor'), TENANT_A, async (tx) =>
      (
        await tx.execute<{ name: string }>(sql`select value->>'name' as name from visitor_facts`)
      ).rows.map((r) => r.name),
    );
    expect(visible).toEqual(expect.arrayContaining(['Ondeh ondeh cake', 'Pandan chiffon']));
  });

  it('writes a row that disagrees with a live fact conflicted and flags the fact; drops one that agrees (KB-06)', async () => {
    const files = memFiles();
    const manual = async (name: string, cents: number) =>
      (
        await owner.query(
          `insert into facts (tenant_id, type, status, value, gst_treatment, source)
           values ($1, 'product', 'approved', $2, 'inclusive', 'manual') returning id`,
          [TENANT_A, JSON.stringify({ name, priceCents: cents, currency: 'SGD', unit: 'whole' })],
        )
      ).rows[0].id as string;
    const live = await manual('Pandan chiffon', 3600);
    const same = await manual('Kaya cake', 2000);
    const s = await addSheet(
      files,
      makeXlsx([
        ['Product', 'Size', 'Price'],
        ['Pandan chiffon', 'whole', '38'],
        ['Kaya cake', 'whole', '20'],
        ['Ondeh cake', 'whole', '30'],
        ['Ondeh cake', 'whole', '32'],
      ]),
    );
    await drain(s, files);
    await confirmByHand(s.id, { product: 0, unit: 1, price: 2 });
    await drain(s, files);
    const facts = await factsOf(s.id);
    expect(facts.map((f) => [f.value.name, f.value.priceCents, f.status])).toEqual([
      ['Ondeh cake', 3000, 'conflicted'],
      ['Ondeh cake', 3200, 'conflicted'],
      ['Pandan chiffon', 3800, 'conflicted'],
    ]);
    expect(
      (await owner.query(`select status from facts where id = $1`, [live])).rows[0].status,
    ).toBe('conflicted');
    expect(
      (await owner.query(`select status from facts where id = $1`, [same])).rows[0].status,
    ).toBe('approved');
  });

  it('fails extraction_unavailable when embeddings fail, and retry keeps the mapping to end ready (AC-8)', async () => {
    const files = memFiles();
    const s = await addSheet(files, PRICE_LIST);
    await drain(s, files);
    await confirmByHand(s.id, MAPPING);
    const out = await drain(s, files, { llm: embedDown(), receiveCount: 5 });
    expect(out.at(-1)).toEqual({ result: 'failed', failure: 'extraction_unavailable' });
    expect(await factsOf(s.id)).toEqual([]);
    const failed = await sourceRow(s.id);
    expect(failed.mapping).not.toBeNull();
    await dash((ctx) => retrySource(ctx, s.id, failed.version));
    expect(await drain(s, files)).toEqual([
      { result: 'next', stage: 'import' },
      { result: 'next', stage: 'promote' },
      { result: 'ready', facts: 2 },
    ]);
    expect(await sourceRow(s.id)).toMatchObject({ status: 'ready', attempt: 2 });
  });

  it('fails no_valid_rows when nothing imports; retry returns to the mapping without it (UC-10 5a)', async () => {
    const files = memFiles();
    const s = await addSheet(files, PRICE_LIST);
    await drain(s, files);
    // Price mapped to the size column: no row has a price.
    await confirmByHand(s.id, { product: 1, price: 2 });
    expect(await drain(s, files)).toEqual([{ result: 'failed', failure: 'no_valid_rows' }]);
    expect(await rowsOf(s.id).then((r) => r.every((x) => x.status === 'included'))).toBe(true);
    const failed = await sourceRow(s.id);
    await dash((ctx) => retrySource(ctx, s.id, failed.version));
    expect(await drain(s, files)).toEqual([{ result: 'waiting', stage: 'map', rows: 8 }]);
    expect(await sourceRow(s.id)).toMatchObject({
      status: 'queued',
      stage: 'map',
      mapping: null,
      attempt: 2,
    });
    await confirmByHand(s.id, MAPPING);
    expect((await drain(s, files)).at(-1)).toEqual({ result: 'ready', facts: 2 });
  });

  it('ignores a stale or duplicate import job', async () => {
    const files = memFiles();
    const s = await addSheet(files, PRICE_LIST);
    await drain(s, files);
    const job = { tenantId: TENANT_A, sourceId: s.id, attempt: 1, stage: 'import' } as const;
    const deps = {
      zdb: tdb.zone('ingest'),
      llm: fakeLlm(),
      fetcher: {
        robots: async () => null,
        page: async () => ({ ok: false as const, reason: 'load_error' as const }),
      },
      files: files.deps,
    };
    // Waiting at `map`: an import job (or a `map` one) does nothing.
    expect(await runIngestJob(deps, job, 1)).toEqual({ result: 'stale' });
    expect(await runIngestJob(deps, { ...job, stage: 'map' } as never, 1)).toEqual({
      result: 'stale',
    });
    await confirmByHand(s.id, MAPPING);
    await drain(s, files);
    expect(await runIngestJob(deps, job, 1)).toEqual({ result: 'stale' });
    expect(await factsOf(s.id)).toHaveLength(2);
  });

  it('deletes a spreadsheet waiting at map, with its rows, and purges its object', async () => {
    const files = memFiles();
    const s = await addSheet(files, PRICE_LIST);
    await drain(s, files);
    const waiting = await sourceRow(s.id);
    expect(files.buckets.sources.has(sourcesKey(TENANT_A, s.id))).toBe(true);
    await dash((ctx) => deleteSource(ctx, s.id, waiting.version));
    expect(await sourceRow(s.id)).toBeUndefined();
    expect(await rowsOf(s.id)).toEqual([]);
    expect(await drain(s, files)).toEqual([{ result: 'purged' }]);
    expect(files.buckets.sources.size).toBe(0);
  });
});

describe('preview and confirm (FEAT-016 §5.6; AC-4, AC-6, AC-8)', () => {
  async function mapped(bytes = PRICE_LIST) {
    const files = memFiles();
    const s = await addSheet(files, bytes);
    await drain(s, files);
    return { files, s, src: await sourceRow(s.id) };
  }
  const outboxCount = async () => (await owner.query(`select 1 from outbox`)).rowCount;
  const auditCount = async () => (await owner.query(`select 1 from audit_entries`)).rowCount;

  it('previews the rows: counts, reasons and samples, and writes nothing', async () => {
    const { s, src } = await mapped();
    const before = [await outboxCount(), await auditCount()];
    const p = await dash((ctx) => previewImport(ctx, s.id, { mapping: MAPPING, gst: 'inclusive' }));
    expect(p).toMatchObject({
      rows: 8,
      importable: 2,
      rejected: 4,
      empty: 1,
      duplicates: 1,
      existing: 0,
      conflicts: 0,
      gstReview: 0,
    });
    expect(p.rejects.map((r) => [r.row, r.reason])).toEqual([
      [7, 'no_price'],
      [8, 'bad_price'],
      [9, 'bad_stock'],
      [11, 'not_sgd'],
    ]);
    expect(p.rejects[1]!.cells).toEqual(['PC-04', 'Durian cake', '1 kg', 'TBC', '']);
    expect(p.sample[0]).toEqual({
      row: 4,
      cells: ['PC-01', 'Pandan chiffon', 'whole', '38', '12'],
      reason: null,
      fact: { name: 'Pandan chiffon', price: '38.00', unit: 'whole', sku: 'PC-01', stock: 12 },
      conflict: false,
    });
    expect([await outboxCount(), await auditCount()]).toEqual(before);
    expect((await sourceRow(s.id)).version).toBe(src.version);
    // Without the stock column, the negative stock no longer rejects its row.
    const { stock: _stock, ...noStock } = MAPPING;
    const q = await dash((ctx) => previewImport(ctx, s.id, { mapping: noStock, gst: 'inclusive' }));
    expect([q.importable, q.rejected]).toEqual([3, 3]);
  });

  it('refuses a mapping without a name or price column, or with one column twice', async () => {
    const { s } = await mapped();
    for (const mapping of [
      { price: 3 },
      { product: 1 },
      { product: 1, price: 1 },
      { product: 1, price: 9 },
    ])
      await expect(
        dash((ctx) => previewImport(ctx, s.id, { mapping, gst: 'inclusive' })),
      ).rejects.toThrow(BadMappingError);
  });

  it('counts rows the KB already has and rows that would conflict', async () => {
    const { s } = await mapped();
    for (const [name, unit, cents] of [
      ['Pandan chiffon', 'whole', 3800],
      ['Ondeh ondeh cake', '1 kg', 4000],
    ] as const)
      await owner.query(
        `insert into facts (tenant_id, type, status, value, gst_treatment, source)
         values ($1, 'product', 'approved', $2, 'inclusive', 'manual')`,
        [TENANT_A, JSON.stringify({ name, unit, priceCents: cents, currency: 'SGD' })],
      );
    const p = await dash((ctx) => previewImport(ctx, s.id, { mapping: MAPPING, gst: 'inclusive' }));
    expect([p.importable, p.existing, p.conflicts]).toEqual([2, 1, 1]);
    expect(p.sample.map((r) => [r.row, r.conflict])).toEqual([
      [4, false],
      [5, true],
    ]);
  });

  it('holds back GST-unknown prices of a GST-registered business, not of others (KB-15, UC-10 4a)', async () => {
    const visible = () =>
      withTenant(tdb.zone('visitor'), TENANT_A, async (tx) =>
        (
          await tx.execute<{ name: string }>(sql`select value->>'name' as name from visitor_facts`)
        ).rows.map((r) => r.name),
      );
    await owner.query(
      `insert into business_profiles (tenant_id, gst_registered) values ($1, true)`,
      [TENANT_A],
    );
    const { files, s, src } = await mapped();
    const choice = { mapping: MAPPING, gst: 'unknown' as const };
    expect((await dash((ctx) => previewImport(ctx, s.id, choice))).gstReview).toBe(2);
    await dash((ctx) => confirmImport(ctx, s.id, { ...choice, version: src.version }));
    await drain(s, files);
    expect((await factsOf(s.id)).map((f) => [f.status, f.gst_treatment])).toEqual([
      ['approved', 'unknown'],
      ['approved', 'unknown'],
    ]);
    expect(await visible()).not.toContain('Pandan chiffon');
    await owner.query(`update business_profiles set gst_registered = false where tenant_id = $1`, [
      TENANT_A,
    ]);
    expect(await visible()).toEqual(expect.arrayContaining(['Pandan chiffon', 'Ondeh ondeh cake']));
    const other = await mapped(
      makeXlsx([
        ['Product', 'Price'],
        ['Kopi', '1.80'],
      ]),
    );
    expect(
      (
        await dash((ctx) =>
          previewImport(ctx, other.s.id, { mapping: { product: 0, price: 1 }, gst: 'unknown' }),
        )
      ).gstReview,
    ).toBe(0);
  });

  it('confirms: the mapping, an audit entry and one import job; the import then runs to ready', async () => {
    const { files, s, src } = await mapped();
    const confirmed = await dash((ctx) =>
      confirmImport(ctx, s.id, { mapping: MAPPING, gst: 'inclusive', version: src.version }),
    );
    expect(confirmed).toMatchObject({
      status: 'queued',
      stage: 'import',
      version: src.version + 1,
    });
    expect(confirmed.mapping).toMatchObject({
      columns: MAPPING,
      gst: 'inclusive',
      confirmedBy: USER,
    });
    expect(await pendingJobs(s.id)).toBe(1);
    expect((await auditOf(s.id)).at(-1)).toEqual({
      event_type: 'kb_source.import_confirmed',
      actor_id: USER,
      payload: { rows: 8, importable: 2, rejected: 4, gst: 'inclusive' },
    });
    // Confirmed once: neither a second confirm nor a preview applies.
    await expect(
      dash((ctx) =>
        confirmImport(ctx, s.id, {
          mapping: MAPPING,
          gst: 'inclusive',
          version: confirmed.version,
        }),
      ),
    ).rejects.toThrow(InvalidStateError);
    await expect(
      dash((ctx) => previewImport(ctx, s.id, { mapping: MAPPING, gst: 'inclusive' })),
    ).rejects.toThrow(InvalidStateError);
    expect((await drain(s, files)).at(-1)).toEqual({ result: 'ready', facts: 2 });
    expect((await factsOf(s.id)).every((f) => f.created_by === USER)).toBe(true);
  });

  it('refuses a stale version, and fails no_valid_rows when no row is valid (UC-10 5a)', async () => {
    const { s, src } = await mapped();
    await expect(
      dash((ctx) =>
        confirmImport(ctx, s.id, { mapping: MAPPING, gst: 'inclusive', version: src.version - 1 }),
      ),
    ).rejects.toThrow(VersionConflictError);
    const failed = await dash((ctx) =>
      confirmImport(ctx, s.id, {
        mapping: { product: 1, price: 2 },
        gst: 'inclusive',
        version: src.version,
      }),
    );
    expect(failed).toMatchObject({
      status: 'failed',
      failure: 'no_valid_rows',
      stage: null,
      mapping: null,
    });
    expect(await pendingJobs(s.id)).toBe(0);
    expect((await auditOf(s.id)).at(-1)?.payload).toMatchObject({ importable: 0 });
  });

  it('keeps an imported SKU and stock when the fact is edited (D8)', async () => {
    const { files, s, src } = await mapped();
    await dash((ctx) =>
      confirmImport(ctx, s.id, { mapping: MAPPING, gst: 'inclusive', version: src.version }),
    );
    await drain(s, files);
    const fact = (await factsOf(s.id)).find((f) => f.value.name === 'Pandan chiffon')!;
    const value = {
      name: 'Pandan chiffon cake',
      priceCents: 3900,
      currency: 'SGD' as const,
      unit: 'whole',
    };
    const llm = fakeLlm();
    const chunk = await prepareChunk(llm, TENANT_A, {
      type: 'product',
      value,
      gstTreatment: 'inclusive',
    });
    const updated = await dash((ctx) => updateFact(ctx, fact.id, { version: 1, value }, chunk));
    expect(updated.value).toEqual({ ...value, sku: 'PC-01', stock: 12, stockAsOf: '2026-10-23' });
  });
});
