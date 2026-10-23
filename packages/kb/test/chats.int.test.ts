import { sql, withTenant } from '@kaki/db';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import {
  createFakeProvider,
  createGateway,
  defaultRegistry,
  type LlmGateway,
} from '@kaki/llm-gateway';
import { strToU8 } from 'fflate';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  approveFact,
  createFileSource,
  dashboardKb,
  deleteSource,
  fakeExtractScript,
  fakeMineScript,
  NotRetryableError,
  quarantineKey,
  rejectFact,
  retrySource,
  runIngestJob,
  type Bucket,
  type FileDeps,
  type FileStore,
  type IngestJobBody,
} from '../src/index.js';
import {
  CHAT_PII,
  NOT_A_CHAT_JSON,
  NOT_A_CHAT_TXT,
  TELEGRAM_FULL,
  WHATSAPP_ANDROID,
  WHATSAPP_IOS_ZIP,
  WHATSAPP_QUESTIONS,
} from './fixtures/chats.js';

let tdb: TestDatabase;
let owner: pg.Client;
const USER = 'user-owner-1';
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
});

/** Built from two halves so no checkout holds the EICAR string (FEAT-015 §5.9). */
const EICAR = strToU8('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

/** The zip with every entry marked encrypted (general-purpose flag bit 0). */
function encryptedZip(zip: Uint8Array): Uint8Array {
  const b = zip.slice();
  const view = new DataView(b.buffer);
  for (let at = 0; at + 8 < b.length; at++) {
    const sig = view.getUint32(at, true);
    if (sig === 0x04034b50) view.setUint16(at + 6, view.getUint16(at + 6, true) | 1, true);
    if (sig === 0x02014b50) view.setUint16(at + 8, view.getUint16(at + 8, true) | 1, true);
  }
  return b;
}

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
    throw new Error('a chat export is never OCR’d');
  });
  const deps: FileDeps = {
    store,
    scanner: {
      scan: vi.fn(async ({ bytes }: { bytes: Uint8Array }) =>
        Buffer.from(bytes).includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
          ? { infected: true as const, signature: 'Eicar-Test-Signature' }
          : { infected: false as const },
      ),
    },
    ocr: { recognize: never },
    rasterizer: { render: never },
  };
  return { deps, buckets };
}

/** The worker's fake provider: chat parts go to the miner, pages to the extractor. */
const fakeLlm = () =>
  createGateway(defaultRegistry('fake'), [
    createFakeProvider((req) =>
      req.model === 'mine' ? fakeMineScript(req) : fakeExtractScript(req),
    ),
  ]);
function mineDown(): LlmGateway {
  const llm = fakeLlm();
  return Object.assign(Object.create(llm) as LlmGateway, {
    generate: async () => {
      throw new Error('model down');
    },
  });
}

async function addChat(
  files: ReturnType<typeof memFiles>,
  bytes: Uint8Array,
  fileName = 'WhatsApp Chat with Mdm Tan.txt',
  businessNames = ['Kaki Bakery'],
) {
  const uploadId = `00000000-0000-4000-8000-${String(++uploads).padStart(12, '0')}`;
  files.buckets.quarantine.set(quarantineKey(TENANT_A, uploadId), bytes);
  return withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
    createFileSource(
      dashboardKb(tx, TENANT_A, USER),
      { uploadId, fileName, sizeBytes: bytes.length, kind: 'chat', businessNames },
      { fileLimit: 50 },
    ),
  );
}

async function drain(
  s: { id: string },
  files: ReturnType<typeof memFiles>,
  opts: { llm?: LlmGateway; receiveCount?: number } = {},
) {
  const outcomes: unknown[] = [];
  for (let i = 0; i < 10; i++) {
    const { rows } = await owner.query(
      `update outbox set dispatched_at = now() where id = (
         select id from outbox where group_key = $1 and dispatched_at is null order by created_at limit 1)
       returning payload`,
      [s.id],
    );
    if (!rows[0]) break;
    const job = rows[0].payload as IngestJobBody;
    try {
      outcomes.push(
        await runIngestJob(
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
        ),
      );
    } catch (err) {
      outcomes.push({ thrown: (err as Error).message });
      break;
    }
  }
  return outcomes;
}

const sourceRow = async (id: string) =>
  (await owner.query(`select * from kb_sources where id = $1`, [id])).rows[0];
const auditOf = async (id: string) =>
  (
    await owner.query(
      `select event_type, payload from audit_entries where split_part(subject_refs[1], ':', 2) = $1 order by seq`,
      [id],
    )
  ).rows as { event_type: string; payload: Record<string, unknown> }[];

/** Every text a chat import can store, for the PII check (AC-3). */
async function everythingStored(): Promise<string> {
  const q = async (text: string) =>
    (await owner.query(text)).rows.map((r) => JSON.stringify(r)).join('\n');
  return [
    await q(`select name, chat, upload_key from kb_sources`),
    await q(`select url, title, content from kb_source_pages`),
    await q(`select value, quote from kb_staged_facts`),
    await q(`select value, provenance from facts`),
    await q(`select value from fact_versions`),
    await q(`select content from kb_chunks`),
    await q(`select payload from audit_entries`),
    await q(`select payload from outbox`),
  ].join('\n');
}

describe('chat import pipeline (FEAT-017 T6)', () => {
  it('reads a WhatsApp export to needs_review FAQs, redacted, with the export deleted (AC-3, AC-5)', async () => {
    const files = memFiles();
    const s = await addChat(files, strToU8(WHATSAPP_ANDROID));
    expect(s.name).toBe('Chat export');
    const outcomes = await drain(s, files);
    expect(outcomes.at(-1)).toMatchObject({ result: 'ready' });
    expect(files.buckets.quarantine.size).toBe(0);
    expect(files.buckets.sources.size).toBe(0); // never copied out of quarantine

    const row = await sourceRow(s.id);
    expect(row).toMatchObject({ status: 'ready', file_type: 'txt', file_key: null });
    expect(row.name).toBe('WhatsApp chat, 13–18 Oct 2026');
    expect(row.chat).toMatchObject({
      format: 'whatsapp',
      from: '2026-10-13',
      to: '2026-10-18',
      conversations: 1,
      exchanges: 8,
      messagesSkipped: 0,
      redacted: { phones: 2, emails: 1, ids: 1, addresses: 3 },
    });
    expect(row.chat.redacted.names).toBeGreaterThanOrEqual(3);
    expect(row.chat.exportDeletedAt).toEqual(expect.any(String));

    const pages = (
      await owner.query(`select url, title, content from kb_source_pages order by seq`)
    ).rows;
    expect(pages[0].url).toBe('chat/1');
    expect(pages[0].content).toContain('Customer: Hi, do you deliver to Jurong?');
    expect(pages[0].content).toContain('Business: Hi [name]! Yes, we deliver island-wide for S$8.');
    expect(pages[0].content).toContain('Customer: My number is [phone], email [email]');

    const facts = (
      await owner.query(
        `select type, status, source, value, provenance from facts order by value->>'question'`,
      )
    ).rows;
    expect(facts.map((f) => f.value.question).sort()).toEqual([...WHATSAPP_QUESTIONS].sort());
    for (const f of facts) {
      expect(f).toMatchObject({ type: 'faq', status: 'needs_review', source: 'chat' });
      expect(f.provenance.url).toMatch(/^chat\/\d+$/);
    }
    const sunday = facts.find((f) => f.value.question.includes('Sunday'))!;
    expect(sunday.value.answer).toBe('Sundays 9am to 5pm, closed on public holidays.');

    // KB-04: none of the customer's personal data, nor the file name, is stored anywhere.
    const stored = await everythingStored();
    for (const pii of CHAT_PII) expect(stored, pii).not.toContain(pii);

    expect((await auditOf(s.id)).map((a) => a.event_type)).toEqual([
      'kb_source.created',
      'kb_source.scanned',
      'kb_source.parsed',
      'kb_source.export_deleted',
      'kb_source.promoted',
    ]);

    // Never live without review; approving one makes it visible, rejecting removes one.
    const visible = () =>
      withTenant(tdb.zone('visitor'), TENANT_A, async (tx) =>
        (
          await tx.execute<{ q: string }>(
            sql`select value->>'question' as q from visitor_facts where type = 'faq'`,
          )
        ).rows.map((r) => r.q),
      );
    expect(await visible()).toEqual([]);
    const ids = (await owner.query(`select id, version, value from facts`)).rows;
    const halal = ids.find((f) => f.value.question.includes('halal'))!;
    const keep = ids.find((f) => f.value.question.includes('keep'))!;
    await withTenant(tdb.zone('dashboard'), TENANT_A, async (tx) => {
      const ctx = dashboardKb(tx, TENANT_A, USER);
      await approveFact(ctx, halal.id, halal.version);
      await rejectFact(ctx, keep.id, keep.version);
    });
    expect(await visible()).toEqual(['Is the pandan chiffon halal?']);
  });

  it('reads an iOS zip and a Telegram full export (AC-3)', async () => {
    const files = memFiles();
    const zip = await addChat(files, WHATSAPP_IOS_ZIP, 'WhatsApp Chat - Ah Kow.zip');
    expect((await drain(zip, files)).at(-1)).toMatchObject({ result: 'ready', facts: 1 });
    expect(await sourceRow(zip.id)).toMatchObject({ file_type: 'zip', status: 'ready' });

    const tg = await addChat(files, strToU8(TELEGRAM_FULL), 'result.json', ['nobody here']);
    expect((await drain(tg, files)).at(-1)).toMatchObject({ result: 'ready', facts: 1 });
    const row = await sourceRow(tg.id);
    expect(row.chat).toMatchObject({ format: 'telegram', conversations: 1, exchanges: 1 });
    expect(row.name).toBe('Telegram chat, 13 Oct 2026');
    const stored = await everythingStored();
    for (const pii of CHAT_PII) expect(stored, pii).not.toContain(pii);
    expect(files.buckets.quarantine.size).toBe(0);
  });

  it('checks a chat export for malware and never copies it to the sources bucket (AC-2)', async () => {
    const files = memFiles();
    const virus = await addChat(files, EICAR, 'chat.txt');
    expect((await drain(virus, files)).at(-1)).toMatchObject({
      result: 'failed',
      failure: 'malware',
    });
    expect(await sourceRow(virus.id)).toMatchObject({ status: 'failed', failure: 'malware' });
    expect((await owner.query(`select count(*)::int as n from kb_source_pages`)).rows[0].n).toBe(0);

    const locked = await addChat(files, encryptedZip(WHATSAPP_IOS_ZIP), 'chat.zip');
    expect((await drain(locked, files)).at(-1)).toMatchObject({
      result: 'failed',
      failure: 'encrypted',
    });

    const clean = await addChat(files, strToU8(WHATSAPP_ANDROID));
    expect((await drain(clean, files)).at(-1)).toMatchObject({ result: 'ready' });
    expect(files.deps.scanner.scan).toHaveBeenCalledTimes(3);
    expect(files.buckets.sources.size).toBe(0);
    expect(files.buckets.quarantine.size).toBe(0);
    expect((await sourceRow(clean.id)).file_key).toBeNull();
  });

  it('fails a file that is no chat, or has no message from the business, deleting it (AC-6)', async () => {
    const files = memFiles();
    const prose = await addChat(files, strToU8(NOT_A_CHAT_TXT), 'notice.txt');
    expect((await drain(prose, files)).at(-1)).toEqual({
      result: 'failed',
      failure: 'chat_format',
    });
    const json = await addChat(files, strToU8(NOT_A_CHAT_JSON), 'result.json');
    expect((await drain(json, files)).at(-1)).toEqual({ result: 'failed', failure: 'chat_format' });
    const wrong = await addChat(files, strToU8(WHATSAPP_ANDROID), 'chat.txt', ['Other Shop']);
    expect((await drain(wrong, files)).at(-1)).toEqual({
      result: 'failed',
      failure: 'business_not_found',
    });
    const pdf = await addChat(files, strToU8('%PDF-1.7\n'), 'chat.txt');
    expect((await drain(pdf, files)).at(-1)).toEqual({
      result: 'failed',
      failure: 'unsupported_type',
    });
    expect(files.buckets.quarantine.size).toBe(0);
    expect((await owner.query(`select count(*)::int as n from kb_source_pages`)).rows[0].n).toBe(0);
    for (const s of [prose, wrong]) {
      const row = await sourceRow(s.id);
      await expect(
        withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
          retrySource(dashboardKb(tx, TENANT_A, USER), s.id, row.version),
        ),
      ).rejects.toBeInstanceOf(NotRetryableError);
    }
  });

  it('retries a failed mining from the kept parts after the export is gone (AC-7)', async () => {
    const files = memFiles();
    const s = await addChat(files, strToU8(WHATSAPP_ANDROID));
    const outcomes = await drain(s, files, { llm: mineDown(), receiveCount: 5 });
    expect(outcomes.at(-1)).toEqual({ result: 'failed', failure: 'extraction_unavailable' });
    expect(files.buckets.quarantine.size).toBe(0);
    expect((await owner.query(`select count(*)::int as n from facts`)).rows[0].n).toBe(0);
    const failed = await sourceRow(s.id);
    const parts = failed.pages_found;
    expect(parts).toBeGreaterThan(0);

    const retried = await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      retrySource(dashboardKb(tx, TENANT_A, USER), s.id, failed.version),
    );
    expect(retried).toMatchObject({ stage: 'extract', attempt: 2, pagesFound: parts });
    expect((await drain(s, files)).at(-1)).toMatchObject({ result: 'ready', facts: 4 });
    const pages = (await owner.query(`select distinct attempt from kb_source_pages`)).rows;
    expect(pages).toEqual([{ attempt: 2 }]);
  });

  it('resumes after a crash between the delete and the stage change; stale jobs do nothing (AC-7)', async () => {
    const files = memFiles();
    const s = await addChat(files, strToU8(WHATSAPP_ANDROID));
    await drain(s, files);
    // Run the parse again as if its job crashed after deleting the export: the parts are
    // stored, the export is gone, and the deletion isn't recorded yet.
    await owner.query(
      `update kb_sources set stage = 'parse', status = 'queued', chat = chat - 'exportDeletedAt' where id = $1`,
      [s.id],
    );
    const job = { tenantId: TENANT_A, sourceId: s.id, attempt: 1, stage: 'parse' as const };
    await owner.query(
      `insert into outbox (tenant_id, topic, group_key, payload) values ($1, 'ingest', $2, $3)`,
      [TENANT_A, s.id, JSON.stringify(job)],
    );
    expect(files.buckets.quarantine.size).toBe(0);
    const outcomes = await drain(s, files);
    expect(outcomes[0]).toEqual({ result: 'next', stage: 'extract' });
    expect(outcomes.at(-1)).toMatchObject({ result: 'ready' });
    expect((await sourceRow(s.id)).chat.exportDeletedAt).toEqual(expect.any(String));
    await owner.query(
      `insert into outbox (tenant_id, topic, group_key, payload) values ($1, 'ingest', $2, $3)`,
      [TENANT_A, s.id, JSON.stringify(job)],
    );
    expect(await drain(s, files)).toEqual([{ result: 'stale' }]);
  });

  it('deletes a chat source with its parts and suggestions, purging the quarantine key (AC-7)', async () => {
    const files = memFiles();
    const s = await addChat(files, strToU8(WHATSAPP_ANDROID));
    await drain(s, files);
    const row = await sourceRow(s.id);
    await withTenant(tdb.zone('dashboard'), TENANT_A, (tx) =>
      deleteSource(dashboardKb(tx, TENANT_A, USER), s.id, row.version),
    );
    const n = async (t: string) =>
      (await owner.query(`select count(*)::int as n from ${t}`)).rows[0].n;
    expect(await n('kb_sources')).toBe(0);
    expect(await n('kb_source_pages')).toBe(0);
    expect(await n(`facts where status <> 'deleted'`)).toBe(0);
    const purge = (
      await owner.query(`select payload from outbox where payload->>'stage' = 'purge'`)
    ).rows[0].payload;
    expect(purge.keys.quarantine).toBe(row.upload_key);
  });
});
