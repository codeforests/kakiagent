import { and, eq, schema, sql } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import { planPromotion } from './conflicts.js';
import type { DashboardKbContext } from './context.js';
import { sgDateOf } from './dates.js';
import { InvalidStateError, SourceNotFoundError, VersionConflictError } from './errors.js';
import { centsText } from './ingest/sheets/money.js';
import { existingFacts } from './ingest/promote.js';
import { checkMapping, mapRows, type RowOutcome } from './ingest/sheets/rows.js';
import { sheetRows, type MappingRecord, type SheetRecord } from './ingest/sheets/stages.js';
import type { ColumnMapping } from './ingest/sheets/suggest.js';
import { enqueueStage, type SourceRecord } from './sources.js';
import type { GstTreatment } from './types.js';

export interface ImportChoice {
  mapping: ColumnMapping;
  gst: GstTreatment;
}

export interface PreviewRowRecord {
  row: number;
  cells: string[];
  reason: RowOutcome['reason'];
  fact: {
    name: string;
    price: string;
    unit: string | null;
    sku: string | null;
    stock: number | null;
  } | null;
  conflict: boolean;
}

export interface ImportPreviewRecord {
  rows: number;
  importable: number;
  rejected: number;
  empty: number;
  duplicates: number;
  existing: number;
  conflicts: number;
  gstReview: number;
  sample: PreviewRowRecord[];
  rejects: PreviewRowRecord[];
}

/** The preview shows this many rows to import, and at most this many rejections (§3.1). */
export const PREVIEW_SAMPLE = 20;
export const PREVIEW_REJECTS = 500;

const ofSource = (ctx: DashboardKbContext, id: string) =>
  and(eq(schema.kbSources.tenantId, ctx.tenantId), eq(schema.kbSources.id, id));

/** A spreadsheet waiting at `map`, or `InvalidStateError` (FEAT-016 §5.6). */
function waiting(source: SourceRecord | undefined): SourceRecord & { sheet: SheetRecord } {
  if (!source || source.kind !== 'spreadsheet') throw new SourceNotFoundError('source not found');
  if (source.status !== 'queued' || source.stage !== 'map' || !source.sheet)
    throw new InvalidStateError(`a ${source.status} spreadsheet at ${source.stage ?? 'no stage'}`);
  return source as SourceRecord & { sheet: SheetRecord };
}

async function outcomesOf(
  ctx: DashboardKbContext,
  source: SourceRecord & { sheet: SheetRecord },
  choice: ImportChoice,
) {
  checkMapping(source.sheet.columns.length, choice.mapping);
  const rows = await sheetRows(ctx.tx, source);
  const outcomes = mapRows(rows, choice.mapping, choice.gst, { asOf: sgDateOf(new Date()) });
  return { rows, outcomes };
}

/**
 * What confirming this mapping would import (KB-03; FEAT-016 §5.6, D4): the rows' results
 * by the same `mapRows` the import runs, and, against the tenant's facts as they are now,
 * how many rows the KB already has and how many would be written conflicted (KB-06), and
 * how many prices would wait for their GST treatment (KB-15). Writes nothing.
 */
export async function previewImport(
  ctx: DashboardKbContext,
  id: string,
  choice: ImportChoice,
): Promise<ImportPreviewRecord> {
  const [row] = await ctx.tx.select().from(schema.kbSources).where(ofSource(ctx, id));
  const source = waiting(row);
  const { rows, outcomes } = await outcomesOf(ctx, source, choice);
  const candidates = outcomes.flatMap((o, i) => (o.input ? [{ input: o.input, i }] : []));
  const plan = planPromotion(candidates, await existingFacts(ctx.tx, ctx.tenantId, ['product']));
  const conflicted = new Set(
    plan.insert.filter((x) => x.status === 'conflicted').map((x) => x.candidate.i),
  );
  const [profile] = await ctx.tx
    .select({ gstRegistered: schema.businessProfiles.gstRegistered })
    .from(schema.businessProfiles)
    .where(eq(schema.businessProfiles.tenantId, ctx.tenantId));
  // No profile yet counts as registered, as `visitor_facts` does (KB-15).
  const registered = profile?.gstRegistered ?? true;
  const toRow = (o: RowOutcome, i: number): PreviewRowRecord => ({
    row: o.row,
    cells: rows[i]!.cells,
    reason: o.reason,
    fact: o.input
      ? {
          name: o.input.value.name,
          price: centsText(o.input.value.priceCents),
          unit: o.input.value.unit ?? null,
          sku: o.input.value.sku ?? null,
          stock: o.input.value.stock ?? null,
        }
      : null,
    conflict: conflicted.has(i),
  });
  const count = (reason: RowOutcome['reason']) =>
    outcomes.filter((o) => o.reason === reason).length;
  const importable = candidates.length;
  return {
    rows: rows.length,
    importable,
    rejected: outcomes.filter((o) => o.status === 'failed').length,
    empty: count('empty_row'),
    duplicates: count('duplicate'),
    existing: importable - plan.insert.length,
    conflicts: conflicted.size,
    gstReview: choice.gst === 'unknown' && registered ? plan.insert.length : 0,
    sample: candidates.slice(0, PREVIEW_SAMPLE).map(({ i }) => toRow(outcomes[i]!, i)),
    rejects: outcomes
      .map((o, i) => [o, i] as const)
      .filter(([o]) => o.status === 'failed')
      .slice(0, PREVIEW_REJECTS)
      .map(([o, i]) => toRow(o, i)),
  };
}

/**
 * Confirms a spreadsheet's mapping (KB-03, KB-16; FEAT-016 §5.6, D5): the owner's
 * approval of the import, recorded on the source and in the audit log, with the import
 * job in the same transaction. With no row valid under the mapping the source fails
 * `no_valid_rows` instead (UC-10 5a); Retry brings it back to the mapping.
 */
export async function confirmImport(
  ctx: DashboardKbContext,
  id: string,
  choice: ImportChoice & { version: number },
): Promise<SourceRecord> {
  const [row] = await ctx.tx.select().from(schema.kbSources).where(ofSource(ctx, id)).for('update');
  if (row && row.kind === 'spreadsheet' && row.version !== choice.version)
    throw new VersionConflictError('stale version');
  const source = waiting(row);
  const { rows, outcomes } = await outcomesOf(ctx, source, choice);
  const importable = outcomes.filter((o) => o.input).length;
  const mapping: MappingRecord = {
    columns: choice.mapping,
    gst: choice.gst,
    confirmedBy: ctx.userId,
    confirmedAt: new Date().toISOString(),
  };
  const [updated] = await ctx.tx
    .update(schema.kbSources)
    .set(
      importable
        ? { mapping, stage: 'import', updatedAt: sql`now()`, version: source.version + 1 }
        : {
            status: 'failed',
            stage: null,
            failure: 'no_valid_rows',
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
            version: source.version + 1,
          },
    )
    .where(ofSource(ctx, id))
    .returning();
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'kb_source.import_confirmed',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'kb_source',
    subjectId: id,
    payload: {
      rows: rows.length,
      importable,
      rejected: outcomes.filter((o) => o.status === 'failed').length,
      gst: auditCode(choice.gst),
    },
  });
  if (importable) await enqueueStage(ctx.tx, updated!, 'import');
  return updated!;
}
