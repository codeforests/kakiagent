import { createHash } from 'node:crypto';
import { and, eq, schema, sql, withTenant, type ZoneDb } from '@kaki/db';
import { piiMask } from '@kaki/platform/pii-mask';
import type { SourceRecord } from '../../sources.js';
import { StaleRunError } from '../crawl.js';
import { parseFile } from './parse.js';
import type { FileDeps } from './ports.js';

export type ParseStageOutcome =
  { next: 'extract' } | { next: 'failed'; failure: 'unreadable' | 'no_text' };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The parse stage (KB-02; FEAT-015 §5.4): the clean file from the `sources` bucket becomes
 * the attempt's pages, masked (ADR-015), with the counts on the source, in one
 * transaction that first removes any pages a crashed run of this stage left. The extract
 * and promote stages then read them as they read a crawl's pages (D1). No included page →
 * `no_text`; a file that can't be read → `unreadable`. OCR errors are thrown (retried).
 */
export async function parseFileSource(
  zdb: ZoneDb,
  source: SourceRecord,
  files: FileDeps,
): Promise<ParseStageOutcome> {
  const { tenantId, id: sourceId, attempt } = source;
  if (!source.fileKey || !source.fileType) throw new Error('parse before a clean scan');
  const bytes = await files.store.get('sources', source.fileKey);
  const parsed = await parseFile(bytes, source.fileType, files);
  if (!parsed.ok) return { next: 'failed', failure: parsed.failure };

  const rows = parsed.pages.map((page, seq) => {
    const content = page.text === null ? null : piiMask(page.text);
    return {
      tenantId,
      sourceId,
      attempt,
      seq,
      url: page.url,
      title: null,
      status: page.status,
      reason: page.reason,
      content,
      contentHash: content === null ? null : sha256(content),
      ocrConfidence: page.ocrConfidence,
    };
  });
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const included = count('included');
  const p = schema.kbSourcePages;
  await withTenant(zdb, tenantId, async (tx) => {
    const [row] = await tx
      .select({ attempt: schema.kbSources.attempt, status: schema.kbSources.status })
      .from(schema.kbSources)
      .where(and(eq(schema.kbSources.tenantId, tenantId), eq(schema.kbSources.id, sourceId)))
      .for('update');
    if (!row || row.attempt !== attempt || row.status !== 'processing')
      throw new StaleRunError('source changed');
    await tx
      .delete(p)
      .where(and(eq(p.tenantId, tenantId), eq(p.sourceId, sourceId), eq(p.attempt, attempt)));
    for (let i = 0; i < rows.length; i += 500) await tx.insert(p).values(rows.slice(i, i + 500));
    await tx
      .update(schema.kbSources)
      .set({
        pagesFound: rows.length,
        pagesIncluded: included,
        pagesExcluded: count('excluded'),
        pagesSkipped: count('skipped'),
        ocrPages: rows.filter((r) => r.status === 'included' && r.ocrConfidence !== null).length,
        updatedAt: sql`now()`,
      })
      .where(and(eq(schema.kbSources.tenantId, tenantId), eq(schema.kbSources.id, sourceId)));
  });
  return included ? { next: 'extract' } : { next: 'failed', failure: 'no_text' };
}
