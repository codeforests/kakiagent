import type { SourceFailure, SourceRecord } from '../../sources.js';
import { sourcesKey } from '../../sources.js';
import { openPdf } from './pdf.js';
import { MAX_FILE_BYTES, type FileDeps, type FileType } from './ports.js';
import { sniffType } from './sniff.js';

/** The file failures the safety checks give (KB-11; FEAT-015 §5.3). */
export type Rejection = Extract<
  SourceFailure,
  'upload_missing' | 'too_large' | 'malware' | 'unsupported_type' | 'encrypted' | 'unreadable'
>;

export type ScanOutcome =
  | { next: 'parse'; type: FileType; size: number; fileKey: string }
  | { next: 'failed'; failure: Rejection; signature?: string };

/**
 * The scan stage (KB-11; FEAT-015 §5.3): the upload in quarantine is checked before
 * anything reads it: size, malware, the type its bytes show, and encryption. A rejected
 * file is deleted from quarantine and never reaches the `sources` bucket; a clean one is
 * copied there and removed from quarantine. A scanner that can't answer throws
 * `ScannerUnavailableError` (the stage is retried). Writes nothing to the database: the
 * job records the outcome with the source.
 */
export async function scanFile(source: SourceRecord, files: FileDeps): Promise<ScanOutcome> {
  const key = source.uploadKey;
  if (!key) return { next: 'failed', failure: 'upload_missing' };
  const { store } = files;
  const fileKey = sourcesKey(source.tenantId, source.id);
  // A rejected file is deleted wherever it is (a crashed run may have copied it already).
  const reject = async (failure: Rejection, signature?: string): Promise<ScanOutcome> => {
    await store.delete('quarantine', key);
    await store.delete('sources', fileKey);
    return signature ? { next: 'failed', failure, signature } : { next: 'failed', failure };
  };

  const head = await store.head('quarantine', key);
  if (!head) {
    // Already moved by an earlier run of this stage that crashed before recording it.
    const stored = await store.head('sources', fileKey);
    if (!stored) return { next: 'failed', failure: 'upload_missing' };
  }
  if (head && head.size > MAX_FILE_BYTES) return reject('too_large');
  const bytes = head ? await store.get('quarantine', key) : await store.get('sources', fileKey);

  const verdict = await files.scanner.scan({ key, bytes });
  if (verdict.infected) return reject('malware', verdict.signature);
  const sniffed = sniffType(
    bytes,
    source.name,
    source.kind === 'spreadsheet' ? 'spreadsheet' : 'file',
  );
  if (!sniffed.ok) return reject(sniffed.failure);
  if (sniffed.type === 'pdf') {
    const pdf = await openPdf(bytes);
    if (!pdf.ok) return reject(pdf.failure);
    await pdf.close();
  }
  if (head) {
    await store.copyToSources(key, fileKey);
    await store.delete('quarantine', key);
  }
  return { next: 'parse', type: sniffed.type, size: bytes.length, fileKey };
}
