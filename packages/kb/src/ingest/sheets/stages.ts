import { createHash } from 'node:crypto';
import { and, asc, eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit } from '@kaki/governance';
import { piiMask } from '@kaki/platform/pii-mask';
import { entityKey } from '../../conflicts.js';
import { sgDateOf } from '../../dates.js';
import type { SourceRecord } from '../../sources.js';
import type { GstTreatment } from '../../types.js';
import { StaleRunError } from '../crawl.js';
import { DEFAULT_FILE_LIMITS, type FileDeps } from '../files/ports.js';
import { readCsv } from './csv.js';
import { mapRows } from './rows.js';
import { suggestMapping, type ColumnMapping, type Suggestion } from './suggest.js';
import { tableOf, type SheetColumn, type SheetRow } from './table.js';
import { readXlsx } from './xlsx.js';

/** `kb_sources.sheet`: what the parse found (FEAT-016 §4). */
export interface SheetRecord {
  name: string | null;
  headerRow: number;
  rows: number;
  rowsSkipped: number;
  columns: SheetColumn[];
  suggested: Suggestion;
}

/** `kb_sources.mapping`: the owner's confirmation, the import's approval (D5). */
export interface MappingRecord {
  columns: ColumnMapping;
  gst: GstTreatment;
  confirmedBy: string;
  confirmedAt: string;
}

export type SheetParseOutcome =
  | { next: 'map' | 'import'; rows: number; columns: number }
  | { next: 'failed'; failure: 'unreadable' | 'no_rows' };

export type ImportOutcome =
  | { next: 'promote'; importable: number; rejected: number }
  | { next: 'failed'; failure: 'no_valid_rows' };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** A row's passage: its cells joined, as the review and conflict cards quote it. */
export const rowContent = (cells: string[]) =>
  cells
    .filter((c) => c !== '')
    .join(' | ')
    .replace(/\s+/g, ' ');

const ofSource = (s: SourceRecord) =>
  and(eq(schema.kbSources.tenantId, s.tenantId), eq(schema.kbSources.id, s.id));

/** Locks the source and checks this run still owns it (retry and delete change it). */
async function lockRun(tx: Tx, source: SourceRecord) {
  const [row] = await tx
    .select({ attempt: schema.kbSources.attempt, status: schema.kbSources.status })
    .from(schema.kbSources)
    .where(ofSource(source))
    .for('update');
  if (!row || row.attempt !== source.attempt || row.status !== 'processing')
    throw new StaleRunError('source changed');
}

/**
 * The parse stage for a spreadsheet (KB-03; FEAT-016 §5.3): the clean file from `sources`
 * read as XLSX or CSV, its table found, its cells masked (ADR-015), one page per data row
 * (`row/<n>`) and the layout with a suggested mapping stored, in one transaction that
 * first removes a crashed run's rows. The job then waits at `map` for the owner, or goes
 * on to `import` when a mapping is already confirmed (a retry, D6).
 */
export async function parseSheetSource(
  zdb: ZoneDb,
  source: SourceRecord,
  files: FileDeps,
): Promise<SheetParseOutcome> {
  if (!source.fileKey || !source.fileType) throw new Error('parse before a clean scan');
  const bytes = await files.store.get('sources', source.fileKey);
  let read: SheetRow[];
  let name: string | null = null;
  if (source.fileType === 'xlsx') {
    const x = readXlsx(bytes);
    if (!x.ok) return { next: 'failed', failure: x.failure };
    read = x.rows;
    name = x.name;
  } else {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { next: 'failed', failure: 'unreadable' };
    }
    read = readCsv(text);
  }
  const limit = { ...DEFAULT_FILE_LIMITS, ...files.limits }.sheetRows;
  const table = tableOf(read, { rowLimit: limit, mask: piiMask });
  if (!table) return { next: 'failed', failure: 'no_rows' };
  const sheet: SheetRecord = {
    name,
    headerRow: table.headerRow,
    rows: table.rows.length,
    rowsSkipped: table.rowsSkipped,
    columns: table.columns,
    suggested: suggestMapping(table.columns, table.rows),
  };
  const { tenantId, id: sourceId, attempt } = source;
  const pages = table.rows.map((r, seq) => {
    const content = rowContent(r.cells);
    return {
      tenantId,
      sourceId,
      attempt,
      seq,
      url: `row/${r.row}`,
      title: null,
      status: 'included' as const,
      reason: null,
      content,
      contentHash: sha256(content),
      cells: r.cells,
    };
  });
  const p = schema.kbSourcePages;
  await withTenant(zdb, tenantId, async (tx) => {
    await lockRun(tx, source);
    await tx
      .delete(p)
      .where(and(eq(p.tenantId, tenantId), eq(p.sourceId, sourceId), eq(p.attempt, attempt)));
    for (let i = 0; i < pages.length; i += 500) await tx.insert(p).values(pages.slice(i, i + 500));
    await tx
      .update(schema.kbSources)
      .set({
        sheet,
        pagesFound: pages.length,
        pagesIncluded: pages.length,
        pagesSkipped: table.rowsSkipped,
        updatedAt: sql`now()`,
      })
      .where(ofSource(source));
    await audit.append(tx, tenantId, {
      action: 'kb_source.parsed',
      actorType: 'system',
      actorId: 'ingest-worker',
      subjectType: 'kb_source',
      subjectId: sourceId,
      payload: { rows: pages.length, columns: table.columns.length },
    });
  });
  return {
    next: source.mapping ? 'import' : 'map',
    rows: pages.length,
    columns: table.columns.length,
  };
}

/** The attempt's rows, in sheet order, as `mapRows` takes them. */
export async function sheetRows(tx: Tx, source: Pick<SourceRecord, 'tenantId' | 'id' | 'attempt'>) {
  const p = schema.kbSourcePages;
  const rows = await tx
    .select({ id: p.id, url: p.url, content: p.content, cells: p.cells })
    .from(p)
    .where(
      and(
        eq(p.tenantId, source.tenantId),
        eq(p.sourceId, source.id),
        eq(p.attempt, source.attempt),
      ),
    )
    .orderBy(asc(p.seq));
  return rows.map((r) => ({
    id: r.id,
    content: r.content ?? '',
    row: Number(r.url.slice('row/'.length)),
    cells: r.cells ?? [],
  }));
}

/**
 * The import stage (FEAT-016 §5.7): the confirmed mapping applied to the attempt's rows
 * by the same `mapRows` the preview ran (D4). In one transaction every row gets its
 * result (rejections `failed` with the reason; empty and repeated rows `excluded`) and
 * each importable row a staged fact quoting the whole row, for the promote stage.
 */
export async function importSheetRows(zdb: ZoneDb, source: SourceRecord): Promise<ImportOutcome> {
  const mapping = source.mapping as MappingRecord | null;
  if (!mapping) throw new Error('import before a confirmed mapping');
  const { tenantId, id: sourceId, attempt } = source;
  return withTenant(zdb, tenantId, async (tx) => {
    await lockRun(tx, source);
    const rows = await sheetRows(tx, source);
    const outcomes = mapRows(rows, mapping.columns, mapping.gst, {
      asOf: sgDateOf(new Date(mapping.confirmedAt)),
    });
    const importable = outcomes.filter((o) => o.input !== null).length;
    if (!importable) return { next: 'failed', failure: 'no_valid_rows' } as const;
    const st = schema.kbStagedFacts;
    await tx.delete(st).where(and(eq(st.tenantId, tenantId), eq(st.sourceId, sourceId)));
    // Set-based: one update for every row's result, then the staging in batches.
    const results = outcomes.map((o, i) => ({
      id: rows[i]!.id,
      status: o.status,
      reason: o.reason,
    }));
    for (let i = 0; i < results.length; i += 500) {
      const batch = results.slice(i, i + 500);
      await tx.execute(sql`
        update kb_source_pages p set status = r.status, reason = r.reason,
               facts_count = case when r.status = 'included' then 1 else 0 end,
               extracted_at = now()
        from (values ${sql.join(
          batch.map((r) => sql`(${r.id}::uuid, ${r.status}, ${r.reason})`),
          sql`, `,
        )}) as r(id, status, reason)
        where p.tenant_id = ${tenantId} and p.id = r.id`);
    }
    const staged = outcomes.flatMap((o, i) =>
      o.input
        ? [
            {
              tenantId,
              sourceId,
              attempt,
              pageId: rows[i]!.id,
              type: 'product' as const,
              value: o.input.value,
              gstTreatment: o.input.gstTreatment,
              quote: rows[i]!.content,
              quoteStart: 0,
              quoteEnd: rows[i]!.content.length,
              confidence: 1,
              dedupeKey: entityKey(o.input),
            },
          ]
        : [],
    );
    for (let i = 0; i < staged.length; i += 500)
      await tx.insert(st).values(staged.slice(i, i + 500));
    const count = (s: string) => outcomes.filter((o) => o.status === s).length;
    await tx
      .update(schema.kbSources)
      .set({
        pagesIncluded: importable,
        pagesFailed: count('failed'),
        pagesExcluded: count('excluded'),
        pagesExtracted: importable,
        updatedAt: sql`now()`,
      })
      .where(ofSource(source));
    return { next: 'promote', importable, rejected: count('failed') } as const;
  });
}
