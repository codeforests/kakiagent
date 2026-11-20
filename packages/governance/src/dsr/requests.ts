import {
  DSR_CLOSED_STATUSES,
  DSR_DUE_SOON_DAYS,
  DSR_PAGE_SIZE,
  sgToday,
  type DsrCreateBody,
  type DsrDetail,
  type DsrErrorCode,
  type DsrList,
  type DsrOutcome,
  type DsrPatchBody,
  type DsrStatus,
  type DsrSummary,
  type DsrType,
  type DsrVerifyMethod,
} from '@kaki/contracts';
import { and, asc, desc, eq, inArray, lt, or, schema, sql, type Tx } from '@kaki/db';
import { piiMask } from '@kaki/platform/pii-mask';
import { audit } from '../audit.js';
import { auditCode, type ActorType, type AuditPayload } from '../payload.js';
import { addDays, dsrRef, dueState, requesterLabel } from './due.js';

const r = schema.dsrRequests;
export type DsrRow = typeof schema.dsrRequests.$inferSelect;

/** A refused request action, mapped to its HTTP status by the API (§3). */
export class DsrError extends Error {
  constructor(
    readonly code: DsrErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'DsrError';
  }
}

/** Free text staff type is masked at the edge before it is stored (ADR-015). */
const maskNote = (s: string | undefined | null) => (s ? piiMask(s) : null);

export async function auditDsr(
  tx: Tx,
  tenantId: string,
  e: {
    event: string;
    requestId: string;
    actor: { type: ActorType; id?: string | undefined };
    payload?: AuditPayload;
    related?: { type: string; id: string }[];
  },
): Promise<{ seq: number }> {
  return audit.append(tx, tenantId, {
    action: `dsr.${e.event}`,
    actorType: e.actor.type,
    actorId: e.actor.id,
    subjectType: 'data_request',
    subjectId: e.requestId,
    related: e.related,
    payload: e.payload ?? {},
  });
}

export async function getRequest(tx: Tx, tenantId: string, id: string): Promise<DsrRow> {
  const [row] = await tx
    .select()
    .from(r)
    .where(and(eq(r.tenantId, tenantId), eq(r.id, id)));
  if (!row) throw new DsrError('not_found');
  return row;
}

export async function createRequest(
  tx: Tx,
  tenantId: string,
  userId: string,
  body: DsrCreateBody,
): Promise<DsrRow> {
  const [row] = await tx
    .insert(r)
    .values({
      tenantId,
      type: body.type,
      source: 'dashboard',
      receivedOn: body.receivedOn,
      requesterName: body.requester.name ?? null,
      requesterEmail: body.requester.email ?? null,
      requesterPhone: body.requester.phone ?? null,
      requesterTelegramId: body.requester.telegramId ?? null,
      note: maskNote(body.note),
      createdBy: userId,
    })
    .returning();
  await auditDsr(tx, tenantId, {
    event: 'opened',
    requestId: row!.id,
    actor: { type: 'user', id: userId },
    payload: { type: auditCode(body.type), source: auditCode('dashboard') },
  });
  return row!;
}

/**
 * One compare-and-set on `version` and the allowed statuses; a miss is `not_found` (other
 * tenant or no such ID) or `state_changed` (stale version or wrong status).
 */
async function transition(
  tx: Tx,
  tenantId: string,
  id: string,
  version: number,
  from: readonly DsrStatus[],
  set: Partial<typeof schema.dsrRequests.$inferInsert>,
): Promise<DsrRow> {
  const [row] = await tx
    .update(r)
    .set({ ...set, updatedAt: sql`now()`, version: sql`${r.version} + 1` })
    .where(
      and(
        eq(r.tenantId, tenantId),
        eq(r.id, id),
        eq(r.version, version),
        inArray(r.status, [...from]),
      ),
    )
    .returning();
  if (row) return row;
  await getRequest(tx, tenantId, id);
  throw new DsrError('state_changed');
}

export async function updateRequest(
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
  patch: DsrPatchBody,
): Promise<DsrRow> {
  const set: Partial<typeof schema.dsrRequests.$inferInsert> = {};
  if (patch.type) set.type = patch.type;
  if (patch.receivedOn) set.receivedOn = patch.receivedOn;
  if (patch.requester) {
    set.requesterName = patch.requester.name ?? null;
    set.requesterEmail = patch.requester.email ?? null;
    set.requesterPhone = patch.requester.phone ?? null;
    set.requesterTelegramId = patch.requester.telegramId ?? null;
  }
  const row = await transition(tx, tenantId, id, patch.version, ['open'], set);
  const fields = Object.keys(patch).filter((k) => k !== 'version');
  await auditDsr(tx, tenantId, {
    event: 'updated',
    requestId: id,
    actor: { type: 'user', id: userId },
    payload: {
      fields: fields.map((f) => auditCode(f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))),
    },
  });
  return row;
}

export async function verifyRequest(
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
  input: { version: number; method: DsrVerifyMethod; note: string },
): Promise<DsrRow> {
  const row = await transition(tx, tenantId, id, input.version, ['open'], {
    status: 'verified',
    verifyMethod: input.method,
    verifyNote: maskNote(input.note),
    verifiedBy: userId,
    verifiedAt: sql`now()` as unknown as Date,
  });
  await auditDsr(tx, tenantId, {
    event: 'verified',
    requestId: id,
    actor: { type: 'user', id: userId },
    payload: { method: auditCode(input.method) },
  });
  return row;
}

async function closeAs(
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
  input: { version: number; reason: string },
  status: 'unverified' | 'closed',
  from: readonly DsrStatus[],
): Promise<DsrRow> {
  const row = await transition(tx, tenantId, id, input.version, from, {
    status,
    closeReason: maskNote(input.reason),
    closedBy: userId,
    closedAt: sql`now()` as unknown as Date,
  });
  await auditDsr(tx, tenantId, {
    event: status,
    requestId: id,
    actor: { type: 'user', id: userId },
  });
  return row;
}

/** UC-30 2a: identity not verified; closes the request with the reason. */
export const markUnverified = (
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
  input: { version: number; reason: string },
) => closeAs(tx, tenantId, userId, id, input, 'unverified', ['open']);

/** Closed without acting (a duplicate, withdrawn). */
export const closeRequest = (
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
  input: { version: number; reason: string },
) => closeAs(tx, tenantId, userId, id, input, 'closed', ['open', 'verified']);

/** A verified access or correction request is answered; a deletion completes by erasing. */
export async function completeRequest(
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
  input: { version: number; note?: string | undefined },
): Promise<DsrRow> {
  const cur = await getRequest(tx, tenantId, id);
  if (cur.type === 'deletion') throw new DsrError('wrong_type');
  const row = await transition(tx, tenantId, id, input.version, ['verified'], {
    status: 'completed',
    closeReason: maskNote(input.note),
    closedBy: userId,
    closedAt: sql`now()` as unknown as Date,
  });
  await auditDsr(tx, tenantId, {
    event: 'completed',
    requestId: id,
    actor: { type: 'user', id: userId },
    payload: { type: auditCode(cur.type) },
  });
  return row;
}

/** Find, export, correct and erase need a verified request of the right type (AC-2). */
export async function requireVerified(
  tx: Tx,
  tenantId: string,
  id: string,
  type?: DsrType,
): Promise<DsrRow> {
  const row = await getRequest(tx, tenantId, id);
  if (row.status !== 'verified') throw new DsrError('state_changed');
  if (type && row.type !== type) throw new DsrError('wrong_type');
  return row;
}

export const isoOf = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

export function toSummary(row: DsrRow, today = sgToday()): DsrSummary {
  return {
    id: row.id,
    ref: dsrRef(row.id),
    type: row.type,
    status: row.status,
    source: row.source,
    receivedOn: row.receivedOn,
    dueOn: row.dueOn,
    dueState: dueState(row, today),
    requesterLabel: requesterLabel({
      name: row.requesterName,
      email: row.requesterEmail,
      phone: row.requesterPhone,
      telegramId: row.requesterTelegramId,
    }),
    createdAt: isoOf(row.createdAt),
  };
}

export interface DsrEvent {
  at: string;
  code: string;
  actorId: string | null;
}

/** This request's audit entries, newest first. */
export async function requestEvents(tx: Tx, tenantId: string, id: string): Promise<DsrEvent[]> {
  const a = schema.auditEntries;
  const rows = await tx
    .select({ ts: a.ts, eventType: a.eventType, actorRef: a.actorRef, actorType: a.actorType })
    .from(a)
    .where(
      and(
        eq(a.tenantId, tenantId),
        sql`${a.subjectRefs} @> array[${`data_request:${id}`}]::text[]`,
      ),
    )
    .orderBy(desc(a.seq))
    .limit(100);
  return rows.map((e) => ({
    at: isoOf(e.ts),
    code: e.eventType,
    actorId: e.actorType === 'user' ? e.actorRef : null,
  }));
}

/** IDs of members a detail names, so the API can resolve them in one call. */
export function memberIdsOf(row: DsrRow, events: DsrEvent[]): string[] {
  return [
    ...new Set(
      [row.verifiedBy, row.closedBy, ...events.map((e) => e.actorId)].filter(
        (x): x is string => !!x,
      ),
    ),
  ];
}

export function toDetail(
  row: DsrRow,
  events: DsrEvent[],
  nameOf: (id: string | null) => string | null,
  opts: { backupRetentionDays: number; today?: string },
): DsrDetail {
  const closed = row.closedAt !== null;
  const outcome = (row.outcome ?? null) as DsrOutcome | null;
  const completedOn = row.closedAt ? sgToday(new Date(row.closedAt)) : null;
  return {
    ...toSummary(row, opts.today),
    version: row.version,
    requester: {
      name: row.requesterName,
      email: row.requesterEmail,
      phone: row.requesterPhone,
      telegramId: row.requesterTelegramId,
      erased: row.requesterErasedAt !== null,
    },
    note: row.note,
    conversationId: row.conversationId,
    contactId: row.contactId,
    verification:
      row.verifyMethod && row.verifiedAt
        ? {
            method: row.verifyMethod,
            note: row.verifyNote ?? '',
            by: nameOf(row.verifiedBy),
            at: isoOf(row.verifiedAt),
          }
        : null,
    closed: closed
      ? {
          reason: row.closeReason,
          by: nameOf(row.closedBy),
          at: isoOf(row.closedAt!),
          outcome,
        }
      : null,
    objects: row.objectsDoneAt !== null ? 'done' : row.objectsPending > 0 ? 'pending' : 'none',
    backupsClearBy:
      row.requesterErasedAt && completedOn ? addDays(completedOn, opts.backupRetentionDays) : null,
    events: events.map((e) => ({ at: e.at, code: e.code, by: nameOf(e.actorId) })),
  };
}

const OPEN: DsrStatus[] = ['open', 'verified'];

function encodeCursor(a: string, id: string) {
  return Buffer.from(`${a}|${id}`).toString('base64url');
}
function decodeCursor(c: string): [string, string] | null {
  const [a, id] = Buffer.from(c, 'base64url').toString().split('|');
  return a && id && /^[0-9a-f-]{36}$/.test(id) ? [a, id] : null;
}

/** Open requests by due date; closed ones newest first. 50 per page, keyset (§3). */
export async function listRequests(
  tx: Tx,
  tenantId: string,
  q: { view: 'open' | 'closed'; cursor?: string | undefined },
  today = sgToday(),
): Promise<DsrList> {
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  const base = and(eq(r.tenantId, tenantId));
  const rows =
    q.view === 'open'
      ? await tx
          .select()
          .from(r)
          .where(
            and(
              base,
              inArray(r.status, OPEN),
              cur
                ? or(
                    sql`${r.dueOn} > ${cur[0]}`,
                    and(sql`${r.dueOn} = ${cur[0]}`, sql`${r.id} > ${cur[1]}`),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(r.dueOn), asc(r.id))
          .limit(DSR_PAGE_SIZE + 1)
      : await tx
          .select()
          .from(r)
          .where(
            and(
              base,
              inArray(r.status, [...DSR_CLOSED_STATUSES]),
              cur
                ? or(
                    lt(r.closedAt, new Date(cur[0])),
                    and(eq(r.closedAt, new Date(cur[0])), sql`${r.id} < ${cur[1]}`),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(r.closedAt), desc(r.id))
          .limit(DSR_PAGE_SIZE + 1);
  const page = rows.slice(0, DSR_PAGE_SIZE);
  const last = page.at(-1);
  const next =
    rows.length > DSR_PAGE_SIZE && last
      ? encodeCursor(q.view === 'open' ? last.dueOn : isoOf(last.closedAt!), last.id)
      : null;
  const soonFrom = addDays(today, DSR_DUE_SOON_DAYS);
  const [counts] = await tx
    .select({
      open: sql<number>`count(*)::int`,
      dueSoon: sql<number>`(count(*) filter (where ${r.dueOn} >= ${today} and ${r.dueOn} <= ${soonFrom}))::int`,
      overdue: sql<number>`(count(*) filter (where ${r.dueOn} < ${today}))::int`,
    })
    .from(r)
    .where(and(base, inArray(r.status, OPEN)));
  return {
    items: page.map((row) => toSummary(row, today)),
    next,
    counts: counts ?? { open: 0, dueSoon: 0, overdue: 0 },
  };
}
