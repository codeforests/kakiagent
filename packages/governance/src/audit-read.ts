import {
  AUDIT_ALL_PREFIXES,
  auditGroupOf,
  auditGroupPrefixes,
  type AuditFilter,
  type AuditQuery,
  type AuditRow,
} from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';

type SQL = ReturnType<typeof sql>;

/**
 * Reading the audit log for the dashboard (FEAT-060 §5.1, GOV-02). Runs inside the
 * caller's `withTenant` on the dashboard zone. The linked personal data in `audit_pii` is
 * never selected: a row only says whether it is still kept (D5).
 */

/** One entry as stored, plus whether its personal data is kept: every hashed field verbatim. */
export interface AuditRecord {
  tenantId: string;
  seq: number;
  ts: string;
  actorType: AuditRow['actorType'];
  actorRef: string | null;
  eventType: string;
  subjectRefs: string[];
  payload: Record<string, unknown>;
  piiRef: string | null;
  piiCommitment: string | null;
  prevHash: string;
  hash: string;
  pii: AuditRow['pii'];
}

interface RecordRow extends Record<string, unknown> {
  tenant_id: string;
  seq: string | number;
  ts: Date | string;
  actor_type: AuditRow['actorType'];
  actor_ref: string | null;
  event_type: string;
  subject_refs: string[];
  payload: Record<string, unknown>;
  pii_ref: string | null;
  pii_commitment: string | null;
  prev_hash: string;
  hash: string;
  pii: AuditRow['pii'];
}

/** `like` patterns for prefixes: `_` and `%` are literal in event codes. */
const likeOf = (prefix: string) => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const patterns = (prefixes: readonly string[]) =>
  sql`array[${sql.join(
    prefixes.map((p) => sql`${likeOf(p)}`),
    sql`, `,
  )}]::text[]`;

/** One condition for list, count and export, so they can't disagree (§5.1). */
export function auditWhere(tenantId: string, q: AuditFilter): SQL {
  const parts: SQL[] = [sql`e.tenant_id = ${tenantId}`];
  if (q.from) parts.push(sql`e.ts >= (${q.from}::date)::timestamp at time zone 'Asia/Singapore'`);
  if (q.to) parts.push(sql`e.ts < (${q.to}::date + 1)::timestamp at time zone 'Asia/Singapore'`);
  if (q.conversation)
    parts.push(sql`e.subject_refs @> array[${`conversation:${q.conversation}`}]::text[]`);
  if (q.actor) parts.push(sql`e.actor_type = 'user' and e.actor_ref = ${q.actor}`);
  else if (q.actorType) parts.push(sql`e.actor_type = ${q.actorType}`);
  if (q.group === 'other')
    parts.push(sql`not (e.event_type like any(${patterns(AUDIT_ALL_PREFIXES)}))`);
  else if (q.group)
    parts.push(sql`e.event_type like any(${patterns(auditGroupPrefixes(q.group))})`);
  return sql.join(parts, sql` and `);
}

const SELECT = sql`
  select e.tenant_id, e.seq, e.ts, e.actor_type, e.actor_ref, e.event_type, e.subject_refs,
         e.payload, e.pii_ref, e.pii_commitment, e.prev_hash, e.hash,
         case when e.pii_ref is null then 'none' when p.id is not null then 'kept' else 'erased' end as pii
  from audit_entries e
  left join audit_pii p on p.tenant_id = e.tenant_id and p.id = e.pii_ref`;

function toRecord(r: RecordRow): AuditRecord {
  return {
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    ts: new Date(r.ts).toISOString(),
    actorType: r.actor_type,
    actorRef: r.actor_ref,
    eventType: r.event_type,
    subjectRefs: r.subject_refs,
    payload: r.payload,
    piiRef: r.pii_ref,
    piiCommitment: r.pii_commitment,
    prevHash: r.prev_hash,
    hash: r.hash,
    pii: r.pii,
  };
}

/** The contract row (pure): subjects split at the first colon, the group from the code. */
export function toAuditRow(
  r: AuditRecord,
  names: ReadonlyMap<string, string> = new Map(),
): AuditRow {
  return {
    seq: r.seq,
    ts: r.ts,
    actorType: r.actorType,
    actorId: r.actorRef,
    actorName: r.actorType === 'user' && r.actorRef ? (names.get(r.actorRef) ?? null) : null,
    eventType: r.eventType,
    group: auditGroupOf(r.eventType),
    subjects: r.subjectRefs.map((s) => {
      const i = s.indexOf(':');
      return i < 0 ? { type: s, id: '' } : { type: s.slice(0, i), id: s.slice(i + 1) };
    }),
    payload: r.payload,
    pii: r.pii,
    prevHash: r.prevHash,
    hash: r.hash,
  };
}

/** The user IDs a page names (for identity `memberNames`, which the caller runs). */
export const actorIdsOf = (records: readonly AuditRecord[]) => [
  ...new Set(records.filter((r) => r.actorType === 'user' && r.actorRef).map((r) => r.actorRef!)),
];

/** Newest first; `next` is the last seq returned when more remain (keyset `before`). */
export async function listAudit(
  tx: Tx,
  tenantId: string,
  q: AuditQuery,
): Promise<{ records: AuditRecord[]; next: number | null }> {
  const before = q.before ? sql` and e.seq < ${q.before}` : sql``;
  const { rows } = await tx.execute<RecordRow>(
    sql`${SELECT} where ${auditWhere(tenantId, q)}${before} order by e.seq desc limit ${q.limit + 1}`,
  );
  const records = rows.slice(0, q.limit).map(toRecord);
  return { records, next: rows.length > q.limit ? records.at(-1)!.seq : null };
}

export async function auditEntry(
  tx: Tx,
  tenantId: string,
  seq: number,
): Promise<AuditRecord | null> {
  const { rows } = await tx.execute<RecordRow>(
    sql`${SELECT} where e.tenant_id = ${tenantId} and e.seq = ${seq}`,
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** How many entries match; with `upTo`, only those with `seq <= upTo` (an export's snapshot). */
export async function auditCount(
  tx: Tx,
  tenantId: string,
  q: AuditFilter,
  upTo?: number,
): Promise<number> {
  const bound = upTo === undefined ? sql`` : sql` and e.seq <= ${upTo}`;
  const { rows } = await tx.execute<{ n: string | number }>(
    sql`select count(*) as n from audit_entries e where ${auditWhere(tenantId, q)}${bound}`,
  );
  return Number(rows[0]!.n);
}

/** Entries in `seq` order with `after < seq <= upTo`, for the snapshot-bounded export (§5.3). */
export async function auditRange(
  tx: Tx,
  tenantId: string,
  q: AuditFilter,
  after: number,
  upTo: number,
  limit: number,
): Promise<AuditRecord[]> {
  const { rows } = await tx.execute<RecordRow>(
    sql`${SELECT} where ${auditWhere(tenantId, q)} and e.seq > ${after} and e.seq <= ${upTo}
        order by e.seq limit ${limit}`,
  );
  return rows.map(toRecord);
}
