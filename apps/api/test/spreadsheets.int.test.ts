import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import {
  fakeExtractScript,
  quarantineKey,
  runIngestJob,
  type Bucket,
  type FileDeps,
  type FileStore,
  type IngestJobBody,
} from '@kaki/kb';
import { createFakeProvider, createGateway, defaultRegistry } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { fakeSigner, sessionCookie, testApp } from './support.js';

/**
 * Spreadsheet sources through the API (FEAT-016 T9; AC-1, AC-4, AC-6, AC-8, AC-9): the
 * spreadsheet body of `POST /kb/sources`, a spreadsheet's layout and rows in the detail,
 * `POST /:id/preview` and `POST /:id/import`. The worker's stages run in the test, on an
 * in-memory file store, so a source reaches `map` as it does in the worker.
 */
let tdb: TestDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: pg.Client;
let asA: string;
let asB: string;
let asAgent: string;
const signer = fakeSigner();
const FILE_LIMIT = 3;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await testApp(tdb, { uploads: signer, env: { FILE_LIMIT: String(FILE_LIMIT) } });
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const staff = await owner.query<{ id: string }>(
    `insert into users (email) values ('staff@kaki-bakery.test') returning id`,
  );
  await owner.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'agent')`, [
    TENANT_A,
    staff.rows[0]!.id,
  ]);
  asA = await sessionCookie(tdb, 'owner@kaki-bakery.test');
  asB = await sessionCookie(tdb, 'owner@second-tenant.test');
  asAgent = await sessionCookie(tdb, 'staff@kaki-bakery.test');
});
afterAll(async () => {
  await app?.close();
  await owner?.end();
  await tdb?.stop();
});
afterEach(async () => {
  for (const t of ['kb_staged_facts', 'kb_source_pages', 'kb_chunks', 'fact_versions', 'facts'])
    await owner.query(`delete from ${t}`);
  await owner.query(`delete from kb_sources`);
  await owner.query(`delete from outbox where topic = 'ingest'`);
  signer.signed.length = 0;
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: who }, ...(payload ? { payload } : {}) });
const count = async (q: string, args: unknown[] = []) =>
  Number((await owner.query(q, args)).rows[0].n);

const enc = (s: string) => new TextEncoder().encode(s);
/** Rows 2..6: two importable, a "TBC" price, an empty row, a repeat of row 2. */
const PRICES_CSV = enc(
  'Product,Price,Stock\r\nPandan chiffon,38,12\r\nKaya roll,TBC,\r\n,,\r\nOndeh ondeh,$12.50,3\r\nPandan chiffon,38,12\r\n',
);
const NO_PRICES_CSV = enc('Name,Price\nKaya roll,TBC\nOndeh ondeh,ask us\n');
const MAPPING = { product: 0, price: 1, stock: 2 };

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
const never = async () => {
  throw new Error('a spreadsheet is never OCR’d');
};
const files: FileDeps = {
  store,
  scanner: { scan: async () => ({ infected: false }) },
  ocr: { recognize: never },
  rasterizer: { render: never },
};
const llm = createGateway(defaultRegistry('fake'), [
  createFakeProvider((req) => fakeExtractScript(req)),
]);

/** Runs the source's queued jobs as the ingest-worker would, until none is left. */
async function drain(id: string) {
  for (let i = 0; i < 10; i++) {
    const { rows } = await owner.query(
      `update outbox set dispatched_at = now() where id = (
         select id from outbox where group_key = $1 and dispatched_at is null order by created_at limit 1)
       returning payload`,
      [id],
    );
    if (!rows[0]) return;
    await runIngestJob(
      {
        zdb: tdb.zone('ingest'),
        llm,
        fetcher: {
          robots: async () => null,
          page: async () => ({ ok: false, reason: 'load_error' }),
        },
        files,
      },
      rows[0].payload as IngestJobBody,
      1,
    );
  }
}

async function addSheet(bytes = PRICES_CSV, fileName = 'Prices.csv') {
  const ticket = await call('POST', '/api/v1/kb/uploads', asA, {
    fileName,
    sizeBytes: bytes.length,
  });
  expect(ticket.statusCode).toBe(201);
  const { uploadId } = ticket.json();
  buckets.quarantine.set(quarantineKey(TENANT_A, uploadId), bytes);
  const res = await call('POST', '/api/v1/kb/sources', asA, {
    kind: 'spreadsheet',
    uploadId,
    fileName,
    sizeBytes: bytes.length,
  });
  expect(res.statusCode).toBe(201);
  return res.json().source;
}
/** A spreadsheet scanned and parsed, waiting for its mapping at `map`. */
async function mapped(bytes = PRICES_CSV) {
  const source = await addSheet(bytes);
  await drain(source.id);
  const res = await call('GET', `/api/v1/kb/sources/${source.id}`, asA);
  expect(res.json().source).toMatchObject({ status: 'queued', stage: 'map' });
  return res.json().source;
}
const audits = (id: string) =>
  owner
    .query(
      `select event_type, payload from audit_entries
       where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [id],
    )
    .then((r) => r.rows);

describe('a spreadsheet source (AC-1; KB-03, UC-10 1-2a)', () => {
  it('creates a queued spreadsheet at scan, with its audit entry (no file name) and job', async () => {
    const source = await addSheet();
    expect(source).toMatchObject({
      kind: 'spreadsheet',
      status: 'queued',
      stage: 'scan',
      name: 'Prices.csv',
      file: { name: 'Prices.csv', sizeBytes: PRICES_CSV.length, type: null },
      sheet: null,
      version: 1,
    });
    const [created] = await audits(source.id);
    expect(created).toEqual({
      event_type: 'kb_source.created',
      payload: { kind: 'spreadsheet', ext: 'csv', sizeBytes: PRICES_CSV.length },
    });
    expect(await count(`select count(*) as n from outbox where topic = 'ingest'`)).toBe(1);
  });

  it('accepts .xlsx and .csv uploads; refuses .xls, and a kind that does not fit the name', async () => {
    for (const fileName of ['Prices.xlsx', 'prices.CSV']) {
      const res = await call('POST', '/api/v1/kb/uploads', asA, { fileName, sizeBytes: 10 });
      expect(res.statusCode).toBe(201);
    }
    const xls = await call('POST', '/api/v1/kb/uploads', asA, {
      fileName: 'Prices.xls',
      sizeBytes: 10,
    });
    expect(xls.statusCode).toBe(400);
    expect(xls.json().error).toBe('unsupported_type');
    const uploadId = '00000000-0000-4000-8000-000000000001';
    for (const [kind, fileName] of [
      ['spreadsheet', 'Prices.xls'],
      ['spreadsheet', 'Menu.pdf'],
      ['file', 'Prices.csv'],
      ['file', 'Prices.xlsx'],
    ]) {
      const res = await call('POST', '/api/v1/kb/sources', asA, {
        kind,
        uploadId,
        fileName,
        sizeBytes: 10,
      });
      expect(res.statusCode, `${kind} ${fileName}`).toBe(400);
      expect(res.json().error).toBe('unsupported_type');
    }
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
  });

  it("counts spreadsheets toward the plan's file limit", async () => {
    for (let i = 0; i < FILE_LIMIT; i++) await addSheet(PRICES_CSV, `Prices ${i}.csv`);
    const res = await call('POST', '/api/v1/kb/uploads', asA, {
      fileName: 'Menu.pdf',
      sizeBytes: 10,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('file_limit_reached');
  });
});

describe('the layout and rows (AC-3)', () => {
  it('shows a parsed spreadsheet waiting at map, its layout, suggestion and rows with cells', async () => {
    const source = await addSheet();
    await drain(source.id);
    const res = await call('GET', `/api/v1/kb/sources/${source.id}`, asA);
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.source).toMatchObject({
      status: 'queued',
      stage: 'map',
      file: { type: 'csv' },
      sheet: {
        name: null,
        headerRow: 1,
        rows: 5,
        rowsSkipped: 0,
        suggested: { columns: MAPPING, gst: null },
        mapping: null,
      },
    });
    expect(detail.source.sheet.columns).toEqual([
      { index: 0, header: 'Product', samples: ['Pandan chiffon', 'Kaya roll', 'Ondeh ondeh'] },
      { index: 1, header: 'Price', samples: ['38', 'TBC', '$12.50'] },
      { index: 2, header: 'Stock', samples: ['12', '3', '12'] },
    ]);
    expect(detail.pages.map((p: { url: string }) => p.url)).toEqual([
      'row/2',
      'row/3',
      'row/4',
      'row/5',
      'row/6',
    ]);
    expect(detail.pages[0]).toMatchObject({ cells: ['Pandan chiffon', '38', '12'] });
    // The list shows it too, waiting; a website's or file's `sheet` is null.
    const list = await call('GET', '/api/v1/kb/sources', asA);
    expect(list.json().sources[0]).toMatchObject({ id: source.id, stage: 'map' });
  });
});

describe('POST /:id/preview (AC-4, AC-6)', () => {
  it("shows what would be imported, and why rows can't be; writes nothing", async () => {
    const source = await mapped();
    const before = await count(`select count(*) as n from audit_entries`);
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/preview`, asA, {
      mapping: MAPPING,
      gst: 'inclusive',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rows: 5,
      importable: 2,
      rejected: 1,
      empty: 1,
      duplicates: 1,
      existing: 0,
      conflicts: 0,
      gstReview: 0,
      sample: [
        {
          row: 2,
          cells: ['Pandan chiffon', '38', '12'],
          reason: null,
          fact: { name: 'Pandan chiffon', price: '38.00', unit: null, sku: null, stock: 12 },
          conflict: false,
        },
        {
          row: 5,
          cells: ['Ondeh ondeh', '$12.50', '3'],
          reason: null,
          fact: { name: 'Ondeh ondeh', price: '12.50', unit: null, sku: null, stock: 3 },
          conflict: false,
        },
      ],
      rejects: [
        {
          row: 3,
          cells: ['Kaya roll', 'TBC', ''],
          reason: 'bad_price',
          fact: null,
          conflict: false,
        },
      ],
    });
    expect(await count(`select count(*) as n from audit_entries`)).toBe(before);
    expect(await count(`select count(*) as n from facts`)).toBe(0);
    const again = await call('GET', `/api/v1/kb/sources/${source.id}`, asA);
    expect(again.json().source).toMatchObject({ stage: 'map', version: source.version });
  });

  it('counts the prices that wait for their GST treatment (KB-15, UC-10 4a)', async () => {
    const source = await mapped();
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/preview`, asA, {
      mapping: MAPPING,
      gst: 'unknown',
    });
    expect(res.json()).toMatchObject({ importable: 2, gstReview: 2 });
  });

  it.each([
    [{ price: 1 }, 'Choose the column with the product or service names'],
    [{ product: 0 }, 'Choose the column with the prices'],
    [{ product: 0, price: 7 }, "That column isn't in this sheet (Price)"],
    [
      { product: 0, price: 1, stock: 1 },
      "One column can't be used for two fields (Price and Stock)",
    ],
  ])('refuses the mapping %j as bad_mapping', async (mapping, message) => {
    const source = await mapped();
    for (const path of ['preview', 'import']) {
      const res = await call('POST', `/api/v1/kb/sources/${source.id}/${path}`, asA, {
        mapping,
        gst: 'inclusive',
        ...(path === 'import' ? { version: source.version } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_mapping', message });
    }
  });

  it.each([
    ['an unknown field', { mapping: { ...MAPPING, colour: 3 }, gst: 'inclusive' }],
    ['a negative index', { mapping: { ...MAPPING, stock: -1 }, gst: 'inclusive' }],
    ['no GST choice', { mapping: MAPPING }],
    ['an unknown GST choice', { mapping: MAPPING, gst: 'zero' }],
  ])('refuses %s as bad_request', async (_, body) => {
    const source = await mapped();
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/preview`, asA, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('is invalid_state unless the spreadsheet waits at map; a file is not found', async () => {
    const source = await addSheet();
    const choice = { mapping: MAPPING, gst: 'inclusive' };
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/preview`, asA, choice);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('invalid_state');
    const imp = await call('POST', `/api/v1/kb/sources/${source.id}/import`, asA, {
      ...choice,
      version: source.version,
    });
    expect(imp.statusCode).toBe(409);
    expect(imp.json().error).toBe('invalid_state');
    // A file source isn't a spreadsheet: there is no mapping to preview.
    const ticket = await call('POST', '/api/v1/kb/uploads', asA, {
      fileName: 'Menu.pdf',
      sizeBytes: 10,
    });
    const file = await call('POST', '/api/v1/kb/sources', asA, {
      kind: 'file',
      uploadId: ticket.json().uploadId,
      fileName: 'Menu.pdf',
      sizeBytes: 10,
    });
    const other = await call(
      'POST',
      `/api/v1/kb/sources/${file.json().source.id}/preview`,
      asA,
      choice,
    );
    expect(other.statusCode).toBe(404);
  });
});

describe('POST /:id/import (AC-5, AC-8)', () => {
  it('confirms the mapping, queues the import and, after it, the rows are approved facts', async () => {
    const source = await mapped();
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/import`, asA, {
      mapping: MAPPING,
      gst: 'inclusive',
      version: source.version,
    });
    expect(res.statusCode).toBe(200);
    const confirmed = res.json().source;
    expect(confirmed).toMatchObject({
      status: 'queued',
      stage: 'import',
      version: source.version + 1,
      sheet: { mapping: { columns: MAPPING, gst: 'inclusive' } },
    });
    expect(Object.keys(confirmed.sheet.mapping).sort()).toEqual(['columns', 'confirmedAt', 'gst']);
    const confirmedAudit = (await audits(source.id)).find(
      (a) => a.event_type === 'kb_source.import_confirmed',
    );
    expect(confirmedAudit.payload).toEqual({
      rows: 5,
      importable: 2,
      rejected: 1,
      gst: 'inclusive',
    });
    expect(
      await count(
        `select count(*) as n from outbox where group_key = $1 and dispatched_at is null`,
        [source.id],
      ),
    ).toBe(1);

    await drain(source.id);
    const detail = (await call('GET', `/api/v1/kb/sources/${source.id}`, asA)).json();
    expect(detail.source).toMatchObject({
      status: 'ready',
      stage: null,
      counts: { pagesIncluded: 2, pagesFailed: 1, pagesExcluded: 2, facts: 2 },
    });
    expect(
      detail.pages.map((p: { url: string; status: string; reason: string | null }) => [
        p.url,
        p.status,
        p.reason,
      ]),
    ).toEqual([
      ['row/2', 'included', null],
      ['row/3', 'failed', 'bad_price'],
      ['row/4', 'excluded', 'empty_row'],
      ['row/5', 'included', null],
      ['row/6', 'excluded', 'duplicate'],
    ]);
    const facts = await owner.query(
      `select status, value from facts where source_id = $1 order by value->>'name'`,
      [source.id],
    );
    expect(facts.rows.map((f) => [f.status, f.value.name, f.value.stock])).toEqual([
      ['approved', 'Ondeh ondeh', 3],
      ['approved', 'Pandan chiffon', 12],
    ]);
    // The fact API shows the stock with its date; a row is the fact's location (D8).
    const listed = await call('GET', `/api/v1/kb/facts?sourceId=${source.id}`, asA);
    const ondeh = listed
      .json()
      .facts.find((f: { value: { name: string } }) => f.value.name === 'Ondeh ondeh');
    expect(ondeh.value).toEqual({
      name: 'Ondeh ondeh',
      price: '12.50',
      stock: 3,
      stockAsOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(ondeh.provenance.location).toEqual({ unit: 'row', number: 5 });
  });

  it('is version_conflict on a stale version and changes nothing', async () => {
    const source = await mapped();
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/import`, asA, {
      mapping: MAPPING,
      gst: 'inclusive',
      version: source.version - 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('version_conflict');
    const again = await call('GET', `/api/v1/kb/sources/${source.id}`, asA);
    expect(again.json().source).toMatchObject({ stage: 'map', version: source.version });
  });

  it('fails no_valid_rows when no row is valid; retry brings it back to the mapping (UC-10 5a, D6)', async () => {
    const source = await mapped(NO_PRICES_CSV);
    const choice = { mapping: { product: 0, price: 1 }, gst: 'inclusive' };
    const preview = await call('POST', `/api/v1/kb/sources/${source.id}/preview`, asA, choice);
    expect(preview.json()).toMatchObject({ importable: 0, rejected: 2 });
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/import`, asA, {
      ...choice,
      version: source.version,
    });
    expect(res.statusCode).toBe(200);
    const failed = res.json().source;
    expect(failed).toMatchObject({
      status: 'failed',
      failure: 'no_valid_rows',
      retryable: true,
      sheet: { mapping: null },
    });
    const confirmedAudit = (await audits(source.id)).find(
      (a) => a.event_type === 'kb_source.import_confirmed',
    );
    expect(confirmedAudit.payload).toMatchObject({ importable: 0, rejected: 2 });
    expect(
      await count(
        `select count(*) as n from outbox where group_key = $1 and dispatched_at is null`,
        [source.id],
      ),
    ).toBe(0);
    const retry = await call('POST', `/api/v1/kb/sources/${source.id}/retry`, asA, {
      version: failed.version,
    });
    expect(retry.statusCode).toBe(200);
    await drain(source.id);
    const back = (await call('GET', `/api/v1/kb/sources/${source.id}`, asA)).json();
    expect(back.source).toMatchObject({ status: 'queued', stage: 'map', sheet: { mapping: null } });
  });

  it('can delete a spreadsheet waiting at map', async () => {
    const source = await mapped();
    const res = await call(
      'DELETE',
      `/api/v1/kb/sources/${source.id}?version=${source.version}`,
      asA,
    );
    expect(res.statusCode).toBe(204);
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
    expect(await count(`select count(*) as n from kb_source_pages`)).toBe(0);
  });
});

describe('isolation and roles (AC-9; ADR-005)', () => {
  it("is 404 to tenant B for tenant A's spreadsheet, and 403 without kb.manage", async () => {
    const source = await mapped();
    const choice = { mapping: MAPPING, gst: 'inclusive' };
    for (const [path, body] of [
      ['', undefined],
      ['/preview', choice],
      ['/import', { ...choice, version: source.version }],
    ] as const) {
      const method = path ? 'POST' : 'GET';
      const b = await call(method, `/api/v1/kb/sources/${source.id}${path}`, asB, body);
      expect(b.statusCode, `B ${path}`).toBe(404);
      const agent = await call(method, `/api/v1/kb/sources/${source.id}${path}`, asAgent, body);
      expect(agent.statusCode, `agent ${path}`).toBe(403);
    }
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/preview`, '', choice);
    expect(res.statusCode).toBe(401);
    const after = await call('GET', `/api/v1/kb/sources/${source.id}`, asA);
    expect(after.json().source).toMatchObject({ stage: 'map', version: source.version });
  });
});
