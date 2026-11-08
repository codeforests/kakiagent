/** The inbound email attachment scan (CHN-04, KB-11; FEAT-036 §5.2 step 4, AC-7). */
import { readFileSync } from 'node:fs';
import { startTestDatabase, TENANT_A, type TestDatabase } from '@kaki/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachmentKey,
  runAttachmentScan,
  ScannerUnavailableError,
  type AttachmentObjects,
  type MalwareScanner,
} from '../src/index.js';
import { makePdf } from './fixtures/pdf.js';

let tdb: TestDatabase;
let owner: pg.Client;
let conversationId: string;
let messageId: string;
/** Built from two halves so no checkout holds the EICAR string (FEAT-015 §5.9). */
const EICAR = new TextEncoder().encode(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62)]);

const quarantine = new Map<string, Uint8Array>();
const attachments = new Map<string, Uint8Array>();
const objects: AttachmentObjects = {
  async getQuarantine(key) {
    return quarantine.get(key) ?? null;
  },
  async copyToAttachments(from, to) {
    attachments.set(to, quarantine.get(from)!);
  },
  async deleteQuarantine(key) {
    quarantine.delete(key);
  },
};
const scanner: MalwareScanner = {
  async scan({ bytes }) {
    return Buffer.from(bytes).includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
      ? { infected: true, signature: 'Eicar-Test-Signature' }
      : { infected: false };
  },
};

async function attachment(name: string, bytes: Uint8Array) {
  const { rows } = await owner.query<{ id: string }>(
    `insert into email_attachments (tenant_id, conversation_id, message_id, name, size) values ($1, $2, $3, $4, $5) returning id`,
    [TENANT_A, conversationId, messageId, name, bytes.length],
  );
  const id = rows[0]!.id;
  quarantine.set(attachmentKey(TENANT_A, id), bytes);
  return id;
}
const row = async (id: string) =>
  (
    await owner.query(
      `select status, reject_reason, object_key, content_type from email_attachments where id = $1`,
      [id],
    )
  ).rows[0];

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await owner.query(
    `insert into channel_connections (tenant_id, kind, state, offline_mode, health) values ($1, 'email', 'live', 'hidden', 'ok')`,
    [TENANT_A],
  );
  conversationId = (
    await owner.query(
      `insert into conversations (tenant_id, channel, visitor_id) values ($1, 'email', gen_random_uuid()) returning id`,
      [TENANT_A],
    )
  ).rows[0].id;
  messageId = (
    await owner.query(
      `insert into messages (tenant_id, conversation_id, author, body) values ($1, $2, 'visitor', 'see attached') returning id`,
      [TENANT_A, conversationId],
    )
  ).rows[0].id;
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('runAttachmentScan (FEAT-036 §5.2 step 4)', () => {
  const deps = () => ({ zdb: tdb.zone('ingest'), objects, scanner });

  it('a PDF and a PNG come out clean, in the attachments bucket, out of quarantine', async () => {
    for (const [name, bytes, type] of [
      ['menu.pdf', makePdf([{ lines: ['Menu'] }]), 'application/pdf'],
      ['design.png', PNG, 'image/png'],
    ] as const) {
      const id = await attachment(name, bytes);
      expect(await runAttachmentScan(deps(), { tenantId: TENANT_A, attachmentId: id })).toBe(
        'clean',
      );
      const key = attachmentKey(TENANT_A, id);
      expect(await row(id)).toEqual({
        status: 'clean',
        reject_reason: null,
        object_key: key,
        content_type: type,
      });
      expect(attachments.has(key)).toBe(true);
      expect(quarantine.has(key)).toBe(false);
      // A redelivered job does nothing.
      expect(await runAttachmentScan(deps(), { tenantId: TENANT_A, attachmentId: id })).toBe(
        'already_done',
      );
    }
  });

  it('EICAR, a renamed executable and an encrypted PDF are rejected and never stored', async () => {
    const encrypted = readFileSync(new URL('./fixtures/protected.pdf', import.meta.url));
    for (const [name, bytes, reason] of [
      ['eicar.pdf', EICAR, 'unsupported_type'],
      ['invoice.pdf', EXE, 'unsupported_type'],
      ['locked.pdf', encrypted, 'encrypted'],
    ] as const) {
      const id = await attachment(name, bytes);
      expect(await runAttachmentScan(deps(), { tenantId: TENANT_A, attachmentId: id }), name).toBe(
        'rejected',
      );
      expect(await row(id), name).toEqual({
        status: 'rejected',
        reject_reason: reason,
        object_key: null,
        content_type: null,
      });
      expect(attachments.has(attachmentKey(TENANT_A, id)), name).toBe(false);
      expect(quarantine.has(attachmentKey(TENANT_A, id)), name).toBe(false);
    }
  });

  it('malware inside a real image is rejected as malware', async () => {
    const infected = Buffer.concat([PNG, Buffer.from(EICAR)]);
    const id = await attachment('photo.png', infected);
    expect(await runAttachmentScan(deps(), { tenantId: TENANT_A, attachmentId: id })).toBe(
      'rejected',
    );
    expect((await row(id)).reject_reason).toBe('malware');
  });

  it('a scanner outage leaves the attachment scanning for the retry', async () => {
    const id = await attachment('later.png', PNG);
    const down: MalwareScanner = {
      scan: async () => {
        throw new ScannerUnavailableError('clamd down');
      },
    };
    await expect(
      runAttachmentScan({ ...deps(), scanner: down }, { tenantId: TENANT_A, attachmentId: id }),
    ).rejects.toThrow(ScannerUnavailableError);
    expect((await row(id)).status).toBe('scanning');
    expect(quarantine.has(attachmentKey(TENANT_A, id))).toBe(true);
    expect(await runAttachmentScan(deps(), { tenantId: TENANT_A, attachmentId: id })).toBe('clean');
  });
});
