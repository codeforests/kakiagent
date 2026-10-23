import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import {
  parseFile,
  readCsv,
  readXlsx,
  scanFile,
  ScannerUnavailableError,
  sniffType,
  suggestMapping,
  tableOf,
  type FileDeps,
  type FileType,
  type SourceRecord,
} from '@kaki/kb';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHINESE_NOTICE,
  eicar,
  FAQ_DOCX,
  MENU_PHOTO_LINES,
  PRICE_LIST_HEADER,
  PRICE_LIST_PAGES,
  PRICE_LIST_ROWS,
  PROMO_SLIDES,
  SCANNED_MENU_PAGES,
} from '../fixtures/files/content.js';
import { clamavScanner } from '../src/clamav.js';
import { pdftoppmRasterizer } from '../src/pdf-raster.js';
import { s3FileStore } from '../src/s3-files.js';
import { tesseractOcr } from '../src/tesseract.js';

/**
 * The worker's file adapters against the real things (FEAT-015 T6, T7): S3 on LocalStack,
 * clamd in its container, and the `tesseract` and `pdftoppm` binaries (CI installs them;
 * TESSERACT_PATH and PDFTOPPM_PATH can name others). Without Docker, KAKI_TEST_S3_ENDPOINT
 * and KAKI_TEST_CLAMAV (`host:port`) name running ones.
 */
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/files/${name}`, import.meta.url)));
const ocr = tesseractOcr({ path: process.env.TESSERACT_PATH || 'tesseract' });
const rasterizer = pdftoppmRasterizer({ path: process.env.PDFTOPPM_PATH || 'pdftoppm' });

/** 1 − edit distance ÷ length, ignoring whitespace. */
function accuracy(expected: string, actual: string): number {
  const a = [...expected.replace(/\s/g, '')];
  const b = [...actual.replace(/\s/g, '')];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return 1 - prev[b.length]! / a.length;
}

let localstack: StartedLocalStackContainer | null = null;
let clamd: StartedTestContainer | null = null;
let s3: S3Client;
let store: ReturnType<typeof s3FileStore>;
let clamav: ReturnType<typeof clamavScanner>;
const QUARANTINE = `quarantine-${randomUUID().slice(0, 8)}`;
const SOURCES = `sources-${randomUUID().slice(0, 8)}`;
const region = 'ap-southeast-1';

beforeAll(async () => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  let endpoint = process.env.KAKI_TEST_S3_ENDPOINT;
  let clam = process.env.KAKI_TEST_CLAMAV;
  const starting: Promise<unknown>[] = [];
  if (!endpoint)
    starting.push(
      new LocalstackContainer('localstack/localstack:4')
        .withEnvironment({ SERVICES: 's3' })
        .start()
        .then((c) => {
          localstack = c;
          endpoint = c.getConnectionUri();
        }),
    );
  if (!clam)
    starting.push(
      // The image carries its signatures; clamd starts without reaching the update servers.
      new GenericContainer('clamav/clamav:1.4')
        .withExposedPorts(3310)
        .withWaitStrategy(Wait.forLogMessage('socket found, clamd started'))
        .withStartupTimeout(170_000)
        .start()
        .then((c) => {
          clamd = c;
          clam = `${c.getHost()}:${c.getMappedPort(3310)}`;
        }),
    );
  await Promise.all(starting);
  s3 = new S3Client({ region, endpoint, forcePathStyle: true });
  for (const Bucket of [QUARANTINE, SOURCES])
    await s3.send(
      new CreateBucketCommand({
        Bucket,
        CreateBucketConfiguration: { LocationConstraint: region },
      }),
    );
  store = s3FileStore({ quarantineBucket: QUARANTINE, sourcesBucket: SOURCES, region, client: s3 });
  const [host, port] = clam!.split(':');
  clamav = clamavScanner({ host: host!, port: Number(port) });
});

afterAll(async () => {
  s3?.destroy();
  await localstack?.stop();
  await clamd?.stop();
});

const put = (key: string, body: Uint8Array) =>
  s3.send(new PutObjectCommand({ Bucket: QUARANTINE, Key: key, Body: body }));

describe('s3FileStore', () => {
  it('heads, gets, copies to sources and deletes; a missing key is null, deleting it a no-op', async () => {
    const key = `uploads/t/${randomUUID()}`;
    const bytes = fixture('policies.txt');
    await put(key, bytes);
    expect(await store.head('quarantine', key)).toEqual({ size: bytes.length });
    expect(await store.get('quarantine', key)).toEqual(bytes);
    await store.copyToSources(key, 'files/t/s');
    expect(await store.get('sources', 'files/t/s')).toEqual(bytes);
    await store.delete('quarantine', key);
    expect(await store.head('quarantine', key)).toBeNull();
    await expect(store.delete('quarantine', key)).resolves.toBeUndefined();
    await store.delete('sources', 'files/t/s');
    expect(await store.head('sources', 'files/t/s')).toBeNull();
  });
});

describe('clamavScanner', () => {
  it('says clean for a fixture and FOUND for EICAR', async () => {
    expect(await clamav.healthy()).toBe(true);
    await expect(clamav.scan({ key: 'k', bytes: fixture('price-list.pdf') })).resolves.toEqual({
      infected: false,
    });
    const found = await clamav.scan({ key: 'k', bytes: eicar() });
    expect(found).toEqual({ infected: true, signature: expect.stringMatching(/eicar/i) });
  });

  it('streams a file over several 64 KB chunks', async () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 17).fill(0x41);
    await expect(clamav.scan({ key: 'k', bytes: big })).resolves.toEqual({ infected: false });
  });

  it('is unavailable, never clean, when clamd is not there', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await new Promise((r) => server.close(r)); // a port nothing listens on
    const closed = clamavScanner({ host: '127.0.0.1', port, timeoutMs: 2000 });
    await expect(closed.scan({ key: 'k', bytes: eicar() })).rejects.toThrow(
      ScannerUnavailableError,
    );
    expect(await closed.healthy()).toBe(false);
  });

  it('is unavailable when clamd hangs', async () => {
    const server = createServer(() => undefined); // accepts, never answers
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const silent = clamavScanner({ host: '127.0.0.1', port, timeoutMs: 300 });
    try {
      await expect(silent.scan({ key: 'k', bytes: fixture('policies.txt') })).rejects.toThrow(
        ScannerUnavailableError,
      );
    } finally {
      server.close();
    }
  });
});

describe('tesseract and pdftoppm', () => {
  it('has both languages', async () => {
    expect(await ocr.healthy()).toBe(true);
    expect(await tesseractOcr({ path: '/nonexistent/tesseract' }).healthy()).toBe(false);
  });

  it.each(['menu-photo.png', 'menu-photo.jpg'])('reads the prices in %s', async (name) => {
    const { text, confidence } = await ocr.recognize(fixture(name));
    for (const line of MENU_PHOTO_LINES) expect(text).toContain(line);
    expect(confidence).toBeGreaterThan(0.8);
  });

  it('reads the Chinese notice at ≥ 90% character accuracy, without spaces', async () => {
    const { text } = await ocr.recognize(fixture('chinese-notice.png'));
    expect(accuracy(CHINESE_NOTICE, text)).toBeGreaterThanOrEqual(0.9);
    expect(text).not.toMatch(/\p{Script=Han} \p{Script=Han}/u);
  });

  it('finds no text in a blank image', async () => {
    expect((await ocr.recognize(fixture('blank.png'))).text.trim()).toBe('');
  });

  it('renders a scanned page that OCR reads', async () => {
    const png = await rasterizer.render(fixture('scanned-menu.pdf'), 2);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const { text } = await ocr.recognize(png);
    for (const line of SCANNED_MENU_PAGES[1]!) expect(text).toContain(line);
  });

  it('is unavailable when the binaries fail', async () => {
    await expect(
      tesseractOcr({ path: '/nonexistent/tesseract' }).recognize(fixture('blank.png')),
    ).rejects.toThrow('tesseract failed');
    await expect(rasterizer.render(fixture('policies.txt'), 1)).rejects.toThrow('pdftoppm failed');
  });
});

/** The committed fixtures through the scan stage (S3 + ClamAV) and the parser (real OCR). */
describe('file fixtures (T7)', () => {
  const deps = (): FileDeps => ({ store, scanner: clamav, ocr, rasterizer });
  async function scan(name: string, bytes = fixture(name)) {
    const source = {
      tenantId: randomUUID(),
      id: randomUUID(),
      name,
      uploadKey: `uploads/t/${randomUUID()}`,
    } as SourceRecord;
    await put(source.uploadKey!, bytes);
    return { source, outcome: await scanFile(source, deps()) };
  }

  it.each<[string, FileType]>([
    ['price-list.pdf', 'pdf'],
    ['scanned-menu.pdf', 'pdf'],
    ['menu-photo.png', 'png'],
    ['menu-photo.jpg', 'jpeg'],
    ['chinese-notice.png', 'png'],
    ['blank.png', 'png'],
    ['faq.docx', 'docx'],
    ['promo.pptx', 'pptx'],
    ['policies.txt', 'txt'],
  ])('%s is clean %s and moves to sources', async (name, type) => {
    const { source, outcome } = await scan(name);
    expect(outcome).toMatchObject({ next: 'parse', type });
    expect(await store.head('quarantine', source.uploadKey!)).toBeNull();
    expect(await store.head('sources', `files/${source.tenantId}/${source.id}`)).not.toBeNull();
  });

  it.each([
    ['protected.pdf', 'encrypted'],
    ['protected.docx', 'encrypted'],
    ['program.pdf', 'unsupported_type'],
  ])('%s is rejected as %s and deleted', async (name, failure) => {
    const { source, outcome } = await scan(name);
    expect(outcome).toEqual({ next: 'failed', failure });
    expect(await store.head('quarantine', source.uploadKey!)).toBeNull();
    expect(await store.head('sources', `files/${source.tenantId}/${source.id}`)).toBeNull();
  });

  it('rejects EICAR as malware before reading it', async () => {
    const { source, outcome } = await scan('eicar.pdf', eicar());
    expect(outcome).toMatchObject({ next: 'failed', failure: 'malware' });
    expect(await store.head('quarantine', source.uploadKey!)).toBeNull();
  });

  const parse = async (name: string) => {
    const bytes = fixture(name);
    const sniffed = sniffType(bytes, name);
    if (!sniffed.ok) throw new Error(`${name} is ${sniffed.failure}`);
    const out = await parseFile(bytes, sniffed.type, { ocr, rasterizer });
    if (!out.ok) throw new Error(`${name} is ${out.failure}`);
    return out.pages;
  };

  it('price-list.pdf has three text pages, no OCR', async () => {
    const pages = await parse('price-list.pdf');
    expect(pages.map((p) => p.url)).toEqual(['page/1', 'page/2', 'page/3']);
    PRICE_LIST_PAGES.forEach((lines, i) => {
      expect(pages[i]!.ocrConfidence).toBeNull();
      for (const l of lines) expect(pages[i]!.text).toContain(l);
    });
  });

  it('scanned-menu.pdf is read by OCR, page by page', async () => {
    const pages = await parse('scanned-menu.pdf');
    SCANNED_MENU_PAGES.forEach((lines, i) => {
      expect(pages[i]).toMatchObject({ url: `page/${i + 1}`, status: 'included' });
      expect(pages[i]!.ocrConfidence).toBeGreaterThan(0.8);
      for (const l of lines) expect(pages[i]!.text).toContain(l);
    });
  });

  it('promo.pptx has its slides in order and no notes', async () => {
    const pages = await parse('promo.pptx');
    expect(pages.map((p) => p.text)).toEqual(PROMO_SLIDES.map((s) => s.join('\n')));
  });

  it('faq.docx keeps its paragraphs, tab, line break and table', async () => {
    const [page] = await parse('faq.docx');
    expect(page!.url).toBe('part/1');
    expect(page!.text).toContain('Kaki Bakery FAQ\t2026\nUpdated monthly');
    for (const p of FAQ_DOCX.paragraphs.slice(1)) expect(page!.text).toContain(p);
    expect(page!.text).toContain(FAQ_DOCX.table.map((r) => r.join('\t')).join('\n'));
  });

  it('blank.png has no text', async () => {
    expect(await parse('blank.png')).toMatchObject([
      { url: 'image/1', status: 'excluded', reason: 'no_text' },
    ]);
  });
});

/** The spreadsheet fixtures through the scan stage (S3 + ClamAV) and the parse (FEAT-016 T8). */
describe('spreadsheet fixtures (FEAT-016)', () => {
  const deps = (): FileDeps => ({ store, scanner: clamav, ocr, rasterizer });
  async function scan(name: string, bytes = fixture(name)) {
    const source = {
      tenantId: randomUUID(),
      id: randomUUID(),
      kind: 'spreadsheet',
      name,
      uploadKey: `uploads/t/${randomUUID()}`,
    } as SourceRecord;
    await put(source.uploadKey!, bytes);
    return { source, outcome: await scanFile(source, deps()) };
  }
  const sourcesKey = (s: SourceRecord) => `files/${s.tenantId}/${s.id}`;
  /** What the parse stage stores, read back from `sources` as the stage reads it. */
  async function layout(source: SourceRecord, type: 'xlsx' | 'csv') {
    const bytes = await store.get('sources', sourcesKey(source));
    let rows;
    if (type === 'xlsx') {
      const x = readXlsx(bytes);
      if (!x.ok) throw new Error(x.failure);
      rows = x.rows;
    } else rows = readCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const table = tableOf(rows, { rowLimit: 2000, mask: (s) => s })!;
    return { table, suggested: suggestMapping(table.columns, table.rows) };
  }

  it('price-list.xlsx scans clean, finds its header on row 3 and suggests every field', async () => {
    const { source, outcome } = await scan('price-list.xlsx');
    expect(outcome).toMatchObject({ next: 'parse', type: 'xlsx' });
    expect(await store.head('quarantine', source.uploadKey!)).toBeNull();
    const { table, suggested } = await layout(source, 'xlsx');
    expect(table.headerRow).toBe(3);
    expect(table.columns.map((c) => c.header)).toEqual(PRICE_LIST_HEADER);
    // Rows 4..15 less the empty row 7; the formula's cached value, never the formula.
    expect(table.rows.map((r) => r.row)).toEqual([4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(table.rows.find((r) => r.row === 13)!.cells[3]).toBe('55');
    expect(table.rows[0]!.cells).toEqual(PRICE_LIST_ROWS[0]);
    expect(suggested).toEqual({
      columns: { sku: 0, product: 1, unit: 2, price: 3, stock: 4 },
      gst: 'inclusive',
    });
  });

  it('services.csv scans clean and keeps its quoted semicolons, commas and line breaks', async () => {
    const { source, outcome } = await scan('services.csv');
    expect(outcome).toMatchObject({ next: 'parse', type: 'csv' });
    const { table, suggested } = await layout(source, 'csv');
    expect(table.columns.map((c) => c.header)).toEqual(['Service', 'Price']);
    expect(table.rows.map((r) => r.cells[0])).toEqual([
      'Wash; cut and blow-dry',
      'Colour, full head',
      'Keratin treatment\r\n(long hair)',
    ]);
    expect(suggested).toEqual({ columns: { service: 0, price: 1 }, gst: null });
  });

  it.each([
    ['protected.xlsx', 'encrypted'],
    ['legacy.xls', 'unsupported_type'],
    ['latin1.csv', 'unsupported_type'],
  ])('%s is rejected as %s and deleted', async (name, failure) => {
    const { source, outcome } = await scan(name);
    expect(outcome).toEqual({ next: 'failed', failure });
    expect(await store.head('quarantine', source.uploadKey!)).toBeNull();
    expect(await store.head('sources', sourcesKey(source))).toBeNull();
  });

  it('rejects EICAR named prices.csv as malware before reading it', async () => {
    const { source, outcome } = await scan('prices.csv', eicar());
    expect(outcome).toMatchObject({ next: 'failed', failure: 'malware' });
    expect(await store.head('quarantine', source.uploadKey!)).toBeNull();
    expect(await store.head('sources', sourcesKey(source))).toBeNull();
  });
});
