import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.js';
import { s3UploadSigner, UPLOAD_TTL_S } from '../src/uploads.js';
import { fakeSigner, sessionCookie, testApp } from './support.js';

/**
 * File uploads and file sources through the API (FEAT-015 T9; AC-1, AC-6 retry, AC-8):
 * `POST /kb/uploads`, the file body of `POST /kb/sources`, the list's limits, retry and
 * delete of a file. The signer is a fake except in the last block, which PUTs to a real
 * presigned URL on LocalStack.
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
  await owner.query(`delete from kb_source_pages`);
  await owner.query(`delete from kb_sources`);
  await owner.query(`delete from outbox where topic = 'ingest'`);
  signer.signed.length = 0;
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: who }, ...(payload ? { payload } : {}) });
const count = async (q: string, args: unknown[] = []) =>
  Number((await owner.query(q, args)).rows[0].n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function ticket(fileName = 'Price list.pdf', sizeBytes = 2048, who = asA) {
  const res = await call('POST', '/api/v1/kb/uploads', who, { fileName, sizeBytes });
  expect(res.statusCode).toBe(201);
  return res.json() as { uploadId: string; url: string; headers: Record<string, string> };
}
async function addFile(fileName = 'Price list.pdf', sizeBytes = 2048) {
  const { uploadId } = await ticket(fileName, sizeBytes);
  const res = await call('POST', '/api/v1/kb/sources', asA, {
    kind: 'file',
    uploadId,
    fileName,
    sizeBytes,
  });
  expect(res.statusCode).toBe(201);
  return { uploadId, source: res.json().source };
}

describe('POST /api/v1/kb/uploads (AC-1; KB-02, UC-10 2a)', () => {
  it("signs a PUT under the session tenant's quarantine prefix and writes nothing", async () => {
    const audits = await count(`select count(*) as n from audit_entries`);
    const before = Date.now();
    const res = await call('POST', '/api/v1/kb/uploads', asA, {
      fileName: 'Menu 2026.PNG',
      sizeBytes: 123_456,
    });
    expect(res.statusCode).toBe(201);
    const t = res.json();
    expect(t.uploadId).toMatch(UUID);
    expect(t.url).toBe(`https://quarantine.test/uploads/${TENANT_A}/${t.uploadId}?signed`);
    expect(t.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    const expires = Date.parse(t.expiresAt);
    expect(expires - before).toBeGreaterThanOrEqual(UPLOAD_TTL_S * 1000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(UPLOAD_TTL_S * 1000 + 5000);
    expect(signer.signed).toEqual([
      { key: `uploads/${TENANT_A}/${t.uploadId}`, sizeBytes: 123_456, expiresInS: 900 },
    ]);
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
    expect(await count(`select count(*) as n from outbox where topic = 'ingest'`)).toBe(0);
    expect(await count(`select count(*) as n from audit_entries`)).toBe(audits);
  });

  it('gives a fresh upload ID each time', async () => {
    const [a, b] = [await ticket(), await ticket()];
    expect(a.uploadId).not.toBe(b.uploadId);
  });

  it.each([
    ['a path in the name', { fileName: '../menu.pdf', sizeBytes: 10 }],
    ['a backslash', { fileName: 'a\\menu.pdf', sizeBytes: 10 }],
    ['a control character', { fileName: 'menu\u0007.pdf', sizeBytes: 10 }],
    ['an empty name', { fileName: '', sizeBytes: 10 }],
    ['a 201-character name', { fileName: `${'a'.repeat(197)}.pdf`, sizeBytes: 10 }],
    ['an empty file', { fileName: 'menu.pdf', sizeBytes: 0 }],
    ['a fractional size', { fileName: 'menu.pdf', sizeBytes: 1.5 }],
    ['no size', { fileName: 'menu.pdf' }],
    ['an extra field', { fileName: 'menu.pdf', sizeBytes: 10, key: 'uploads/x' }],
  ])('refuses %s as bad_request', async (_, body) => {
    const res = await call('POST', '/api/v1/kb/uploads', asA, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
    expect(signer.signed).toHaveLength(0);
  });

  // .zip and .json are chat exports since FEAT-017 (§3.2): refused only as a chat's kind.
  it.each(['menu.xls', 'menu.exe', 'menu.pdf.exe', 'menu', 'menu.doc'])(
    'refuses %s as unsupported_type',
    async (fileName) => {
      const res = await call('POST', '/api/v1/kb/uploads', asA, { fileName, sizeBytes: 10 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'unsupported_type',
        message:
          'Upload a PDF, Word, PowerPoint, text, JPG, PNG, Excel (.xlsx) or CSV file, or a WhatsApp (.txt, .zip) or Telegram (.json) chat export.',
      });
    },
  );

  it.each(['a.pdf', 'b.docx', 'c.pptx', 'd.txt', 'e.jpg', 'f.jpeg', 'g.png', 'H.PDF'])(
    'accepts %s',
    async (fileName) => {
      await ticket(fileName);
    },
  );

  it('refuses a file over 25 MB, and accepts exactly 25 MB', async () => {
    const over = await call('POST', '/api/v1/kb/uploads', asA, {
      fileName: 'big.pdf',
      sizeBytes: 25 * 1024 * 1024 + 1,
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe('file_too_large');
    await ticket('big.pdf', 25 * 1024 * 1024);
  });

  it("refuses at the plan's file limit (D2)", async () => {
    for (let i = 0; i < FILE_LIMIT; i++) await addFile(`f${i}.pdf`);
    const res = await call('POST', '/api/v1/kb/uploads', asA, {
      fileName: 'one-more.pdf',
      sizeBytes: 10,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('file_limit_reached');
    // Website sources don't count, and the other tenant has its own limit.
    await ticket('theirs.pdf', 10, asB);
  });

  it('needs a session and kb.manage', async () => {
    const body = { fileName: 'menu.pdf', sizeBytes: 10 };
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/kb/uploads', payload: body })).statusCode,
    ).toBe(401);
    expect((await call('POST', '/api/v1/kb/uploads', asAgent, body)).statusCode).toBe(403);
  });
});

describe('a file source through the API (AC-1, AC-6, AC-7, AC-8)', () => {
  it('creates a queued file source at scan, with its audit entry (no file name) and job', async () => {
    const { uploadId, source } = await addFile('Kaki menu.pdf', 4096);
    expect(source).toMatchObject({
      kind: 'file',
      status: 'queued',
      stage: 'scan',
      name: 'Kaki menu.pdf',
      url: null,
      domain: null,
      pageLimit: null,
      attestedAt: null,
      failure: null,
      retryable: false,
      file: { name: 'Kaki menu.pdf', sizeBytes: 4096, type: null, ocrPages: 0, scannedAt: null },
      version: 1,
    });
    const row = (await owner.query(`select upload_key from kb_sources`)).rows[0];
    expect(row.upload_key).toBe(`uploads/${TENANT_A}/${uploadId}`);
    const audits = (
      await owner.query(
        `select event_type, payload from audit_entries
         where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
        [source.id],
      )
    ).rows;
    expect(audits).toEqual([
      { event_type: 'kb_source.created', payload: { kind: 'file', ext: 'pdf', sizeBytes: 4096 } },
    ]);
    expect(JSON.stringify(audits)).not.toContain('menu');
    const jobs = (await owner.query(`select payload from outbox where topic = 'ingest'`)).rows;
    expect(jobs.map((j) => j.payload)).toEqual([
      { tenantId: TENANT_A, sourceId: source.id, attempt: 1, stage: 'scan' },
    ]);
  });

  it('refuses a second source for the same upload', async () => {
    const { uploadId, source } = await addFile();
    const res = await call('POST', '/api/v1/kb/sources', asA, {
      kind: 'file',
      uploadId,
      fileName: 'again.pdf',
      sizeBytes: 10,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'source_exists', sourceId: source.id });
  });

  it("can't name another tenant's upload: the key is always the session tenant's", async () => {
    const { uploadId } = await ticket('theirs.pdf', 10, asB);
    const res = await call('POST', '/api/v1/kb/sources', asA, {
      kind: 'file',
      uploadId,
      fileName: 'theirs.pdf',
      sizeBytes: 10,
    });
    expect(res.statusCode).toBe(201);
    const keys = (await owner.query(`select tenant_id, upload_key from kb_sources`)).rows;
    expect(keys).toEqual([{ tenant_id: TENANT_A, upload_key: `uploads/${TENANT_A}/${uploadId}` }]);
  });

  it.each([
    [{ uploadId: 'nope', fileName: 'a.pdf', sizeBytes: 10 }, 'bad_request'],
    [{ fileName: 'a.pdf', sizeBytes: 10 }, 'bad_request'],
    [{ uploadId: crypto.randomUUID(), fileName: 'a.zip', sizeBytes: 10 }, 'unsupported_type'],
    [
      { uploadId: crypto.randomUUID(), fileName: 'a.pdf', sizeBytes: 25 * 1024 * 1024 + 1 },
      'file_too_large',
    ],
  ])('refuses %o as %s', async (body, error) => {
    const res = await call('POST', '/api/v1/kb/sources', asA, { kind: 'file', ...body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
  });

  it("refuses a source over the plan's file limit", async () => {
    const tickets = [];
    for (let i = 0; i <= FILE_LIMIT; i++) tickets.push(await ticket(`f${i}.pdf`));
    for (const [i, t] of tickets.entries()) {
      const res = await call('POST', '/api/v1/kb/sources', asA, {
        kind: 'file',
        uploadId: t.uploadId,
        fileName: `f${i}.pdf`,
        sizeBytes: 2048,
      });
      expect(res.statusCode).toBe(i < FILE_LIMIT ? 201 : 409);
      if (i === FILE_LIMIT) expect(res.json().error).toBe('file_limit_reached');
    }
  });

  it('lists file sources with the limits, and only to their tenant', async () => {
    const { source } = await addFile();
    const list = await call('GET', '/api/v1/kb/sources', asA);
    expect(list.json()).toMatchObject({
      fileLimit: FILE_LIMIT,
      maxFileBytes: 25 * 1024 * 1024,
      sources: [{ id: source.id, kind: 'file' }],
    });
    expect((await call('GET', '/api/v1/kb/sources', asB)).json().sources).toEqual([]);
    expect((await call('GET', `/api/v1/kb/sources/${source.id}`, asB)).statusCode).toBe(404);
  });

  it("shows a file's pages with their OCR confidence", async () => {
    const { source } = await addFile();
    await owner.query(
      `update kb_sources set status = 'ready', stage = null, file_type = 'pdf', ocr_pages = 1,
         scanned_at = now() where id = $1`,
      [source.id],
    );
    await owner.query(
      `insert into kb_source_pages (tenant_id, source_id, attempt, seq, url, status, reason, ocr_confidence)
       values ($1, $2, 1, 0, 'page/1', 'included', null, null),
              ($1, $2, 1, 1, 'page/2', 'included', null, 0.82),
              ($1, $2, 1, 2, 'page/3', 'excluded', 'no_text', 0.1)`,
      [TENANT_A, source.id],
    );
    const res = await call('GET', `/api/v1/kb/sources/${source.id}`, asA);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source.file).toMatchObject({ type: 'pdf', ocrPages: 1 });
    expect(body.source.file.scannedAt).toBeTruthy();
    expect(
      body.pages.map((p: { url: string; ocrConfidence: number | null }) => [
        p.url,
        p.ocrConfidence,
      ]),
    ).toEqual([
      ['page/1', null],
      ['page/2', expect.closeTo(0.82, 5)],
      ['page/3', expect.closeTo(0.1, 5)],
    ]);
  });

  const failWith = (id: string, failure: string, fileKey: string | null = null) =>
    owner.query(
      `update kb_sources set status = 'failed', stage = 'scan', failure = $2, file_key = $3,
         finished_at = now() where id = $1`,
      [id, failure, fileKey],
    );

  it.each([
    'upload_missing',
    'too_large',
    'unsupported_type',
    'encrypted',
    'malware',
    'unreadable',
    'no_text',
  ])("won't retry a file that failed as %s (D7)", async (failure) => {
    const { source } = await addFile();
    await failWith(source.id, failure);
    const listed = (await call('GET', `/api/v1/kb/sources/${source.id}`, asA)).json().source;
    expect(listed.retryable).toBe(false);
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/retry`, asA, {
      version: listed.version,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_retryable');
  });

  it.each([
    ['scan_unavailable', null, 'scan'],
    ['extraction_unavailable', 'files/t/s', 'parse'],
  ])('retries a file that failed as %s, from %s', async (failure, fileKey, stage) => {
    const { source } = await addFile();
    await failWith(source.id, failure, fileKey);
    const listed = (await call('GET', `/api/v1/kb/sources/${source.id}`, asA)).json().source;
    expect(listed.retryable).toBe(true);
    const res = await call('POST', `/api/v1/kb/sources/${source.id}/retry`, asA, {
      version: listed.version,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toMatchObject({ status: 'queued', stage, failure: null });
  });

  it('deletes a file source and queues the purge of its objects (KB-07)', async () => {
    const { uploadId, source } = await addFile();
    await owner.query(`update kb_sources set status = 'ready', stage = null where id = $1`, [
      source.id,
    ]);
    const current = (await call('GET', `/api/v1/kb/sources/${source.id}`, asA)).json().source;
    const res = await call(
      'DELETE',
      `/api/v1/kb/sources/${source.id}?version=${current.version}`,
      asA,
    );
    expect(res.statusCode).toBe(204);
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
    const jobs = (
      await owner.query(`select payload from outbox where topic = 'ingest' order by created_at`)
    ).rows.map((r) => r.payload);
    expect(jobs.at(-1)).toEqual({
      tenantId: TENANT_A,
      sourceId: source.id,
      stage: 'purge',
      keys: {
        quarantine: `uploads/${TENANT_A}/${uploadId}`,
        sources: `files/${TENANT_A}/${source.id}`,
      },
    });
  });
});

describe('the S3 presigner (AC-8)', () => {
  let localstack: StartedLocalStackContainer | null = null;
  let s3: S3Client;
  let endpoint: string;
  const bucket = 'kaki-test-quarantine';

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID ??= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
    endpoint = process.env.KAKI_TEST_S3_ENDPOINT ?? '';
    if (!endpoint) {
      localstack = await new LocalstackContainer('localstack/localstack:4')
        .withEnvironment({ SERVICES: 's3' })
        .start();
      endpoint = localstack.getConnectionUri();
    }
    s3 = new S3Client({ region: 'ap-southeast-1', endpoint, forcePathStyle: true });
    await s3
      .send(
        new CreateBucketCommand({
          Bucket: bucket,
          CreateBucketConfiguration: { LocationConstraint: 'ap-southeast-1' },
        }),
      )
      .catch((err: { name?: string }) => {
        if (err.name !== 'BucketAlreadyOwnedByYou') throw err;
      });
  });
  afterAll(async () => {
    s3?.destroy();
    await localstack?.stop();
  });

  it("stores a PUT to the returned URL under the session tenant's prefix", async () => {
    const real = await testApp(tdb, {
      uploads: s3UploadSigner({ bucket, region: 'ap-southeast-1', endpoint }),
    });
    try {
      const body = new TextEncoder().encode('Chocolate fudge cake (1 kg) — S$55.00');
      const res = await real.inject({
        method: 'POST',
        url: '/api/v1/kb/uploads',
        headers: { cookie: asA },
        payload: { fileName: 'menu.txt', sizeBytes: body.length },
      });
      expect(res.statusCode).toBe(201);
      const t = res.json();
      expect(new URL(t.url).pathname).toBe(`/${bucket}/uploads/${TENANT_A}/${t.uploadId}`);
      const put = await fetch(t.url, { method: 'PUT', headers: t.headers, body });
      expect(put.status).toBe(200);
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: `uploads/${TENANT_A}/${t.uploadId}` }),
      );
      expect(head.ContentLength).toBe(body.length);
      // The length and type are signed, so S3 refuses any other body size. (LocalStack
      // doesn't check signed headers; the worker re-checks the stored size anyway, §5.3.)
      expect(new URL(t.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host',
      );
      expect(Number(new URL(t.url).searchParams.get('X-Amz-Expires'))).toBe(UPLOAD_TTL_S);
    } finally {
      await real.close();
    }
  });
});
