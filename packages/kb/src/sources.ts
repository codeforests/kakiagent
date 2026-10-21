import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditHash } from '@kaki/governance';
import { enqueue } from '@kaki/platform/outbox';
import type { DashboardKbContext } from './context.js';
import {
  InvalidStateError,
  SourceExistsError,
  SourceNotFoundError,
  VersionConflictError,
} from './errors.js';
import { originsOf, type WebsiteScope } from './ingest/scope.js';

export type SourceStatus = (typeof schema.SOURCE_STATUSES)[number];
export type SourceStage = (typeof schema.SOURCE_STAGES)[number];
export type SourceFailure = (typeof schema.SOURCE_FAILURES)[number];
export type PageStatus = (typeof schema.PAGE_STATUSES)[number];
export type PageReason = (typeof schema.PAGE_REASONS)[number];

export type SourceRecord = typeof schema.kbSources.$inferSelect;

export interface PageRecord {
  id: string;
  url: string;
  title: string | null;
  status: PageStatus;
  reason: PageReason | null;
  httpStatus: number | null;
  facts: number;
}

/** The ingest job for a source's next stage (ADR-018 decision 1), in the caller's transaction. */
export async function enqueueStage(
  tx: Tx,
  source: { tenantId: string; id: string; attempt: number },
  stage: SourceStage,
): Promise<void> {
  await enqueue(tx, {
    tenantId: source.tenantId,
    topic: 'ingest',
    groupKey: source.id,
    payload: { tenantId: source.tenantId, sourceId: source.id, attempt: source.attempt, stage },
  });
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const ofSource = (tenantId: string, id: string) =>
  and(eq(schema.kbSources.tenantId, tenantId), eq(schema.kbSources.id, id));

/**
 * Adds a website source (KB-13, KB-01): the owner's attestation is recorded on the row and
 * in the audit log before the source exists, the confirmed hosts become widget origins
 * (CHN-11), and the crawl job is written with it. Throws `SourceExistsError` for a domain
 * the tenant already has.
 */
export async function createWebsiteSource(
  ctx: DashboardKbContext,
  scope: WebsiteScope,
  opts: { pageLimit: number },
): Promise<SourceRecord> {
  const s = schema.kbSources;
  const [existing] = await ctx.tx
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.tenantId, ctx.tenantId), eq(s.kind, 'website'), eq(s.domain, scope.domain)));
  if (existing) throw new SourceExistsError(existing.id);
  const now = new Date();
  const [row] = await ctx.tx
    .insert(s)
    .values({
      tenantId: ctx.tenantId,
      kind: 'website',
      status: 'queued',
      stage: 'crawl',
      url: scope.url,
      domain: scope.domain,
      subdomains: scope.subdomains,
      pageLimit: opts.pageLimit,
      attestedBy: ctx.userId,
      attestedAt: now,
      createdBy: ctx.userId,
    })
    .returning();
  const source = row!;
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'kb_source.attested',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'kb_source',
    subjectId: source.id,
    payload: {
      kind: auditCode('website'),
      domainHash: auditHash(sha256(scope.domain)),
      subdomains: scope.subdomains.length,
    },
  });
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'kb_source.created',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'kb_source',
    subjectId: source.id,
    payload: { kind: auditCode('website'), pageLimit: opts.pageLimit },
  });
  // Sorted and de-duplicated, so adding a domain twice changes nothing. The origins are
  // `https://<host>` for validated hosts, so the array literal needs no escaping.
  const origins = `{${originsOf(scope)
    .map((o) => `"${o}"`)
    .join(',')}}`;
  await ctx.tx.execute(sql`
    update tenants set allowed_origins = array(
      select distinct o from unnest(allowed_origins || ${origins}::text[]) as o order by o)
    where id = ${ctx.tenantId}`);
  await enqueueStage(ctx.tx, source, 'crawl');
  return source;
}

export async function listSources(ctx: DashboardKbContext): Promise<SourceRecord[]> {
  const s = schema.kbSources;
  return ctx.tx
    .select()
    .from(s)
    .where(eq(s.tenantId, ctx.tenantId))
    .orderBy(desc(s.createdAt), desc(s.id));
}

/** A source with the pages of its current attempt, in crawl order. */
export async function getSource(
  ctx: DashboardKbContext,
  id: string,
): Promise<{ source: SourceRecord; pages: PageRecord[] }> {
  const [source] = await ctx.tx.select().from(schema.kbSources).where(ofSource(ctx.tenantId, id));
  if (!source) throw new SourceNotFoundError('source not found');
  const p = schema.kbSourcePages;
  const pages = await ctx.tx
    .select({
      id: p.id,
      url: p.url,
      title: p.title,
      status: p.status,
      reason: p.reason,
      httpStatus: p.httpStatus,
      facts: p.factsCount,
    })
    .from(p)
    .where(and(eq(p.tenantId, ctx.tenantId), eq(p.sourceId, id), eq(p.attempt, source.attempt)))
    .orderBy(asc(p.seq));
  return { source, pages };
}

async function lockSource(ctx: DashboardKbContext, id: string, version: number) {
  const [row] = await ctx.tx
    .select()
    .from(schema.kbSources)
    .where(ofSource(ctx.tenantId, id))
    .for('update');
  if (!row) throw new SourceNotFoundError('source not found');
  if (row.version !== version) throw new VersionConflictError('stale version');
  return row;
}

async function clearRun(ctx: DashboardKbContext, id: string) {
  const ofThis = <T extends typeof schema.kbStagedFacts | typeof schema.kbSourcePages>(t: T) =>
    and(eq(t.tenantId, ctx.tenantId), eq(t.sourceId, id));
  await ctx.tx.delete(schema.kbStagedFacts).where(ofThis(schema.kbStagedFacts));
  await ctx.tx.delete(schema.kbSourcePages).where(ofThis(schema.kbSourcePages));
}

/**
 * Runs a failed source again as a new attempt (KB-12 retry): the old attempt's pages and
 * staging go, the counts restart, and the crawl job is written in the same transaction.
 */
export async function retrySource(
  ctx: DashboardKbContext,
  id: string,
  version: number,
): Promise<SourceRecord> {
  const current = await lockSource(ctx, id, version);
  if (current.status !== 'failed') throw new InvalidStateError(`a ${current.status} source`);
  await clearRun(ctx, id);
  const [row] = await ctx.tx
    .update(schema.kbSources)
    .set({
      status: 'queued',
      stage: 'crawl',
      failure: null,
      attempt: current.attempt + 1,
      version: current.version + 1,
      pagesFound: 0,
      pagesIncluded: 0,
      pagesExcluded: 0,
      pagesFailed: 0,
      pagesSkipped: 0,
      pagesExtracted: 0,
      factsCount: 0,
      finishedAt: null,
      updatedAt: sql`now()`,
    })
    .where(ofSource(ctx.tenantId, id))
    .returning();
  const source = row!;
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'kb_source.retried',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'kb_source',
    subjectId: id,
    payload: { attempt: source.attempt },
  });
  await enqueueStage(ctx.tx, source, 'crawl');
  return source;
}

/**
 * Deletes a source with its pages, staging and every fact it produced, whatever their
 * status, with their chunks and versions (KB-07 documents, GOV-05; FEAT-012 D9). A source
 * being processed can't be deleted. Returns how many facts went.
 */
export async function deleteSource(
  ctx: DashboardKbContext,
  id: string,
  version: number,
): Promise<number> {
  const current = await lockSource(ctx, id, version);
  if (current.status === 'processing') throw new InvalidStateError('source is processing');
  await clearRun(ctx, id);
  const f = schema.facts;
  const ids = (
    await ctx.tx
      .select({ id: f.id })
      .from(f)
      .where(and(eq(f.tenantId, ctx.tenantId), eq(f.sourceId, id)))
  ).map((r) => r.id);
  if (ids.length) {
    for (const t of [schema.kbChunks, schema.factVersions])
      await ctx.tx.delete(t).where(and(eq(t.tenantId, ctx.tenantId), inArray(t.factId, ids)));
    await ctx.tx.delete(f).where(and(eq(f.tenantId, ctx.tenantId), inArray(f.id, ids)));
  }
  await ctx.tx.delete(schema.kbSources).where(ofSource(ctx.tenantId, id));
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'kb_source.deleted',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'kb_source',
    subjectId: id,
    payload: { kind: auditCode(current.kind), facts: ids.length },
  });
  return ids.length;
}
