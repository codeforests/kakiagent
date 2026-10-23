import { and, desc, eq, inArray, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, type AuditPayload } from '@kaki/governance';
import { allAgree, entityKey, inputOf } from './conflicts.js';

/**
 * Set-based status moves (FEAT-013 D7, generalised by FEAT-014 §5.3): the facts, their
 * version rows and their chunks' versions in three statements, then one audit entry per
 * fact. Shared by review, conflict resolution, settle (dashboard) and promote (ingest).
 */

export type MoveStatus = 'approved' | 'rejected' | 'needs_review' | 'conflicted' | 'disabled';
export interface Actor {
  type: 'user' | 'system';
  id: string;
}
export interface MovedRef {
  id: string;
  version: number;
}

const f = schema.facts;
const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * Moves the (locked, checked) facts to `status`. Approval records the confirmation time
 * (KB-17). `entry` names each fact's audit action and payload; null writes none.
 */
export async function moveFacts(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  ids: string[],
  status: MoveStatus,
  entry: (ref: MovedRef) => { action: string; payload: AuditPayload } | null,
): Promise<MovedRef[]> {
  if (!ids.length) return [];
  const updated = await tx
    .update(f)
    .set({
      status,
      version: sql`${f.version} + 1`,
      updatedBy: actor.id,
      updatedAt: sql`now()`,
      ...(status === 'approved' ? { lastConfirmedAt: sql`now()` } : {}),
    })
    .where(and(eq(f.tenantId, tenantId), inArray(f.id, ids)))
    .returning({ id: f.id, version: f.version });
  await tx.execute(sql`
    insert into fact_versions (tenant_id, fact_id, version, status, value, gst_treatment,
                               valid_from, valid_until, changed_by)
    select tenant_id, id, version, status, value, gst_treatment, valid_from, valid_until,
           ${actor.id}
    from facts
    where tenant_id = ${tenantId} and id in (${idList(ids)})`);
  await tx.execute(sql`
    update kb_chunks c set fact_version = f.version
    from facts f
    where c.tenant_id = ${tenantId} and f.tenant_id = c.tenant_id and f.id = c.fact_id
      and f.id in (${idList(ids)})`);
  const byId = new Map(updated.map((u) => [u.id, u.version]));
  const refs = ids.map((id) => ({ id, version: byId.get(id)! }));
  for (const ref of refs) {
    const e = entry(ref);
    if (!e) continue;
    await audit.append(tx, tenantId, {
      action: e.action,
      actorType: actor.type,
      actorId: actor.id,
      subjectType: 'fact',
      subjectId: ref.id,
      payload: e.payload,
    });
  }
  return refs;
}

/** The conflicted facts of the tenant whose keys are among `keys`, locked. */
async function conflictedWith(tx: Tx, tenantId: string, keys: Set<string>) {
  const rows = await tx
    .select()
    .from(f)
    .where(and(eq(f.tenantId, tenantId), eq(f.status, 'conflicted')))
    .orderBy(f.id)
    .for('update');
  return rows.filter((r) => keys.has(entityKey(inputOf(r))));
}

/**
 * After facts were deleted (FEAT-014 §5.3): a conflict whose remaining facts now agree
 * (or that has one left) is over, and each of them goes back to its status before the
 * conflict, or `needs_review` if it was written conflicted. Audited as cleared.
 */
export async function settleConflicts(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  keys: Set<string>,
): Promise<number> {
  if (!keys.size) return 0;
  const rows = await conflictedWith(tx, tenantId, keys);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = entityKey(inputOf(r));
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let cleared = 0;
  for (const group of groups.values()) {
    if (!allAgree(group.map(inputOf))) continue;
    for (const r of group) {
      const v = schema.factVersions;
      const [before] = await tx
        .select({ status: v.status })
        .from(v)
        .where(
          and(
            eq(v.tenantId, tenantId),
            eq(v.factId, r.id),
            sql`${v.status} <> 'conflicted'`,
            sql`${v.version} < ${r.version}`,
          ),
        )
        .orderBy(desc(v.version))
        .limit(1);
      const to = (before?.status ?? 'needs_review') as MoveStatus;
      await moveFacts(tx, tenantId, actor, [r.id], to, (ref) => ({
        action: 'fact.conflict_cleared',
        payload: { version: ref.version, to: auditCode(to) },
      }));
      cleared += 1;
    }
  }
  return cleared;
}
