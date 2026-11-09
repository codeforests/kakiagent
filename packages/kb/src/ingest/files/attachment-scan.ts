/**
 * The scan of one inbound email attachment (CHN-04, KB-11; FEAT-036 §5.2 step 4, D9). The
 * receive step already refused anything over the limits or of the wrong sniffed type; here
 * the bytes are sniffed again, an encrypted PDF is refused and the malware scanner decides.
 * Clean bytes are copied to the attachments bucket; the quarantine copy is always removed.
 * A scanner outage throws `ScannerUnavailableError` and SQS retries the job.
 */
import { and, eq, schema, withTenant, type ZoneDb } from '@kaki/db';
import { openPdf } from './pdf.js';
import type { MalwareScanner } from './ports.js';
import { sniffType } from './sniff.js';

/** The quarantine and attachments buckets (S3 in the ingest-worker). */
export interface AttachmentObjects {
  getQuarantine(key: string): Promise<Uint8Array | null>;
  copyToAttachments(fromKey: string, toKey: string): Promise<void>;
  deleteQuarantine(key: string): Promise<void>;
}

export interface AttachmentScanDeps {
  /** The ingest zone (`app_ingest`). */
  zdb: ZoneDb;
  objects: AttachmentObjects;
  scanner: MalwareScanner;
}

export type AttachmentScanOutcome =
  'clean' | 'rejected' | 'not_found' | 'already_done' | 'missing_object';

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
};

/** `email/<tenant>/<attachment id>` in both buckets. */
export const attachmentKey = (tenantId: string, attachmentId: string) =>
  `email/${tenantId}/${attachmentId}`;

export async function runAttachmentScan(
  deps: AttachmentScanDeps,
  job: { tenantId: string; attachmentId: string },
): Promise<AttachmentScanOutcome> {
  const a = schema.emailAttachments;
  const where = and(eq(a.tenantId, job.tenantId), eq(a.id, job.attachmentId));
  const [row] = await withTenant(deps.zdb, job.tenantId, (tx) => tx.select().from(a).where(where));
  if (!row) return 'not_found';
  if (row.status !== 'scanning') return 'already_done';
  const key = attachmentKey(job.tenantId, job.attachmentId);
  const bytes = await deps.objects.getQuarantine(key);
  const reject = async (reason: 'unsupported_type' | 'encrypted' | 'malware') => {
    await withTenant(deps.zdb, job.tenantId, (tx) =>
      tx.update(a).set({ status: 'rejected', rejectReason: reason, objectKey: null }).where(where),
    );
    await deps.objects.deleteQuarantine(key);
    return 'rejected' as const;
  };
  if (!bytes) {
    await reject('unsupported_type');
    return 'missing_object';
  }
  const sniffed = sniffType(bytes, row.name);
  if (!sniffed.ok || !(sniffed.type in TYPES))
    return reject(
      !sniffed.ok && sniffed.failure === 'encrypted' ? 'encrypted' : 'unsupported_type',
    );
  if (sniffed.type === 'pdf') {
    const pdf = await openPdf(bytes);
    if (!pdf.ok) return reject(pdf.failure === 'encrypted' ? 'encrypted' : 'unsupported_type');
    await pdf.close();
  }
  // Throws ScannerUnavailableError while the scanner is down: the job is retried.
  const verdict = await deps.scanner.scan({ key, bytes });
  if (verdict.infected) return reject('malware');
  await deps.objects.copyToAttachments(key, key);
  await withTenant(deps.zdb, job.tenantId, (tx) =>
    tx
      .update(a)
      .set({ status: 'clean', objectKey: key, contentType: TYPES[sniffed.type]! })
      .where(where),
  );
  await deps.objects.deleteQuarantine(key);
  return 'clean';
}
