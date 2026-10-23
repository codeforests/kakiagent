import { and, desc, eq, getTableColumns, schema, sql } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import type { PreparedChunk } from './chunk.js';
import { entityKey, inputOf } from './conflicts.js';
import type { DashboardKbContext } from './context.js';
import {
  FactNotFoundError,
  InvalidCursorError,
  InvalidFactError,
  InvalidStateError,
  VersionConflictError,
} from './errors.js';
import {
  NO_VALIDITY,
  type FactInput,
  type FaqValue,
  type GstTreatment,
  type PolicyValue,
  type ProductValue,
  type PromotionValue,
  type Validity,
} from './types.js';
import { settleConflicts } from './writes.js';

export type { FactInput };

export type FactStatus = (typeof schema.FACT_STATUSES)[number];
export type FactType = (typeof schema.FACT_TYPES)[number];

/** Where an extracted fact was found (KB-05; FEAT-012 §3.1). */
export interface Provenance {
  url: string;
  title: string | null;
  quote: string;
  start: number;
  end: number;
}

/** A file's pages, slides, parts or image (FEAT-015); a spreadsheet's rows (FEAT-016). */
export type FileUnit = 'page' | 'slide' | 'part' | 'image' | 'row';

/** A file page's locator, `page/3`, `slide/2`, `part/1` or `image/1` (FEAT-015 §3.1). */
export const fileLocator = (unit: FileUnit, number: number) => `${unit}/${number}`;

/** The file location a page locator names, or null for a web page's URL. */
export function locationOf(url: string): { unit: FileUnit; number: number } | null {
  const m = /^(page|slide|part|image|row)\/([1-9]\d{0,6})$/.exec(url);
  return m ? { unit: m[1] as FileUnit, number: Number(m[2]) } : null;
}

export type FactRecord = FactInput & {
  id: string;
  status: FactStatus;
  version: number;
  source: string;
  updatedAt: Date;
  validity: Validity;
  /** Extracted facts only (FEAT-012); null for facts entered by hand. */
  sourceId: string | null;
  confidence: number | null;
  provenance: Provenance | null;
};

export interface FactPatch {
  /** The version the client loaded; a mismatch is a conflict. */
  version: number;
  value?: ProductValue | FaqValue | PolicyValue | PromotionValue | undefined;
  gstTreatment?: GstTreatment | null | undefined;
  /** Promotions only; a field left undefined keeps its current value. */
  validity?: Partial<Validity> | undefined;
  status?: 'approved' | 'disabled' | undefined;
}

export interface FactFilter {
  status?: FactStatus | undefined;
  type?: FactType | undefined;
  /** `unknown`: priced facts whose GST treatment needs review (KB-15). */
  gst?: 'unknown' | undefined;
  q?: string | undefined;
  /** Facts extracted from one source (FEAT-012). */
  sourceId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface FactPage {
  facts: FactRecord[];
  nextCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 50;

type FactRow = typeof schema.facts.$inferSelect;

/** A row as the module's record; shared with `review.ts`, not exported from the package. */
export function toRecord(row: FactRow): FactRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    version: row.version,
    source: row.source,
    updatedAt: row.updatedAt,
    value: row.value,
    gstTreatment: row.gstTreatment,
    validity: { validFrom: row.validFrom, validUntil: row.validUntil },
    sourceId: row.sourceId,
    confidence: row.confidence,
    provenance: (row.provenance as Provenance | null) ?? null,
  } as FactRecord;
}

const validityOf = (input: FactInput): Validity => input.validity ?? NO_VALIDITY;

/**
 * The cross-field rules of each type (FEAT-011 §3.2), checked before every write; the
 * database checks repeat them. Throws `InvalidFactError`.
 */
export function checkFact(input: FactInput): void {
  const { validFrom, validUntil } = validityOf(input);
  const type = input.type;
  switch (input.type) {
    case 'product':
      if (!input.gstTreatment) throw new InvalidFactError('a price needs its GST treatment');
      break;
    case 'faq':
    case 'policy':
      if (input.gstTreatment !== null) throw new InvalidFactError(`a ${type} has no GST`);
      if (validFrom || validUntil) throw new InvalidFactError(`a ${type} has no validity`);
      break;
    case 'promotion': {
      const priced = input.value.priceCents !== undefined;
      if (priced && !input.gstTreatment)
        throw new InvalidFactError('a promotion price needs its GST treatment');
      if (!priced && input.gstTreatment !== null)
        throw new InvalidFactError('a promotion without a price has no GST treatment');
      if (!validUntil) throw new InvalidFactError('a promotion needs its end date');
      break;
    }
  }
  if (validFrom && validUntil && validFrom >= validUntil)
    throw new InvalidFactError('the start date is after the end date');
}

// ---- List (SCR-APP-027) -----------------------------------------------------------

const CURSOR_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `updated_at` as Postgres text keeps its microseconds, which a JS Date drops (D5). */
const encodeCursor = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { ts: string; id: string } {
  const [ts = '', id = '', extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !CURSOR_TS.test(ts) || !UUID.test(id))
    throw new InvalidCursorError('bad cursor');
  return { ts, id };
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Facts, newest change first, a page at a time (SCR-APP-027; FEAT-011 §3.2). `q`
 * matches every type's text fields; `cursor` continues after the last row of a page.
 */
export async function listFacts(
  ctx: DashboardKbContext,
  filter: FactFilter = {},
): Promise<FactPage> {
  const f = schema.facts;
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const conditions = [eq(f.tenantId, ctx.tenantId)];
  if (filter.status) conditions.push(eq(f.status, filter.status));
  if (filter.type) conditions.push(eq(f.type, filter.type));
  if (filter.gst) conditions.push(eq(f.gstTreatment, filter.gst));
  if (filter.sourceId) conditions.push(eq(f.sourceId, filter.sourceId));
  if (filter.q) {
    const pattern = like(filter.q);
    const fields = ['name', 'unit', 'question', 'answer', 'title', 'details'];
    conditions.push(
      sql`(${sql.join(
        fields.map((k) => sql`${f.value}->>${k} ilike ${pattern}`),
        sql` or `,
      )})`,
    );
  }
  if (filter.cursor) {
    const c = decodeCursor(filter.cursor);
    conditions.push(sql`(${f.updatedAt}, ${f.id}) < (${c.ts}::timestamptz, ${c.id}::uuid)`);
  }
  const rows = await ctx.tx
    .select({ ...getTableColumns(f), cursorTs: sql<string>`${f.updatedAt}::text` })
    .from(f)
    .where(and(...conditions))
    .orderBy(desc(f.updatedAt), desc(f.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    facts: page.map(toRecord),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorTs, last.id) : null,
  };
}

export async function getFact(ctx: DashboardKbContext, id: string): Promise<FactRecord> {
  const [row] = await ctx.tx
    .select()
    .from(schema.facts)
    .where(and(eq(schema.facts.tenantId, ctx.tenantId), eq(schema.facts.id, id)));
  if (!row) throw new FactNotFoundError('fact not found');
  return toRecord(row);
}

// ---- Writes -----------------------------------------------------------------------

export async function writeVersion(ctx: DashboardKbContext, row: FactRow) {
  await ctx.tx.insert(schema.factVersions).values({
    tenantId: ctx.tenantId,
    factId: row.id,
    version: row.version,
    status: row.status,
    value: row.value,
    gstTreatment: row.gstTreatment,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    changedBy: ctx.userId,
  });
}

export async function writeChunk(ctx: DashboardKbContext, row: FactRow, chunk: PreparedChunk) {
  const values = {
    tenantId: ctx.tenantId,
    factId: row.id,
    factVersion: row.version,
    content: chunk.content,
    embedding: chunk.embedding,
  };
  await ctx.tx
    .insert(schema.kbChunks)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.kbChunks.tenantId, schema.kbChunks.factId],
      set: { factVersion: row.version, content: chunk.content, embedding: chunk.embedding },
    });
}

/**
 * A fact entered by hand: approved at once (KB-07), with version 1, its chunk and an
 * audit entry in the same transaction, so the next visitor turn can use it.
 */
export async function createFact(
  ctx: DashboardKbContext,
  input: FactInput,
  chunk: PreparedChunk,
): Promise<FactRecord> {
  checkFact(input);
  const { validFrom, validUntil } = validityOf(input);
  const [row] = await ctx.tx
    .insert(schema.facts)
    .values({
      tenantId: ctx.tenantId,
      type: input.type,
      status: 'approved',
      value: input.value,
      gstTreatment: input.gstTreatment,
      validFrom,
      validUntil,
      source: 'manual',
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    })
    .returning();
  await writeVersion(ctx, row!);
  await writeChunk(ctx, row!, chunk);
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'fact.created',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'fact',
    subjectId: row!.id,
  });
  return toRecord(row!);
}

/**
 * The fact as it will be after `patch`: what the caller embeds before saving. A
 * promotion's GST treatment follows its price (dropped with it, kept while it stays);
 * a stored `unknown` is kept by an edit that doesn't set it. Throws `InvalidFactError`.
 */
export function mergePatch(current: FactRecord, patch: FactPatch): FactInput {
  if (patch.validity && current.type !== 'promotion')
    throw new InvalidFactError(`a ${current.type} has no validity`);
  let next: FactInput;
  switch (current.type) {
    case 'product':
      next = {
        type: 'product',
        value: (patch.value as ProductValue | undefined) ?? current.value,
        gstTreatment: (patch.gstTreatment as GstTreatment | undefined) ?? current.gstTreatment,
        validity: current.validity,
      };
      break;
    case 'faq':
    case 'policy':
      if (patch.gstTreatment) throw new InvalidFactError(`a ${current.type} has no GST`);
      next = {
        type: current.type,
        value: (patch.value ?? current.value) as FaqValue & PolicyValue,
        gstTreatment: null,
        validity: current.validity,
      };
      break;
    case 'promotion': {
      const value = (patch.value as PromotionValue | undefined) ?? current.value;
      const priced = value.priceCents !== undefined;
      const gst = patch.gstTreatment ?? (priced ? current.gstTreatment : null);
      next = {
        type: 'promotion',
        value,
        gstTreatment: gst,
        validity: {
          validFrom:
            patch.validity?.validFrom !== undefined
              ? patch.validity.validFrom
              : current.validity.validFrom,
          validUntil:
            patch.validity?.validUntil !== undefined
              ? patch.validity.validUntil
              : current.validity.validUntil,
        },
      };
      break;
    }
  }
  checkFact(next);
  return next;
}

const time = (d: Date | null) => d?.getTime() ?? null;

export function contentChanged(current: FactRecord, next: FactInput): boolean {
  const v = validityOf(next);
  return (
    JSON.stringify(current.value) !== JSON.stringify(next.value) ||
    current.gstTreatment !== next.gstTreatment ||
    time(current.validity.validFrom) !== time(v.validFrom) ||
    time(current.validity.validUntil) !== time(v.validUntil)
  );
}

/**
 * Edits a fact (ADR-010): a content edit makes a `needs_review` fact `approved`
 * (KB-07) and keeps `approved` or `disabled` as they are; `status` moves
 * `approved ↔ disabled` only. Rejected and conflicted facts belong to FEAT-013/014.
 * Pass `chunk` when the content changed. Conditional on `patch.version`.
 */
export async function updateFact(
  ctx: DashboardKbContext,
  id: string,
  patch: FactPatch,
  chunk?: PreparedChunk,
): Promise<FactRecord> {
  const current = await getFact(ctx, id);
  if (current.version !== patch.version) throw new VersionConflictError('stale version');
  if (current.status === 'rejected' || current.status === 'conflicted')
    throw new InvalidStateError(`a ${current.status} fact can't be edited here`);
  const next = mergePatch(current, patch);
  const changed = contentChanged(current, next);
  if (changed && !chunk) throw new Error('updateFact: a content change needs its chunk');
  // Approving without an edit is the review step (FEAT-013), not this one.
  if (patch.status && !changed && current.status === 'needs_review')
    throw new InvalidStateError('review this fact in Review');

  let status: FactStatus = current.status;
  if (changed && status === 'needs_review') status = 'approved';
  if (patch.status) status = patch.status;
  if (!changed && status === current.status) return current;

  const { validFrom, validUntil } = validityOf(next);
  const [row] = await ctx.tx
    .update(schema.facts)
    .set({
      value: next.value,
      gstTreatment: next.gstTreatment,
      validFrom,
      validUntil,
      status,
      version: sql`${schema.facts.version} + 1`,
      updatedBy: ctx.userId,
      updatedAt: sql`now()`,
      ...(changed ? { lastConfirmedAt: sql`now()` } : {}),
    })
    .where(
      and(
        eq(schema.facts.tenantId, ctx.tenantId),
        eq(schema.facts.id, id),
        eq(schema.facts.version, patch.version),
      ),
    )
    .returning();
  if (!row) throw new VersionConflictError('stale version');
  await writeVersion(ctx, row);
  if (changed) await writeChunk(ctx, row, chunk!);
  else
    // Status only: keep the chunk searchable at the new version.
    await ctx.tx
      .update(schema.kbChunks)
      .set({ factVersion: row.version })
      .where(and(eq(schema.kbChunks.tenantId, ctx.tenantId), eq(schema.kbChunks.factId, id)));

  const actions: string[] = [];
  if (changed) actions.push('fact.updated');
  // An edit that takes a fact out of review is an approval too (KB-16; FEAT-013 D8).
  if (current.status === 'needs_review' && status === 'approved') actions.push('fact.approved');
  if (status !== current.status && status === 'disabled') actions.push('fact.disabled');
  if (status !== current.status && current.status === 'disabled') actions.push('fact.enabled');
  for (const action of actions)
    await audit.append(ctx.tx, ctx.tenantId, {
      action,
      actorType: 'user',
      actorId: ctx.userId,
      subjectType: 'fact',
      subjectId: id,
      payload:
        action === 'fact.approved'
          ? { version: row.version, mode: auditCode('edited') }
          : { version: row.version },
    });
  return toRecord(row);
}

/**
 * Deletes a fact with its chunk and versions (KB-07; FEAT-011 D1), conditional on the
 * version the owner saw. The chunk goes in the same transaction, so the next visitor
 * turn can't retrieve it. The audit entry keeps the ID, type and last version only.
 */
export async function deleteFact(
  ctx: DashboardKbContext,
  id: string,
  version: number,
): Promise<void> {
  const f = schema.facts;
  const [row] = await ctx.tx
    .select()
    .from(f)
    .where(and(eq(f.tenantId, ctx.tenantId), eq(f.id, id)))
    .for('update');
  if (!row) throw new FactNotFoundError('fact not found');
  if (row.version !== version) throw new VersionConflictError('stale version');
  const ofFact = <T extends typeof schema.kbChunks | typeof schema.factVersions>(t: T) =>
    and(eq(t.tenantId, ctx.tenantId), eq(t.factId, id));
  await ctx.tx.delete(schema.kbChunks).where(ofFact(schema.kbChunks));
  await ctx.tx.delete(schema.factVersions).where(ofFact(schema.factVersions));
  await ctx.tx.delete(f).where(and(eq(f.tenantId, ctx.tenantId), eq(f.id, id)));
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'fact.deleted',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'fact',
    subjectId: id,
    payload: { type: auditCode(row.type), version: row.version },
  });
  // A conflict this fact was part of may be over (FEAT-014 §5.3).
  if (row.status === 'conflicted')
    await settleConflicts(
      ctx.tx,
      ctx.tenantId,
      { type: 'user', id: ctx.userId },
      new Set([entityKey(inputOf(row))]),
    );
}
