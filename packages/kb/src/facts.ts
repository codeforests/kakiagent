import { and, desc, eq, schema, sql } from '@kaki/db';
import { audit } from '@kaki/governance';
import type { PreparedChunk } from './chunk.js';
import type { DashboardKbContext } from './context.js';
import { FactNotFoundError, InvalidStateError, VersionConflictError } from './errors.js';
import type { FactInput, FaqValue, GstTreatment, ProductValue } from './types.js';

export type { FactInput };

export type FactStatus = (typeof schema.FACT_STATUSES)[number];

export type FactRecord = FactInput & {
  id: string;
  status: FactStatus;
  version: number;
  source: string;
  updatedAt: Date;
};

export interface FactPatch {
  /** The version the client loaded; a mismatch is a conflict. */
  version: number;
  value?: ProductValue | FaqValue | undefined;
  gstTreatment?: GstTreatment | null | undefined;
  status?: 'approved' | 'disabled' | undefined;
}

type FactRow = typeof schema.facts.$inferSelect;

function toRecord(row: FactRow): FactRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    version: row.version,
    source: row.source,
    updatedAt: row.updatedAt,
    value: row.value,
    gstTreatment: row.gstTreatment,
  } as FactRecord;
}

/** Facts newest first (SCR-APP-027). `q` matches name, question or answer. */
export async function listFacts(
  ctx: DashboardKbContext,
  filter: { status?: FactStatus | undefined; q?: string | undefined } = {},
): Promise<FactRecord[]> {
  const f = schema.facts;
  const conditions = [eq(f.tenantId, ctx.tenantId)];
  if (filter.status) conditions.push(eq(f.status, filter.status));
  if (filter.q) {
    const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      sql`(${f.value}->>'name' ilike ${like} or ${f.value}->>'question' ilike ${like} or ${f.value}->>'answer' ilike ${like})`,
    );
  }
  const rows = await ctx.tx
    .select()
    .from(f)
    .where(and(...conditions))
    .orderBy(desc(f.updatedAt))
    .limit(200);
  return rows.map(toRecord);
}

export async function getFact(ctx: DashboardKbContext, id: string): Promise<FactRecord> {
  const [row] = await ctx.tx
    .select()
    .from(schema.facts)
    .where(and(eq(schema.facts.tenantId, ctx.tenantId), eq(schema.facts.id, id)));
  if (!row) throw new FactNotFoundError('fact not found');
  return toRecord(row);
}

async function writeVersion(ctx: DashboardKbContext, row: FactRow) {
  await ctx.tx.insert(schema.factVersions).values({
    tenantId: ctx.tenantId,
    factId: row.id,
    version: row.version,
    status: row.status,
    value: row.value,
    gstTreatment: row.gstTreatment,
    changedBy: ctx.userId,
  });
}

async function writeChunk(ctx: DashboardKbContext, row: FactRow, chunk: PreparedChunk) {
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
  const [row] = await ctx.tx
    .insert(schema.facts)
    .values({
      tenantId: ctx.tenantId,
      type: input.type,
      status: 'approved',
      value: input.value,
      gstTreatment: input.gstTreatment,
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

/** The fact as it will be after `patch`: what the caller embeds before saving. */
export function mergePatch(current: FactRecord, patch: FactPatch): FactInput {
  if (current.type === 'product')
    return {
      type: 'product',
      value: (patch.value as ProductValue | undefined) ?? current.value,
      gstTreatment: (patch.gstTreatment as GstTreatment | undefined) ?? current.gstTreatment,
    };
  return {
    type: 'faq',
    value: (patch.value as FaqValue | undefined) ?? current.value,
    gstTreatment: null,
  };
}

export function contentChanged(current: FactRecord, next: FactInput): boolean {
  return (
    JSON.stringify(current.value) !== JSON.stringify(next.value) ||
    current.gstTreatment !== next.gstTreatment
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

  const [row] = await ctx.tx
    .update(schema.facts)
    .set({
      value: next.value,
      gstTreatment: next.gstTreatment,
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
  if (status !== current.status && status === 'disabled') actions.push('fact.disabled');
  if (status !== current.status && current.status === 'disabled') actions.push('fact.enabled');
  for (const action of actions)
    await audit.append(ctx.tx, ctx.tenantId, {
      action,
      actorType: 'user',
      actorId: ctx.userId,
      subjectType: 'fact',
      subjectId: id,
      payload: { version: row.version },
    });
  return toRecord(row);
}
