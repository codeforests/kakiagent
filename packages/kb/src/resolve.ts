import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, schema, sql } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import type { PreparedChunk } from './chunk.js';
import { conflictId, entityKey, inputOf } from './conflicts.js';
import type { DashboardKbContext } from './context.js';
import { GstRequiredError, InvalidFactError } from './errors.js';
import { toRecord, writeChunk, writeVersion, type FactInput, type FactRecord } from './facts.js';
import {
  decideRows,
  REVIEW_ORDER,
  withPassages,
  type FactRef,
  type ReviewRecord,
} from './review.js';
import { NO_VALIDITY } from './types.js';

/**
 * Resolving conflicts (KB-06, UC-12; FEAT-014 §5.3): the side-by-side list of the
 * tenant's conflicts, each source with its date and the newer one suggested (KB-17), and
 * the owner's resolution: use one value, enter the right one, or disable the entity.
 */

export type ConflictFactRecord = ReviewRecord & {
  /** When this source said it (D4): the source's read time, or the owner's last word. */
  sourceDate: Date;
  newer: boolean;
};

export interface ConflictRecord {
  id: string;
  type: FactRecord['type'];
  facts: ConflictFactRecord[];
  suggestedId: string | null;
}

export type Resolution = 'use' | 'enter' | 'disable';

/** The conflict changed since the owner loaded it; nothing was written. */
export class ConflictChangedError extends Error {
  constructor(readonly conflict: ConflictRecord | null) {
    super('conflict changed');
  }
}

const f = schema.facts;
type FactRow = typeof schema.facts.$inferSelect;
const keyOf = (row: FactRow) => entityKey(inputOf(row));

async function conflictedRows(ctx: DashboardKbContext, lock = false) {
  const q = ctx.tx
    .select()
    .from(f)
    .where(and(eq(f.tenantId, ctx.tenantId), eq(f.status, 'conflicted')))
    .orderBy(asc(f.id));
  return lock ? q.for('update') : q;
}

function group(rows: FactRow[]) {
  const groups = new Map<string, FactRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return groups;
}

async function toConflicts(ctx: DashboardKbContext, groups: Map<string, FactRow[]>) {
  const all = [...groups.values()].flat();
  const records = new Map((await withPassages(ctx, all)).map((r) => [r.id, r]));
  const conflicts = [...groups.entries()].map(([key, rows]) => {
    const facts = rows.map((row) => {
      const record = records.get(row.id)!;
      return {
        ...record,
        sourceDate: record.sourceCapturedAt ?? row.lastConfirmedAt,
        newer: false,
      };
    });
    facts.sort(
      (a, b) =>
        b.sourceDate.getTime() - a.sourceDate.getTime() ||
        (b.confidence ?? -1) - (a.confidence ?? -1) ||
        a.id.localeCompare(b.id),
    );
    const [first, second] = facts;
    const suggested =
      first && (!second || first.sourceDate.getTime() > second.sourceDate.getTime()) ? first : null;
    if (suggested && second) suggested.newer = true;
    const oldest = Math.min(...rows.map((r) => r.updatedAt.getTime()));
    return {
      conflict: {
        id: conflictId(key),
        type: rows[0]!.type,
        facts,
        suggestedId: suggested && second ? suggested.id : null,
      },
      oldest,
    };
  });
  conflicts.sort(
    (a, b) =>
      REVIEW_ORDER.indexOf(a.conflict.type) - REVIEW_ORDER.indexOf(b.conflict.type) ||
      a.oldest - b.oldest,
  );
  return conflicts.map((c) => c.conflict);
}

/** Every open conflict of the tenant, its facts side by side (UC-12 1). */
export async function listConflicts(ctx: DashboardKbContext): Promise<ConflictRecord[]> {
  return toConflicts(ctx, group(await conflictedRows(ctx)));
}

/** The open conflict with this key, or null. */
async function conflictWithKey(ctx: DashboardKbContext, key: string | null) {
  if (key === null) return null;
  return (await listConflicts(ctx)).find((c) => c.id === conflictId(key)) ?? null;
}

/**
 * Resolves one conflict (UC-12 2–3, 2a; D7). `refs` must be every member as the owner
 * saw it; the kept fact is approved (`use`, `enter` with `edit`) or disabled, the others
 * rejected, in one transaction, with one entry per fact and one `kb.conflict.resolved`.
 * `edit` is the kept fact's new content and chunk (embedded by the caller beforehand)
 * for `enter`, or for `use` with a GST choice.
 */
export async function resolveConflict(
  ctx: DashboardKbContext,
  refs: FactRef[],
  keepId: string,
  resolution: Resolution,
  edit?: { next: FactInput; chunk: PreparedChunk },
): Promise<{ fact: FactRecord; rejected: FactRef[] }> {
  if (!refs.some((r) => r.id === keepId)) throw new InvalidFactError('keep one of the facts');
  const locked = await ctx.tx
    .select()
    .from(f)
    .where(
      and(
        eq(f.tenantId, ctx.tenantId),
        inArray(
          f.id,
          refs.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(f.id))
    .for('update');
  const byId = new Map(locked.map((r) => [r.id, r]));
  const kept = byId.get(keepId);
  const key = kept ? keyOf(kept) : locked[0] ? keyOf(locked[0]) : null;
  const members = key ? (group(await conflictedRows(ctx, true)).get(key) ?? []) : [];
  const unchanged =
    key !== null &&
    refs.every((ref) => {
      const row = byId.get(ref.id);
      return row && row.version === ref.version && row.status === 'conflicted';
    }) &&
    members.length === refs.length &&
    members.every((m) => refs.some((r) => r.id === m.id));
  if (!unchanged || !kept) throw new ConflictChangedError(await conflictWithKey(ctx, key));

  if (resolution !== 'disable') {
    const gst = edit ? edit.next.gstTreatment : kept.gstTreatment;
    if (gst === 'unknown') throw new GstRequiredError('choose the GST treatment');
  }
  const suggestedId = (await conflictWithKey(ctx, key))?.suggestedId ?? null;
  const batch = randomUUID();
  if (edit && resolution !== 'disable') {
    const { validFrom, validUntil } = edit.next.validity ?? NO_VALIDITY;
    const [row] = await ctx.tx
      .update(f)
      .set({
        value: edit.next.value,
        gstTreatment: edit.next.gstTreatment,
        validFrom,
        validUntil,
        status: 'approved',
        version: sql`${f.version} + 1`,
        updatedBy: ctx.userId,
        updatedAt: sql`now()`,
        lastConfirmedAt: sql`now()`,
      })
      .where(and(eq(f.tenantId, ctx.tenantId), eq(f.id, keepId)))
      .returning();
    await writeVersion(ctx, row!);
    await writeChunk(ctx, row!, edit.chunk);
    for (const [action, payload] of [
      ['fact.updated', { version: row!.version }],
      [
        'fact.approved',
        { version: row!.version, mode: auditCode('conflict'), batch: auditId(batch) },
      ],
    ] as const)
      await audit.append(ctx.tx, ctx.tenantId, {
        action,
        actorType: 'user',
        actorId: ctx.userId,
        subjectType: 'fact',
        subjectId: keepId,
        payload,
      });
  } else {
    await decideRows(
      ctx,
      [kept],
      resolution === 'disable' ? 'disabled' : 'approved',
      'conflict',
      batch,
    );
  }
  const rejected = await decideRows(
    ctx,
    locked.filter((r) => r.id !== keepId),
    'rejected',
    'conflict',
    batch,
  );
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'kb.conflict.resolved',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'kb_conflict',
    subjectId: batch,
    payload: {
      resolution: auditCode(resolution),
      kept: auditId(keepId),
      facts: locked.length,
      type: auditCode(kept.type),
      suggested: suggestedId === keepId,
    },
  });
  const [row] = await ctx.tx
    .select()
    .from(f)
    .where(and(eq(f.tenantId, ctx.tenantId), eq(f.id, keepId)));
  return { fact: toRecord(row!), rejected };
}
