import { readFileSync } from 'node:fs';
import { withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { createFakeProvider, createGateway, defaultRegistry } from '@kaki/llm-gateway';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createFileSource,
  dashboardKb,
  fakeExtractScript,
  FILE_EXTRACTION_SYSTEM,
  quarantineKey,
  retrySource,
  runIngestJob,
  ScannerUnavailableError,
  sourcesKey,
  type Bucket,
  type FileDeps,
  type FileStore,
  type IngestJobBody,
} from '../src/index.js';
import { makePdf } from './fixtures/pdf.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = 'user-owner-1';
const UPLOAD = '00000000-0000-4000-8000-00000000f001';
/** Built from two halves so no checkout holds the EICAR string (FEAT-015 §5.9). */
const EICAR = new TextEncoder().encode(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);
const MENU = [
  'Chocolate fudge cake (1 kg) — S$55.00 (GST incl.)',
  'Q: Do you deliver on Sundays?',
  'A: Yes, from 10 am to 4 pm.',
  'Refund policy: Full refund if you cancel 48 hours before collection.',
];

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

/** The two buckets in memory; `sizes` overrides what `head` reports (a 26 MB upload). */
function memStore() {
  const buckets: Record<Bucket, Map<string, Uint8Array>> = {
    quarantine: new Map(),
    sources: new Map(),
  };
  const sizes = new Map<string, number>();
  const store: FileStore = {
    async head(b, key) {
      const o = buckets[b].get(key);
      return o ? { size: sizes.get(key) ?? o.length } : null;
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
  return { store, buckets, sizes };
}

function fileDeps(over: { ocrConfidence?: number; scanner?: FileDeps['scanner'] } = {}) {
  const mem = memStore();
  const scanner = {
    scan: vi.fn(async ({ bytes }: { bytes: Uint8Array }) =>
      Buffer.from(bytes).includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
        ? { infected: true as const, signature: 'Eicar-Test-Signature' }
        : { infected: false as const },
    ),
  };
  const ocr = {
    // The fake "image" is its own text, so a test says what a scan shows.
    recognize: vi.fn(async (image: Uint8Array) => ({
      text: new TextDecoder().decode(image),
      confidence: over.ocrConfidence ?? 0.82,
    })),
  };
  const rasterizer = { render: vi.fn(async () => new TextEncoder().encode(MENU.join('\n'))) };
  const deps: FileDeps = { store: mem.store, scanner: over.scanner ?? scanner, ocr, rasterizer };
  return { deps, mem, scanner, ocr, rasterizer };
}

/** The fake extractor, recording which prompt each call had. */
function recordingLlm(fail?: () => boolean) {
  const systems: string[] = [];
  const llm = createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) => {
      systems.push(req.system ?? '');
      if (fail?.()) throw new Error('provider down');
      return fakeExtractScript(req);
    }),
  ]);
  return { llm, systems };
}

async function upload(
  files: ReturnType<typeof fileDeps>,
  bytes: Uint8Array,
  fileName = 'Price list.pdf',
  uploadId = UPLOAD,
) {
  files.mem.buckets.quarantine.set(quarantineKey(TENANT_A, uploadId), bytes);
  return withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    createFileSource(
      dashboardKb(tx, TENANT_A, USER),
      { uploadId, fileName, sizeBytes: bytes.length },
      { fileLimit: 50 },
    ),
  );
}

/** Runs the jobs the outbox holds for a source, like the dispatcher and the worker would. */
async function drain(
  s: { id: string },
  files: ReturnType<typeof fileDeps>,
  opts: { llm?: ReturnType<typeof recordingLlm>['llm']; receiveCount?: number; jobs?: number } = {},
) {
  const outcomes = [];
  for (let i = 0; i < (opts.jobs ?? 10); i++) {
    const { rows } = await owner.query(
      `update outbox set dispatched_at = now() where id = (
         select id from outbox where group_key = $1 and dispatched_at is null order by created_at limit 1)
       returning payload`,
      [s.id],
    );
    if (!rows[0]) break;
    outcomes.push(
      await runIngestJob(
        {
          zdb: tdb.zone('ingest'),
          llm: opts.llm ?? recordingLlm().llm,
          fetcher: {
            robots: async () => null,
            page: async () => ({ ok: false, reason: 'load_error' }),
          },
          files: files.deps,
        },
        rows[0].payload as IngestJobBody,
        opts.receiveCount ?? 1,
      ),
    );
  }
  return outcomes;
}

const sourceRow = async (id: string) =>
  (await owner.query(`select * from kb_sources where id = $1`, [id])).rows[0];
const pageRows = async (id: string) =>
  (
    await owner.query(
      `select url, status, reason, content, ocr_confidence, facts_count from kb_source_pages
       where source_id = $1 order by seq`,
      [id],
    )
  ).rows;
const factRows = async (id: string) =>
  (
    await owner.query(
      `select type, status, source, confidence, provenance, value from facts where source_id = $1 order by type`,
      [id],
    )
  ).rows;
const auditOf = async (id: string) =>
  (
    await owner.query(
      `select event_type, payload from audit_entries where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [id],
    )
  ).rows;
const counts = async (id: string) => ({
  pages: (await owner.query(`select 1 from kb_source_pages where source_id = $1`, [id])).rowCount,
  staged: (await owner.query(`select 1 from kb_staged_facts where source_id = $1`, [id])).rowCount,
  facts: (await owner.query(`select 1 from facts where source_id = $1`, [id])).rowCount,
});

describe('a clean file through scan, parse, extract and promote (KB-02; FEAT-015 §5.2–5.5)', () => {
  it('reads a text PDF into pages and needs_review facts with page provenance', async () => {
    const files = fileDeps();
    const { llm, systems } = recordingLlm();
    const pdf = makePdf([{ lines: MENU }, { lines: ['Thank you for choosing Kaki Bakery!'] }]);
    const s = await upload(files, pdf);
    expect(await drain(s, files, { llm })).toEqual([
      { result: 'next', stage: 'parse', type: 'pdf' },
      { result: 'next', stage: 'extract' },
      { result: 'next', stage: 'promote' },
      { result: 'ready', facts: 3 },
    ]);
    const row = await sourceRow(s.id);
    expect(row).toMatchObject({
      status: 'ready',
      file_type: 'pdf',
      file_key: sourcesKey(TENANT_A, s.id),
      file_size: pdf.length,
      pages_found: 2,
      pages_included: 2,
      ocr_pages: 0,
      facts_count: 3,
    });
    expect(row.scanned_at).not.toBeNull();
    // Only the clean copy is kept; quarantine is empty.
    expect(files.mem.buckets.quarantine.size).toBe(0);
    expect(files.mem.buckets.sources.get(sourcesKey(TENANT_A, s.id))).toEqual(pdf);
    const pages = await pageRows(s.id);
    expect(pages.map((p) => [p.url, p.status, p.ocr_confidence])).toEqual([
      ['page/1', 'included', null],
      ['page/2', 'included', null],
    ]);
    const facts = await factRows(s.id);
    expect(facts.map((f) => [f.type, f.status, f.source])).toEqual([
      ['faq', 'needs_review', 'file'],
      ['policy', 'needs_review', 'file'],
      ['product', 'needs_review', 'file'],
    ]);
    for (const f of facts) {
      expect(f.provenance.url).toBe('page/1');
      expect(f.provenance.quote).toBe(pages[0].content.slice(f.provenance.start, f.provenance.end));
    }
    expect(systems.length).toBeGreaterThan(0);
    expect(systems.every((x) => x === FILE_EXTRACTION_SYSTEM)).toBe(true);
    expect((await auditOf(s.id)).map((a) => a.event_type)).toEqual([
      'kb_source.created',
      'kb_source.scanned',
      'kb_source.promoted',
    ]);
    expect((await auditOf(s.id))[1].payload).toEqual({ type: 'pdf', verdict: 'clean' });
  });

  it("OCRs an image, counts the OCR page and caps each fact's confidence at the OCR's", async () => {
    const files = fileDeps({ ocrConfidence: 0.6 });
    const s = await upload(
      files,
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...new TextEncoder().encode(`\n${MENU.join('\n')}`),
      ]),
      'menu photo.png',
    );
    // The fake OCR "reads" the bytes after the PNG signature line.
    files.deps.ocr.recognize = async () => ({ text: MENU.join('\n'), confidence: 0.6 });
    const out = await drain(s, files);
    expect(out.at(-1)).toEqual({ result: 'ready', facts: 3 });
    expect(await sourceRow(s.id)).toMatchObject({ file_type: 'png', ocr_pages: 1 });
    expect((await pageRows(s.id))[0]).toMatchObject({ url: 'image/1', status: 'included' });
    expect((await pageRows(s.id))[0].ocr_confidence).toBeCloseTo(0.6, 5);
    for (const f of await factRows(s.id)) expect(f.confidence).toBeCloseTo(0.6, 5);
  });

  it('fails no_text when nothing in the file has text, even after OCR', async () => {
    const files = fileDeps();
    files.deps.ocr.recognize = async () => ({ text: ' ', confidence: 0.1 });
    const s = await upload(files, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'blank.jpg');
    expect((await drain(s, files)).at(-1)).toEqual({ result: 'failed', failure: 'no_text' });
    expect(await sourceRow(s.id)).toMatchObject({
      status: 'failed',
      failure: 'no_text',
      stage: null,
    });
    expect((await counts(s.id)).facts).toBe(0);
  });
});

describe('the safety checks before anything reads a file (KB-11; FEAT-015 §5.3)', () => {
  it("rejects the EICAR test file: deleted from quarantine, never stored, parsed, OCR'd or extracted", async () => {
    const files = fileDeps();
    const { llm, systems } = recordingLlm();
    const s = await upload(files, EICAR, 'test.pdf');
    expect(await drain(s, files, { llm })).toEqual([
      { result: 'failed', failure: 'malware', signature: 'Eicar-Test-Signature' },
    ]);
    expect(await sourceRow(s.id)).toMatchObject({
      status: 'failed',
      failure: 'malware',
      stage: null,
      file_key: null,
      scanned_at: null,
    });
    expect(files.mem.buckets.quarantine.size).toBe(0);
    expect(files.mem.buckets.sources.size).toBe(0);
    expect(await counts(s.id)).toEqual({ pages: 0, staged: 0, facts: 0 });
    expect(files.ocr.recognize).not.toHaveBeenCalled();
    expect(files.rasterizer.render).not.toHaveBeenCalled();
    expect(systems).toEqual([]);
    const entries = await auditOf(s.id);
    expect(entries.at(-1)).toEqual({
      event_type: 'kb_source.rejected',
      payload: { reason: 'malware' },
    });
    expect(JSON.stringify(entries)).not.toContain('Eicar');
  });

  it.each([
    [
      'a renamed ELF executable',
      new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
      'menu.pdf',
      'unsupported_type',
    ],
    [
      'a renamed PE executable',
      new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0]),
      'menu.pdf',
      'unsupported_type',
    ],
    [
      'a password-protected PDF',
      new Uint8Array(readFileSync(new URL('./fixtures/protected.pdf', import.meta.url))),
      'protected.pdf',
      'encrypted',
    ],
    [
      'a password-protected DOCX',
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
      'faq.docx',
      'encrypted',
    ],
    ['binary bytes named .txt', new Uint8Array([0x41, 0, 0x42]), 'notes.txt', 'unsupported_type'],
  ])('rejects %s and deletes it from quarantine', async (_, bytes, name, failure) => {
    const files = fileDeps();
    const s = await upload(files, bytes, name);
    expect(await drain(s, files)).toEqual([{ result: 'failed', failure }]);
    expect(files.mem.buckets.quarantine.size).toBe(0);
    expect(files.mem.buckets.sources.size).toBe(0);
    expect(await counts(s.id)).toEqual({ pages: 0, staged: 0, facts: 0 });
    expect(files.ocr.recognize).not.toHaveBeenCalled();
  });

  it('rejects an object over 25 MB unread, and fails upload_missing when the PUT never happened', async () => {
    const files = fileDeps();
    const big = await upload(files, makePdf([{ lines: MENU }]));
    files.mem.sizes.set(quarantineKey(TENANT_A, UPLOAD), 25 * 1024 * 1024 + 1);
    expect(await drain(big, files)).toEqual([{ result: 'failed', failure: 'too_large' }]);
    expect(files.scanner.scan).not.toHaveBeenCalled();
    expect(files.mem.buckets.quarantine.size).toBe(0);

    const other = '00000000-0000-4000-8000-00000000f002';
    const missing = await upload(files, makePdf([{ lines: MENU }]), 'x.pdf', other);
    files.mem.buckets.quarantine.delete(quarantineKey(TENANT_A, other));
    expect(await drain(missing, files)).toEqual([{ result: 'failed', failure: 'upload_missing' }]);
  });
});

describe('retries, redeliveries and purge (KB-12, NFR-17; FEAT-015 §5.2, §5.6, §5.7)', () => {
  it('waits queued at scan while the scanner is down, fails scan_unavailable, and a retry finishes it', async () => {
    const down = {
      scan: vi.fn(async () => Promise.reject(new ScannerUnavailableError('clamd down'))),
    };
    const files = fileDeps({ scanner: down });
    const s = await upload(files, makePdf([{ lines: MENU }]));
    await expect(drain(s, files, { receiveCount: 1, jobs: 1 })).rejects.toThrow('clamd down');
    expect(await sourceRow(s.id)).toMatchObject({ status: 'queued', stage: 'scan' });
    // The redelivery that reaches the attempt limit fails the source.
    await owner.query(`update outbox set dispatched_at = null where group_key = $1`, [s.id]);
    expect(await drain(s, files, { receiveCount: 5, jobs: 1 })).toEqual([
      { result: 'failed', failure: 'scan_unavailable' },
    ]);
    expect(await counts(s.id)).toEqual({ pages: 0, staged: 0, facts: 0 });
    // The upload is still in quarantine (within its 24 hours): retry scans it again.
    files.deps.scanner = { scan: async () => ({ infected: false }) };
    const v = (await sourceRow(s.id)).version;
    const r = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      retrySource(dashboardKb(tx, TENANT_A, USER), s.id, v),
    );
    expect(r).toMatchObject({ stage: 'scan', attempt: 2 });
    expect((await drain(s, files)).at(-1)).toEqual({ result: 'ready', facts: 3 });
  });

  it('fails extraction_unavailable with no facts, and a retry runs from parse on the stored file', async () => {
    const files = fileDeps();
    const s = await upload(files, makePdf([{ lines: MENU }]));
    const { llm } = recordingLlm(() => true);
    const out = await drain(s, files, { llm, receiveCount: 5 });
    expect(out.at(-1)).toEqual({ result: 'failed', failure: 'extraction_unavailable' });
    expect((await counts(s.id)).facts).toBe(0);
    expect((await counts(s.id)).staged).toBe(0);
    files.scanner.scan.mockClear();
    const v = (await sourceRow(s.id)).version;
    const r = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      retrySource(dashboardKb(tx, TENANT_A, USER), s.id, v),
    );
    expect(r).toMatchObject({ stage: 'parse', attempt: 2 });
    expect((await drain(s, files)).at(-1)).toEqual({ result: 'ready', facts: 3 });
    expect(files.scanner.scan).not.toHaveBeenCalled();
  });

  it('ignores a duplicate or stale scan job', async () => {
    const files = fileDeps();
    const s = await upload(files, makePdf([{ lines: MENU }]));
    await drain(s, files);
    const scan = { tenantId: TENANT_A, sourceId: s.id, attempt: 1, stage: 'scan' as const };
    const deps = {
      zdb: tdb.zone('ingest'),
      llm: recordingLlm().llm,
      fetcher: {
        robots: async () => null,
        page: async () => ({ ok: false as const, reason: 'load_error' as const }),
      },
      files: files.deps,
    };
    expect(await runIngestJob(deps, scan, 1)).toEqual({ result: 'stale' });
    expect(await runIngestJob(deps, { ...scan, attempt: 4 }, 1)).toEqual({ result: 'stale' });
    expect((await counts(s.id)).facts).toBe(3);
  });

  it("purges a deleted file's objects, and purging again is fine", async () => {
    const files = fileDeps();
    files.mem.buckets.quarantine.set('uploads/t/1', new Uint8Array([1]));
    files.mem.buckets.sources.set('files/t/1', new Uint8Array([1]));
    const job: IngestJobBody = {
      tenantId: TENANT_A,
      sourceId: '00000000-0000-4000-8000-00000000f0ff',
      stage: 'purge',
      keys: { quarantine: 'uploads/t/1', sources: 'files/t/1' },
    };
    const deps = {
      zdb: tdb.zone('ingest'),
      llm: recordingLlm().llm,
      fetcher: {} as never,
      files: files.deps,
    };
    expect(await runIngestJob(deps, job, 1)).toEqual({ result: 'purged' });
    expect(await runIngestJob(deps, job, 2)).toEqual({ result: 'purged' });
    expect(files.mem.buckets.quarantine.size + files.mem.buckets.sources.size).toBe(0);
  });
});
