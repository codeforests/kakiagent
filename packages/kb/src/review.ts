import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, getTableColumns, inArray, schema, sql } from '@kaki/db';
import { audit, auditCode, auditHash, auditId, type AuditPayload } from '@kaki/governance';
import type { PreparedChunk } from './chunk.js';
import type { DashboardKbContext } from './context.js';
import {
  FactNotFoundError,
  GstRequiredError,
  InvalidCursorError,
  InvalidStateError,
  VersionConflictError,
} from './errors.js';
import {
  toRecord,
  writeChunk,
  writeVersion,
  type FactInput,
  type FactRecord,
  type FactType,
} from './facts.js';
import { NO_VALIDITY } from './types.js';

/**
 * Fact review (KB-16, ADR-010 decisions 1–3; FEAT-013 §5.1): the queue of facts waiting
 * for the Owner or an Admin, single and bulk decisions, Approve all against a preview,
 * and a short undo. Every path into `approved` or `rejected` is audited per fact.
 */

/** "By source or by entity type" (KB-16). */
export interface ReviewScope {
  sourceId?: string | undefined;
  type?: FactType | undefined;
}

/** The quote inside its page text, cut at words (FEAT-013 D6). */
export interface Passage {
  before: string;
  quote: string;
  after: string;
}

export type ReviewRecord = FactRecord & {
  passage: Passage | null;
  sourceName: string | null;
  sourceCapturedAt: Date | null;
};

export interface ReviewPage {
  facts: ReviewRecord[];
  nextCursor: string | null;
}

export interface FactRef {
  id: string;
  version: number;
}

export type SkipReason = 'gst_unknown' | 'conflicted' | 'not_reviewable' | 'changed' | 'not_found';
export interface Skipped {
  id: string;
  reason: SkipReason;
}

export type TypeCounts = Record<FactType, number>;

export interface ReviewSummary {
  needsReview: number;
  conflicted: number;
  byType: TypeCounts;
  bySource: { id: string | null; name: string | null; count: number }[];
  approvedInUse: number;
  sourcesBusy: number;
}

export interface ApprovePreview {
  scope: ReviewScope;
  count: number;
  byType: TypeCounts;
  excluded: { gstUnknown: number; conflicted: number };
  previewHash: string;
}

/** The facts Approve all would approve changed since the preview (D2); nothing was approved. */
export class PreviewStaleError extends Error {
  constructor(readonly preview: ApprovePreview) {
    super('preview stale');
  }
}

/** KB-16: prices, policies and promotions first. */
export const REVIEW_ORDER: readonly FactType[] = ['product', 'policy', 'promotion', 'faq'];
export const REVIEW_PAGE_SIZE = 50;
export const PASSAGE_CONTEXT = 160;
/** How long after a decision Undo is accepted (D5); the UI offers it for 5 s. */
export const UNDO_WINDOW_MINUTES = 10;

const REVIEWABLE = ['needs_review', 'conflicted'] as const;
const f = schema.facts;
const zeroCounts = (): TypeCounts => ({ product: 0, policy: 0, promotion: 0, faq: 0 });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const rank = sql<number>`case ${f.type} when 'product' then 0 when 'policy' then 1 when 'promotion' then 2 else 3 end`;

function scopeConditions(ctx: DashboardKbContext, scope: ReviewScope) {
  const c = [eq(f.tenantId, ctx.tenantId)];
  if (scope.sourceId) c.push(eq(f.sourceId, scope.sourceId));
  if (scope.type) c.push(eq(f.type, scope.type));
  return c;
}

// ---- The queue (SCR-APP-019) -------------------------------------------------------

/**
 * The quote with up to `PASSAGE_CONTEXT` characters of its page on each side, widened or
 * trimmed to whole words, "…" where cut. Offsets that don't match the page text (it
 * can't happen for FEAT-012's facts, but the text is the evidence) give the quote alone.
 */
export function passageOf(content: string | null, quote: string, start: number, end: number) {
  if (content === null || content.slice(start, end) !== quote)
    return { before: '', quote, after: '' };
  let before = content.slice(Math.max(0, start - PASSAGE_CONTEXT), start);
  if (start > PASSAGE_CONTEXT) {
    const space = before.search(/\s/);
    before = `…${space >= 0 ? before.slice(space + 1) : ''}`;
  }
  let after = content.slice(end, end + PASSAGE_CONTEXT);
  if (end + PASSAGE_CONTEXT < content.length) {
    const space = after.search(/\s\S*$/);
    after = `${space >= 0 ? after.slice(0, space) : ''}…`;
  }
  return { before, quote, after };
}

const CURSOR_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (r: number, ts: string, id: string) =>
  Buffer.from(`${r}|${ts}|${id}`).toString('base64url');

function decodeCursor(cursor: string): { rank: number; ts: string; id: string } {
  const [r = '', ts = '', id = '', extra] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  if (extra !== undefined || !/^[0-3]$/.test(r) || !CURSOR_TS.test(ts) || !UUID.test(id))
    throw new InvalidCursorError('bad cursor');
  return { rank: Number(r), ts, id };
}

/**
 * Facts waiting for review (`needs_review`, and `conflicted` for FEAT-014's link), in the
 * KB-16 order, then crawl order, a page at a time, each with its passage and source.
 */
export async function listReviewFacts(
  ctx: DashboardKbContext,
  scope: ReviewScope = {},
  cursor?: string,
  limit = REVIEW_PAGE_SIZE,
): Promise<ReviewPage> {
  const conditions = [...scopeConditions(ctx, scope), inArray(f.status, [...REVIEWABLE])];
  if (cursor) {
    const c = decodeCursor(cursor);
    conditions.push(
      sql`(${rank}, ${f.createdAt}, ${f.id}) > (${c.rank}, ${c.ts}::timestamptz, ${c.id}::uuid)`,
    );
  }
  const rows = await ctx.tx
    .select({ ...getTableColumns(f), rank, cursorTs: sql<string>`${f.createdAt}::text` })
    .from(f)
    .where(and(...conditions))
    .orderBy(rank, asc(f.createdAt), asc(f.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);

  const sourceIds = [...new Set(page.map((r) => r.sourceId).filter((s): s is string => !!s))];
  const sources = new Map<string, { domain: string; finishedAt: Date | null }>();
  const contents = new Map<string, string | null>();
  if (sourceIds.length) {
    const s = schema.kbSources;
    for (const row of await ctx.tx
      .select({ id: s.id, domain: s.domain, finishedAt: s.finishedAt })
      .from(s)
      .where(and(eq(s.tenantId, ctx.tenantId), inArray(s.id, sourceIds))))
      sources.set(row.id, row);
    const urls = [
      ...new Set(page.map((r) => (r.provenance as { url?: string } | null)?.url).filter(Boolean)),
    ] as string[];
    const p = schema.kbSourcePages;
    // The current attempt's pages: provenance offsets refer to their content.
    const pages = await ctx.tx
      .select({ sourceId: p.sourceId, url: p.url, content: p.content })
      .from(p)
      .innerJoin(s, and(eq(s.tenantId, p.tenantId), eq(s.id, p.sourceId), eq(s.attempt, p.attempt)))
      .where(
        and(eq(p.tenantId, ctx.tenantId), inArray(p.sourceId, sourceIds), inArray(p.url, urls)),
      );
    for (const row of pages) contents.set(`${row.sourceId} ${row.url}`, row.content);
  }

  const last = page.at(-1);
  return {
    facts: page.map((row) => {
      const record = toRecord(row);
      const p = record.provenance;
      const source = record.sourceId ? sources.get(record.sourceId) : undefined;
      return {
        ...record,
        passage: p
          ? passageOf(contents.get(`${record.sourceId} ${p.url}`) ?? null, p.quote, p.start, p.end)
          : null,
        sourceName: source?.domain ?? null,
        sourceCapturedAt: source?.finishedAt ?? null,
      };
    }),
    nextCursor:
      rows.length > limit && last ? encodeCursor(last.rank, last.cursorTs, last.id) : null,
  };
}

/** The counts the Review screen, its tab, the nav badge and the setup step show. */
export async function reviewSummary(ctx: DashboardKbContext): Promise<ReviewSummary> {
  const byStatus = await ctx.tx
    .select({ type: f.type, status: f.status, count: sql<number>`count(*)::int` })
    .from(f)
    .where(eq(f.tenantId, ctx.tenantId))
    .groupBy(f.type, f.status);
  const summary: ReviewSummary = {
    needsReview: 0,
    conflicted: 0,
    byType: zeroCounts(),
    bySource: [],
    approvedInUse: 0,
    sourcesBusy: 0,
  };
  for (const r of byStatus) {
    if (r.status === 'approved') summary.approvedInUse += r.count;
    if (r.status === 'needs_review') summary.needsReview += r.count;
    if (r.status === 'conflicted') summary.conflicted += r.count;
    if (r.status === 'needs_review' || r.status === 'conflicted') summary.byType[r.type] += r.count;
  }
  const s = schema.kbSources;
  const bySource = await ctx.tx
    .select({ id: f.sourceId, name: s.domain, count: sql<number>`count(*)::int` })
    .from(f)
    .leftJoin(s, and(eq(s.tenantId, f.tenantId), eq(s.id, f.sourceId)))
    .where(and(eq(f.tenantId, ctx.tenantId), inArray(f.status, [...REVIEWABLE])))
    .groupBy(f.sourceId, s.domain)
    .orderBy(s.domain);
  summary.bySource = bySource;
  const [busy] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(s)
    .where(and(eq(s.tenantId, ctx.tenantId), inArray(s.status, ['queued', 'processing'])));
  summary.sourcesBusy = busy?.count ?? 0;
  return summary;
}

// ---- Approve all (ADR-010 decision 3; D2, D3) ---------------------------------------

/** Not approvable in bulk: the owner chooses the GST treatment first (KB-15). */
const gstUnknown = sql`${f.gstTreatment} = 'unknown'`;
const notGstUnknown = sql`(${f.gstTreatment} is null or ${f.gstTreatment} <> 'unknown')`;

async function eligible(ctx: DashboardKbContext, scope: ReviewScope, lock: boolean) {
  const q = ctx.tx
    .select({ id: f.id, version: f.version, type: f.type })
    .from(f)
    .where(and(...scopeConditions(ctx, scope), eq(f.status, 'needs_review'), notGstUnknown))
    .orderBy(asc(f.id));
  return lock ? q.for('update') : q;
}

function hashOf(scope: ReviewScope, rows: FactRef[]): string {
  const facts = rows.map((r) => `${r.id}:${r.version}`).sort();
  return sha256(
    JSON.stringify({ sourceId: scope.sourceId ?? null, type: scope.type ?? null, facts }),
  );
}

async function preview(
  ctx: DashboardKbContext,
  scope: ReviewScope,
  rows: { id: string; version: number; type: FactType }[],
): Promise<ApprovePreview> {
  const byType = zeroCounts();
  for (const r of rows) byType[r.type] += 1;
  const [excluded] = await ctx.tx
    .select({
      gstUnknown: sql<number>`count(*) filter (where ${f.status} = 'needs_review' and ${gstUnknown})::int`,
      conflicted: sql<number>`count(*) filter (where ${f.status} = 'conflicted')::int`,
    })
    .from(f)
    .where(and(...scopeConditions(ctx, scope)));
  return {
    scope,
    count: rows.length,
    byType,
    excluded: { gstUnknown: excluded?.gstUnknown ?? 0, conflicted: excluded?.conflicted ?? 0 },
    previewHash: hashOf(scope, rows),
  };
}

/** What Approve all would approve in this scope, and the hash that approves exactly that. */
export async function previewApproveAll(
  ctx: DashboardKbContext,
  scope: ReviewScope = {},
): Promise<ApprovePreview> {
  return preview(ctx, scope, await eligible(ctx, scope, false));
}

/**
 * Approves every eligible fact in the scope, provided the set is still the one the
 * preview's hash names; otherwise nothing is approved and `PreviewStaleError` carries a
 * fresh preview. One `fact.approved` per fact and one `kb.review.approved_all` summary.
 */
export async function approveAll(
  ctx: DashboardKbContext,
  scope: ReviewScope,
  previewHash: string,
): Promise<{ facts: FactRef[] }> {
  const rows = await eligible(ctx, scope, true);
  if (hashOf(scope, rows) !== previewHash)
    throw new PreviewStaleError(await preview(ctx, scope, rows));
  const batch = randomUUID();
  const facts = await decideRows(ctx, rows, 'approved', 'all', batch);
  const byType = zeroCounts();
  for (const r of rows) byType[r.type] += 1;
  const payload: Record<string, AuditPayload[string]> = {
    count: facts.length,
    ...byType,
    scope: auditCode(scope.sourceId ? 'source' : scope.type ? 'type' : 'all'),
    previewHash: auditHash(previewHash),
  };
  if (scope.sourceId) payload.source = auditId(scope.sourceId);
  if (scope.type) payload.type = auditCode(scope.type);
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'kb.review.approved_all',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'kb_review',
    subjectId: batch,
    payload,
  });
  return { facts };
}

// ---- Writes ------------------------------------------------------------------------

type Decision = 'approved' | 'rejected' | 'needs_review';
type Mode = 'single' | 'edited' | 'bulk' | 'all';

const ACTION: Record<Decision, string> = {
  approved: 'fact.approved',
  rejected: 'fact.rejected',
  needs_review: 'fact.review_undone',
};

/**
 * Moves locked, checked rows to `status` set-based (D7): the facts, their version rows
 * and their chunks' versions, then one audit entry per fact. Approval records the
 * confirmation time (KB-17). Returns the new versions.
 */
async function decideRows(
  ctx: DashboardKbContext,
  rows: { id: string; status?: string }[],
  status: Decision,
  mode: Mode | null,
  batch?: string,
): Promise<FactRef[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const from = new Map(rows.map((r) => [r.id, r.status]));
  const updated = await ctx.tx
    .update(f)
    .set({
      status,
      version: sql`${f.version} + 1`,
      updatedBy: ctx.userId,
      updatedAt: sql`now()`,
      ...(status === 'approved' ? { lastConfirmedAt: sql`now()` } : {}),
    })
    .where(and(eq(f.tenantId, ctx.tenantId), inArray(f.id, ids)))
    .returning({ id: f.id, version: f.version });
  await ctx.tx.execute(sql`
    insert into fact_versions (tenant_id, fact_id, version, status, value, gst_treatment,
                               valid_from, valid_until, changed_by)
    select tenant_id, id, version, status, value, gst_treatment, valid_from, valid_until,
           ${ctx.userId}
    from facts
    where tenant_id = ${ctx.tenantId} and id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  await ctx.tx.execute(sql`
    update kb_chunks c set fact_version = f.version
    from facts f
    where c.tenant_id = ${ctx.tenantId} and f.tenant_id = c.tenant_id and f.id = c.fact_id
      and f.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
  const byId = new Map(updated.map((u) => [u.id, u.version]));
  const refs = ids.map((id) => ({ id, version: byId.get(id)! }));
  for (const ref of refs) {
    const payload: Record<string, AuditPayload[string]> = { version: ref.version };
    if (mode) payload.mode = auditCode(mode);
    if (status === 'needs_review') payload.from = auditCode(from.get(ref.id) ?? 'approved');
    if (batch) payload.batch = auditId(batch);
    await audit.append(ctx.tx, ctx.tenantId, {
      action: ACTION[status],
      actorType: 'user',
      actorId: ctx.userId,
      subjectType: 'fact',
      subjectId: ref.id,
      payload,
    });
  }
  return refs;
}

async function lockFact(ctx: DashboardKbContext, id: string) {
  const [row] = await ctx.tx
    .select()
    .from(f)
    .where(and(eq(f.tenantId, ctx.tenantId), eq(f.id, id)))
    .for('update');
  if (!row) throw new FactNotFoundError('fact not found');
  return row;
}

function checkReviewable(row: { status: string; version: number }, version: number) {
  if (row.version !== version) throw new VersionConflictError('stale version');
  if (row.status !== 'needs_review')
    throw new InvalidStateError(
      row.status === 'conflicted'
        ? 'resolve this conflict first'
        : `this fact is ${row.status.replace('_', ' ')}, not waiting for review`,
    );
}

/**
 * Approves one fact (UC-15 2): as it is, or "edit and approve" with `edit` (the merged
 * fact and its chunk, embedded by the caller before the transaction). A price whose GST
 * treatment is still unknown needs the owner's choice first (KB-15; D3).
 */
export async function approveFact(
  ctx: DashboardKbContext,
  id: string,
  version: number,
  edit?: { next: FactInput; chunk: PreparedChunk },
): Promise<FactRecord> {
  const current = await lockFact(ctx, id);
  checkReviewable(current, version);
  const gst = edit ? edit.next.gstTreatment : current.gstTreatment;
  if (gst === 'unknown') throw new GstRequiredError('choose the GST treatment');
  if (!edit) {
    await decideRows(ctx, [current], 'approved', 'single');
    return toRecord(await lockFact(ctx, id));
  }
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
    .where(and(eq(f.tenantId, ctx.tenantId), eq(f.id, id)))
    .returning();
  await writeVersion(ctx, row!);
  await writeChunk(ctx, row!, edit.chunk);
  for (const [action, payload] of [
    ['fact.updated', { version: row!.version }],
    ['fact.approved', { version: row!.version, mode: auditCode('edited') }],
  ] as const)
    await audit.append(ctx.tx, ctx.tenantId, {
      action,
      actorType: 'user',
      actorId: ctx.userId,
      subjectType: 'fact',
      subjectId: id,
      payload,
    });
  return toRecord(row!);
}

/** Rejects one fact (UC-15 2): it stays out of answers and leaves the queue. */
export async function rejectFact(
  ctx: DashboardKbContext,
  id: string,
  version: number,
): Promise<FactRecord> {
  const current = await lockFact(ctx, id);
  checkReviewable(current, version);
  await decideRows(ctx, [current], 'rejected', 'single');
  return toRecord(await lockFact(ctx, id));
}

async function lockRefs(ctx: DashboardKbContext, refs: FactRef[]) {
  const rows = await ctx.tx
    .select({ id: f.id, version: f.version, status: f.status, gstTreatment: f.gstTreatment })
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
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * A selection's decision (UC-15 3; D4): each ref is applied or skipped with its reason,
 * independently; the applied ones get one entry each plus one summary entry.
 */
async function decideSelected(
  ctx: DashboardKbContext,
  refs: FactRef[],
  status: 'approved' | 'rejected',
) {
  const rows = await lockRefs(ctx, refs);
  const apply: { id: string }[] = [];
  const skipped: Skipped[] = [];
  for (const ref of refs) {
    const row = rows.get(ref.id);
    const reason: SkipReason | null = !row
      ? 'not_found'
      : row.version !== ref.version
        ? 'changed'
        : row.status === 'conflicted'
          ? 'conflicted'
          : row.status !== 'needs_review'
            ? 'not_reviewable'
            : status === 'approved' && row.gstTreatment === 'unknown'
              ? 'gst_unknown'
              : null;
    if (reason) skipped.push({ id: ref.id, reason });
    else apply.push({ id: ref.id });
  }
  const batch = randomUUID();
  const done = await decideRows(ctx, apply, status, 'bulk', batch);
  if (done.length)
    await audit.append(ctx.tx, ctx.tenantId, {
      action: status === 'approved' ? 'kb.review.approved_bulk' : 'kb.review.rejected_bulk',
      actorType: 'user',
      actorId: ctx.userId,
      subjectType: 'kb_review',
      subjectId: batch,
      payload: { count: done.length },
    });
  return { done, skipped };
}

export async function approveSelected(ctx: DashboardKbContext, refs: FactRef[]) {
  const { done, skipped } = await decideSelected(ctx, refs, 'approved');
  return { approved: done, skipped };
}

export async function rejectSelected(ctx: DashboardKbContext, refs: FactRef[]) {
  const { done, skipped } = await decideSelected(ctx, refs, 'rejected');
  return { rejected: done, skipped };
}

/**
 * Undo (D5): puts facts back in review, but only the version a review decision produced
 * (still at that version, approved or rejected, the version before it `needs_review`)
 * and only within `UNDO_WINDOW_MINUTES`.
 */
export async function undoReview(
  ctx: DashboardKbContext,
  refs: FactRef[],
): Promise<{ restored: number; skipped: Skipped[] }> {
  const rows = await lockRefs(ctx, refs);
  const v = schema.factVersions;
  const previous = refs.length
    ? await ctx.tx
        .select({ id: v.factId, version: v.version, status: v.status })
        .from(v)
        .where(
          and(
            eq(v.tenantId, ctx.tenantId),
            inArray(
              v.factId,
              refs.map((r) => r.id),
            ),
          ),
        )
    : [];
  const before = new Map(previous.map((p) => [`${p.id}:${p.version}`, p.status]));
  const [recent] = refs.length
    ? await ctx.tx
        .select({
          ids: sql<string[]>`coalesce(array_agg(${f.id}::text), '{}')`,
        })
        .from(f)
        .where(
          and(
            eq(f.tenantId, ctx.tenantId),
            inArray(
              f.id,
              refs.map((r) => r.id),
            ),
            sql`${f.updatedAt} > now() - make_interval(mins => ${UNDO_WINDOW_MINUTES})`,
          ),
        )
    : [{ ids: [] as string[] }];
  const fresh = new Set(recent?.ids ?? []);
  const apply: { id: string; status: string }[] = [];
  const skipped: Skipped[] = [];
  for (const ref of refs) {
    const row = rows.get(ref.id);
    if (!row) skipped.push({ id: ref.id, reason: 'not_found' });
    else if (row.version !== ref.version) skipped.push({ id: ref.id, reason: 'changed' });
    else if (
      (row.status !== 'approved' && row.status !== 'rejected') ||
      before.get(`${ref.id}:${ref.version - 1}`) !== 'needs_review' ||
      !fresh.has(ref.id)
    )
      skipped.push({ id: ref.id, reason: 'not_reviewable' });
    else apply.push({ id: ref.id, status: row.status });
  }
  const done = await decideRows(ctx, apply, 'needs_review', null);
  return { restored: done.length, skipped };
}
