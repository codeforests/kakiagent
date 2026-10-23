import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import {
  fakeExtractScript,
  fakeMineScript,
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
 * Chat exports through the API (FEAT-017 T9; AC-1, AC-6, AC-8): the chat body of `POST
 * /kb/sources`, a chat's redacted summary and parts in the detail, retry and tenant
 * isolation. The worker's stages run in the test, on an in-memory file store.
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
  throw new Error('a chat export is never OCR’d');
};
const files: FileDeps = {
  store,
  scanner: { scan: async () => ({ infected: false }) },
  ocr: { recognize: never },
  rasterizer: { render: never },
};
const llm = createGateway(defaultRegistry('fake'), [
  createFakeProvider((req) =>
    req.model === 'mine' ? fakeMineScript(req) : fakeExtractScript(req),
  ),
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

const CHAT = enc(
  [
    "13/10/2026, 09:00 - Mdm Tan Mei Ling: Hi, I'm Mei Ling, 9123 4567",
    '13/10/2026, 09:01 - Mdm Tan Mei Ling: Open on Sunday?',
    '13/10/2026, 09:03 - Kaki Bakery: Yes, 9am to 5pm.',
    '14/10/2026, 10:00 - Mdm Tan Mei Ling: Is it halal?',
    '14/10/2026, 10:02 - Kaki Bakery: Our kitchen is halal-certified.',
  ].join('\n'),
);
const FILE = 'WhatsApp Chat with Mdm Tan.txt';

async function upload(bytes: Uint8Array, fileName: string) {
  const ticket = await call('POST', '/api/v1/kb/uploads', asA, {
    fileName,
    sizeBytes: bytes.length,
  });
  expect(ticket.statusCode).toBe(201);
  const { uploadId } = ticket.json();
  buckets.quarantine.set(quarantineKey(TENANT_A, uploadId), bytes);
  return uploadId as string;
}
async function addChat(bytes = CHAT, fileName = FILE, businessNames: unknown = ['Kaki Bakery']) {
  const uploadId = await upload(bytes, fileName);
  return call('POST', '/api/v1/kb/sources', asA, {
    kind: 'chat',
    uploadId,
    fileName,
    sizeBytes: bytes.length,
    businessNames,
  });
}
const audits = (id: string) =>
  owner
    .query(
      `select event_type, payload from audit_entries
       where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [id],
    )
    .then((r) => r.rows);

describe('a chat source (AC-1; KB-04, UC-11 1, 2a)', () => {
  it('creates a queued chat at scan named "Chat export", without the file or business names in the audit', async () => {
    const res = await addChat();
    expect(res.statusCode).toBe(201);
    const source = res.json().source;
    expect(source).toMatchObject({
      kind: 'chat',
      status: 'queued',
      stage: 'scan',
      name: 'Chat export',
      file: { name: 'Chat export', sizeBytes: CHAT.length, type: null },
      chat: null,
      sheet: null,
    });
    const [created] = await audits(source.id);
    expect(created).toEqual({
      event_type: 'kb_source.created',
      payload: { kind: 'chat', ext: 'txt', sizeBytes: CHAT.length },
    });
    expect(JSON.stringify(await audits(source.id))).not.toMatch(/Tan|Kaki/);
    expect(await count(`select count(*) as n from outbox where topic = 'ingest'`)).toBe(1);
  });

  it('accepts .txt, .zip and .json uploads; refuses other kinds of file and bad business names', async () => {
    for (const fileName of ['chat.zip', 'result.json']) {
      const res = await call('POST', '/api/v1/kb/uploads', asA, { fileName, sizeBytes: 10 });
      expect(res.statusCode).toBe(201);
    }
    const uploadId = '00000000-0000-4000-8000-000000000001';
    const pdf = await call('POST', '/api/v1/kb/sources', asA, {
      kind: 'chat',
      uploadId,
      fileName: 'chat.pdf',
      sizeBytes: 10,
      businessNames: ['Kaki'],
    });
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json().error).toBe('unsupported_type');
    // null stands for a missing list (undefined would take addChat's default).
    for (const businessNames of [
      null,
      [],
      [''],
      ['x'.repeat(101)],
      ['a', 'b', 'c', 'd', 'e', 'f'],
    ]) {
      const res = await addChat(CHAT, FILE, businessNames);
      expect(res.statusCode, JSON.stringify(businessNames)).toBe(400);
    }
    // A zip or JSON file is not a document upload.
    const zipAsFile = await call('POST', '/api/v1/kb/sources', asA, {
      kind: 'file',
      uploadId,
      fileName: 'chat.zip',
      sizeBytes: 10,
    });
    expect(zipAsFile.json().error).toBe('unsupported_type');
    expect(await count(`select count(*) as n from kb_sources`)).toBe(0);
  });

  it("counts chat exports toward the plan's file limit; an agent can't add one", async () => {
    for (let i = 0; i < FILE_LIMIT; i++) expect((await addChat()).statusCode).toBe(201);
    const res = await call('POST', '/api/v1/kb/uploads', asA, { fileName: 'c.txt', sizeBytes: 10 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('file_limit_reached');
    const agent = await call('POST', '/api/v1/kb/sources', asAgent, {
      kind: 'chat',
      uploadId: '00000000-0000-4000-8000-000000000002',
      fileName: 'c.txt',
      sizeBytes: 10,
      businessNames: ['Kaki'],
    });
    expect(agent.statusCode).toBe(403);
  });
});

describe('the summary and parts (AC-3, AC-5)', () => {
  it('shows the redacted summary without business names, and parts as pages', async () => {
    const source = (await addChat()).json().source;
    await drain(source.id);
    const res = await call('GET', `/api/v1/kb/sources/${source.id}`, asA);
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.source).toMatchObject({
      status: 'ready',
      name: 'WhatsApp chat, 13–14 Oct 2026',
      file: { type: 'txt' },
      chat: {
        format: 'whatsapp',
        from: '2026-10-13',
        to: '2026-10-14',
        messages: 5,
        exchanges: 2,
        redacted: { names: 1, phones: 1 },
        exportDeletedAt: expect.any(String),
      },
      counts: { facts: 2, factsNeedingReview: 2 },
    });
    expect(detail.source.chat.businessNames).toBeUndefined();
    expect(detail.pages).toHaveLength(1);
    expect(detail.pages[0]).toMatchObject({
      url: 'chat/1',
      title: '13–14 Oct 2026',
      status: 'included',
    });
    expect(JSON.stringify(detail)).not.toMatch(/Mei Ling|9123/);
    const review = await call('GET', `/api/v1/kb/review/facts?sourceId=${source.id}&type=faq`, asA);
    expect(
      review
        .json()
        .facts.map((f: { value: { question: string } }) => f.value.question)
        .sort(),
    ).toEqual(['Is it halal?', 'Open on Sunday?']);
  });
});

describe('failures and retry (AC-6, AC-7)', () => {
  it('a business that is not in the chat fails business_not_found, and retry is not_retryable', async () => {
    buckets.quarantine.clear();
    const source = (await addChat(CHAT, FILE, ['Other Shop'])).json().source;
    await drain(source.id);
    const res = await call('GET', `/api/v1/kb/sources/${source.id}`, asA);
    expect(res.json().source).toMatchObject({
      status: 'failed',
      failure: 'business_not_found',
      retryable: false,
    });
    const retry = await call('POST', `/api/v1/kb/sources/${source.id}/retry`, asA, {
      version: res.json().source.version,
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toBe('not_retryable');
    expect(buckets.quarantine.size).toBe(0);
  });
});

describe('tenant isolation (AC-8)', () => {
  it("tenant B can't see, retry or delete tenant A's chat source, nor review its suggestions", async () => {
    const source = (await addChat()).json().source;
    await drain(source.id);
    expect((await call('GET', `/api/v1/kb/sources/${source.id}`, asB)).statusCode).toBe(404);
    const list = await call('GET', '/api/v1/kb/sources', asB);
    expect(list.json().sources).toEqual([]);
    expect(
      (await call('POST', `/api/v1/kb/sources/${source.id}/retry`, asB, { version: 1 })).statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/api/v1/kb/sources/${source.id}?version=1`, asB)).statusCode,
    ).toBe(404);
    const review = await call('GET', `/api/v1/kb/review/facts?sourceId=${source.id}`, asB);
    expect(review.json().facts).toEqual([]);
  });
});
