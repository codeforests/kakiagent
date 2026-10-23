import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditHash } from '@kaki/governance';
import { enqueue } from '@kaki/platform/outbox';
import type { DashboardKbContext } from './context.js';
import {
  FileLimitError,
  InvalidStateError,
  NotRetryableError,
  SourceExistsError,
  SourceNotFoundError,
  VersionConflictError,
} from './errors.js';
import { originsOf, type WebsiteScope } from './ingest/scope.js';
import { entityKey, inputOf } from './conflicts.js';
import { settleConflicts } from './writes.js';

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
  ocrConfidence: number | null;
  /** A spreadsheet row's cells (FEAT-016); null for other pages. */
  cells: string[] | null;
}

/** Where a tenant's upload waits for its checks: the quarantine bucket (ADR-018 d2). */
export const quarantineKey = (tenantId: string, uploadId: string) =>
  `uploads/${tenantId}/${uploadId}`;
/** Where a clean file is kept, for every attempt, until its source is deleted. */
export const sourcesKey = (tenantId: string, sourceId: string) => `files/${tenantId}/${sourceId}`;

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

/** File failures only a new upload fixes: the file is gone or can't change (FEAT-015 D7). */
export const NOT_RETRYABLE: readonly SourceFailure[] = [
  'upload_missing',
  'too_large',
  'unsupported_type',
  'encrypted',
  'malware',
  'unreadable',
  'no_text',
];

/** Uploads stored as objects: files (FEAT-015), spreadsheets (FEAT-016), chat exports (FEAT-017). */
export const isUpload = (kind: SourceRecord['kind']) =>
  kind === 'file' || kind === 'spreadsheet' || kind === 'chat';

/** A chat export's name until the parse names it by format and days (FEAT-017 §3.1). */
export const CHAT_SOURCE_NAME = 'Chat export';

/**
 * A failed source that Retry can run again (KB-12): every website, and uploads not
 * rejected; a spreadsheet without a table (`no_rows`) needs a new upload too (FEAT-016 §5.8).
 */
export const retryable = (s: Pick<SourceRecord, 'kind' | 'status' | 'failure'>) =>
  s.status === 'failed' &&
  !(
    isUpload(s.kind) &&
    s.failure &&
    (NOT_RETRYABLE.includes(s.failure) || (s.kind === 'spreadsheet' && s.failure === 'no_rows'))
  );

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
      name: scope.domain,
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

/**
 * Adds an uploaded file as a source (KB-02; FEAT-015 §5.6). The object is under the
 * session tenant's quarantine prefix, so a source can only claim the tenant's own upload
 * (D2). The scan job is written with it; nothing reads the file before the scan (KB-11).
 * Throws `FileLimitError` at the plan's file count, `SourceExistsError` for an upload that
 * already has a source. A spreadsheet (FEAT-016) is added the same way with its own kind,
 * and counts toward the same limit (UC-10 precondition). So is a chat export (FEAT-017
 * §3.2), named "Chat export" rather than its file name, which usually names the customer;
 * the owner's business names are kept in `chat` for the parse.
 */
export async function createFileSource(
  ctx: DashboardKbContext,
  file: {
    uploadId: string;
    fileName: string;
    sizeBytes: number;
    kind?: 'file' | 'spreadsheet' | 'chat';
    businessNames?: string[];
  },
  opts: { fileLimit: number },
): Promise<SourceRecord> {
  const s = schema.kbSources;
  const uploadKey = quarantineKey(ctx.tenantId, file.uploadId);
  // One file source at a time per tenant, so two uploads can't both take the last slot.
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`kb.files:${ctx.tenantId}`}, 0))`,
  );
  const [existing] = await ctx.tx
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.tenantId, ctx.tenantId), eq(s.uploadKey, uploadKey)));
  if (existing) throw new SourceExistsError(existing.id);
  if ((await countFileSources(ctx)) >= opts.fileLimit) throw new FileLimitError('file limit');
  const [row] = await ctx.tx
    .insert(s)
    .values({
      tenantId: ctx.tenantId,
      kind: file.kind ?? 'file',
      status: 'queued',
      stage: 'scan',
      name: file.kind === 'chat' ? CHAT_SOURCE_NAME : file.fileName,
      ...(file.kind === 'chat' ? { chat: { businessNames: file.businessNames ?? [] } } : {}),
      uploadKey,
      fileSize: file.sizeBytes,
      createdBy: ctx.userId,
    })
    .returning();
  const source = row!;
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'kb_source.created',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'kb_source',
    subjectId: source.id,
    // The extension and size only: a file name can be personal data (NFR-11).
    payload: {
      kind: auditCode(file.kind ?? 'file'),
      ext: auditCode(extensionOf(file.fileName)),
      sizeBytes: file.sizeBytes,
    },
  });
  await enqueueStage(ctx.tx, source, 'scan');
  return source;
}

/** ".pdf" → "pdf"; "" when the name has none. */
export const extensionOf = (name: string) =>
  /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

export async function countFileSources(ctx: DashboardKbContext): Promise<number> {
  const s = schema.kbSources;
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(s)
    .where(and(eq(s.tenantId, ctx.tenantId), inArray(s.kind, ['file', 'spreadsheet', 'chat'])));
  return row?.n ?? 0;
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
      ocrConfidence: p.ocrConfidence,
      cells: p.cells,
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
 * staging go, the counts restart, and the first stage's job is written in the same
 * transaction. A website starts at the crawl; a file at `parse` when its clean copy is
 * stored, else at `scan` (FEAT-015 §5.6). A file rejected by its checks can't be retried.
 */
export async function retrySource(
  ctx: DashboardKbContext,
  id: string,
  version: number,
): Promise<SourceRecord> {
  const current = await lockSource(ctx, id, version);
  if (current.status !== 'failed') throw new InvalidStateError(`a ${current.status} source`);
  if (!retryable(current)) throw new NotRetryableError(`a ${current.failure} file`);
  const stage: SourceStage =
    current.kind === 'website' ? 'crawl' : current.fileKey ? 'parse' : 'scan';
  // A spreadsheet with no valid rows goes back to the mapping; after a transient failure it
  // keeps it, so the parse goes straight on to the import (FEAT-016 D6).
  const clearMapping = current.kind === 'spreadsheet' && current.failure === 'no_valid_rows';
  await clearRun(ctx, id);
  const [row] = await ctx.tx
    .update(schema.kbSources)
    .set({
      status: 'queued',
      stage,
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
      ocrPages: 0,
      ...(clearMapping ? { mapping: null } : {}),
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
  await enqueueStage(ctx.tx, source, stage);
  return source;
}

/**
 * Deletes a source with its pages, staging and every fact it produced, whatever their
 * status, with their chunks and versions (KB-07 documents, GOV-05; FEAT-012 D9), and for a
 * file the job that deletes its stored objects. A source being processed can't be
 * deleted. Returns how many facts went.
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
  const rows = await ctx.tx
    .select()
    .from(f)
    .where(and(eq(f.tenantId, ctx.tenantId), eq(f.sourceId, id)));
  const ids = rows.map((r) => r.id);
  // Conflicts its facts were part of may be over once they're gone (FEAT-014 §5.3).
  const keys = new Set(
    rows.filter((r) => r.status === 'conflicted').map((r) => entityKey(inputOf(r))),
  );
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
  // A file's objects go through the outbox with the rows (ADR-012; FEAT-015 §5.7, GOV-05).
  if (isUpload(current.kind))
    await enqueue(ctx.tx, {
      tenantId: ctx.tenantId,
      topic: 'ingest',
      groupKey: id,
      payload: {
        tenantId: ctx.tenantId,
        sourceId: id,
        stage: 'purge',
        keys: {
          ...(current.uploadKey ? { quarantine: current.uploadKey } : {}),
          sources: sourcesKey(ctx.tenantId, id),
        },
      },
    });
  await settleConflicts(ctx.tx, ctx.tenantId, { type: 'user', id: ctx.userId }, keys);
  return ids.length;
}

/**
 * Each source's facts now, and how many still need review (SCR-APP-023 "N facts · N need
 * review"; the delete confirm's count). Live, so facts the owner deleted aren't counted.
 */
export async function sourceFactCounts(
  ctx: DashboardKbContext,
): Promise<Map<string, { facts: number; needsReview: number }>> {
  const f = schema.facts;
  const rows = await ctx.tx
    .select({
      sourceId: f.sourceId,
      facts: sql<number>`count(*)::int`,
      needsReview: sql<number>`(count(*) filter (where ${f.status} = 'needs_review'))::int`,
    })
    .from(f)
    .where(and(eq(f.tenantId, ctx.tenantId), sql`${f.sourceId} is not null`))
    .groupBy(f.sourceId);
  return new Map(rows.map((r) => [r.sourceId!, { facts: r.facts, needsReview: r.needsReview }]));
}
