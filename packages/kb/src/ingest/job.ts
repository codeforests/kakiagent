import { and, eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, type AuditPayload } from '@kaki/governance';
import type { LlmGateway } from '@kaki/llm-gateway';
import { EmbeddingUnavailableError } from '../errors.js';
import {
  enqueueStage,
  type SourceFailure,
  type SourceRecord,
  type SourceStage,
} from '../sources.js';
import {
  crawlSource,
  hostsOf,
  StaleRunError,
  type CrawlOptions,
  type PageFetcher,
  type PageFetcherFactory,
} from './crawl.js';
import { ExtractionUnavailableError, extractSource, type ExtractOptions } from './extract.js';
import { parseFileSource } from './files/parse-stage.js';
import { ScannerUnavailableError, type FileDeps, type FileType } from './files/ports.js';
import { scanFile } from './files/scan-stage.js';
import { promoteSource } from './promote.js';

export interface StageJobBody {
  tenantId: string;
  sourceId: string;
  attempt: number;
  stage: SourceStage;
}

/** Deletes a deleted file's objects (FEAT-015 §5.7); the source row is already gone. */
export interface PurgeJobBody {
  tenantId: string;
  sourceId: string;
  stage: 'purge';
  keys: { quarantine?: string | undefined; sources?: string | undefined };
}

export type IngestJobBody = StageJobBody | PurgeJobBody;

export interface IngestDeps {
  /** The ingest trust zone (FEAT-012 §4). */
  zdb: ZoneDb;
  llm: LlmGateway;
  /** A fetcher, or a factory opening one per crawl (the worker's browser context). */
  fetcher: PageFetcher | PageFetcherFactory;
  crawl?: CrawlOptions;
  extract?: ExtractOptions;
  /** The file stages' storage, scanner and OCR (FEAT-015 §5.1). */
  files?: FileDeps;
  /**
   * The receive on which a transiently failing stage gives up and fails the source, one
   * below the queue's DLQ threshold so a source never stays `processing` (§5.1 step 3).
   */
  maxAttempts?: number;
}

export type IngestOutcome =
  | { result: 'stale' }
  | { result: 'purged' }
  | { result: 'next'; stage: SourceStage; type?: FileType }
  | { result: 'ready'; facts: number }
  /** `signature` is the scanner's name for the malware: logged, never audited (NFR-11). */
  | { result: 'failed'; failure: SourceFailure; signature?: string };

export const DEFAULT_MAX_ATTEMPTS = 5;

const ofSource = (job: StageJobBody) =>
  and(eq(schema.kbSources.tenantId, job.tenantId), eq(schema.kbSources.id, job.sourceId));

/** Sets the source's status (and more) only while it is still this job's run. */
async function transition(
  zdb: ZoneDb,
  job: StageJobBody,
  from: readonly SourceRecord['status'][],
  set: Partial<typeof schema.kbSources.$inferInsert>,
): Promise<void> {
  await withTenant(zdb, job.tenantId, async (tx) => {
    const [current] = await tx.select().from(schema.kbSources).where(ofSource(job)).for('update');
    if (!current || current.attempt !== job.attempt || !from.includes(current.status)) return;
    await tx
      .update(schema.kbSources)
      .set({ ...set, updatedAt: sql`now()` })
      .where(ofSource(job));
  });
}

/**
 * Runs one stage of a source's ingestion (ADR-018 decision 1; FEAT-012 §5.1). Idempotent
 * on (source, stage, attempt): a job for another attempt or stage, or for a source that
 * is gone, finished or failed, does nothing. A stage that finishes writes the next stage
 * and its job in one transaction. A transient error leaves the source `queued` and is
 * rethrown for SQS to redeliver, until `maxAttempts`, when the source fails with nothing
 * of the run left behind (KB-12).
 */
export async function runIngestJob(
  deps: IngestDeps,
  job: IngestJobBody,
  receiveCount: number,
): Promise<IngestOutcome> {
  if (job.stage === 'purge') {
    // The source row is gone; deleting a missing object is a no-op (FEAT-015 §5.7).
    const store = needFiles(deps).store;
    if (job.keys.quarantine) await store.delete('quarantine', job.keys.quarantine);
    if (job.keys.sources) await store.delete('sources', job.keys.sources);
    return { result: 'purged' };
  }
  const { zdb } = deps;
  const source = await withTenant(zdb, job.tenantId, async (tx) => {
    const [row] = await tx.select().from(schema.kbSources).where(ofSource(job)).for('update');
    if (
      !row ||
      row.attempt !== job.attempt ||
      row.stage !== job.stage ||
      (row.status !== 'queued' && row.status !== 'processing')
    )
      return null;
    const [started] = await tx
      .update(schema.kbSources)
      .set({ status: 'processing', updatedAt: sql`now()` })
      .where(ofSource(job))
      .returning();
    return started!;
  });
  if (!source) return { result: 'stale' };

  const next = (
    stage: SourceStage,
    set: Partial<typeof schema.kbSources.$inferInsert> = {},
    also?: (tx: Tx) => Promise<unknown>,
  ) =>
    withTenant(zdb, job.tenantId, async (tx) => {
      const [current] = await tx.select().from(schema.kbSources).where(ofSource(job)).for('update');
      if (!current || current.attempt !== job.attempt || current.status !== 'processing')
        throw new StaleRunError('source changed');
      await tx
        .update(schema.kbSources)
        .set({ ...set, stage, updatedAt: sql`now()` })
        .where(ofSource(job));
      await enqueueStage(tx, current, stage);
      await also?.(tx);
    });
  const sourceAudit = (tx: Tx, action: string, payload: AuditPayload) =>
    audit.append(tx, job.tenantId, {
      action,
      actorType: 'system',
      actorId: 'ingest-worker',
      subjectType: 'kb_source',
      subjectId: job.sourceId,
      payload,
    });

  try {
    switch (job.stage) {
      case 'scan': {
        const outcome = await scanFile(source, needFiles(deps));
        if (outcome.next === 'failed') {
          // KB-11: the file was deleted unread; the rejection is audited with the failure.
          await fail(zdb, job, outcome.failure, (tx) =>
            sourceAudit(tx, 'kb_source.rejected', { reason: auditCode(outcome.failure) }),
          );
          return outcome.signature
            ? { result: 'failed', failure: outcome.failure, signature: outcome.signature }
            : { result: 'failed', failure: outcome.failure };
        }
        await next(
          'parse',
          {
            fileType: outcome.type,
            fileKey: outcome.fileKey,
            fileSize: outcome.size,
            scannedAt: new Date(),
          },
          (tx) =>
            sourceAudit(tx, 'kb_source.scanned', {
              type: auditCode(outcome.type),
              verdict: auditCode('clean'),
            }),
        );
        return { result: 'next', stage: 'parse', type: outcome.type };
      }
      case 'parse': {
        const outcome = await parseFileSource(zdb, source, needFiles(deps));
        if (outcome.next === 'failed') {
          await fail(zdb, job, outcome.failure);
          return { result: 'failed', failure: outcome.failure };
        }
        await next('extract');
        return { result: 'next', stage: 'extract' };
      }
      case 'crawl': {
        const fetcher =
          typeof deps.fetcher === 'function'
            ? await deps.fetcher({ hosts: hostsOf(source) })
            : deps.fetcher;
        let outcome;
        try {
          outcome = await crawlSource(zdb, source, fetcher, deps.crawl);
        } finally {
          await fetcher.close?.();
        }
        if (outcome.next === 'failed') {
          await fail(zdb, job, outcome.failure);
          return { result: 'failed', failure: outcome.failure };
        }
        await next('extract');
        return { result: 'next', stage: 'extract' };
      }
      case 'extract':
        await extractSource(zdb, source, deps.llm, deps.extract);
        await next('promote');
        return { result: 'next', stage: 'promote' };
      case 'promote':
        return { result: 'ready', facts: await promoteSource(zdb, source, deps.llm) };
    }
  } catch (err) {
    if (err instanceof StaleRunError) return { result: 'stale' };
    if (receiveCount >= (deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      const failure: SourceFailure =
        err instanceof ExtractionUnavailableError || err instanceof EmbeddingUnavailableError
          ? 'extraction_unavailable'
          : err instanceof ScannerUnavailableError
            ? 'scan_unavailable'
            : 'internal';
      await fail(zdb, job, failure);
      return { result: 'failed', failure };
    }
    // Waiting for the redelivery: the owner sees "queued" at this stage (UC-03 5c).
    await transition(zdb, job, ['processing'], { status: 'queued' });
    throw err;
  }
}

/** A file job on a worker wired without file deps: a configuration error, never retried away. */
function needFiles(deps: IngestDeps): FileDeps {
  if (!deps.files) throw new Error('this worker has no file storage, scanner or OCR');
  return deps.files;
}

/** Fails the run: the reason, no stage, and the attempt's staging removed (KB-12). */
async function fail(
  zdb: ZoneDb,
  job: StageJobBody,
  failure: SourceFailure,
  also?: (tx: Tx) => Promise<unknown>,
) {
  await withTenant(zdb, job.tenantId, async (tx) => {
    const [current] = await tx.select().from(schema.kbSources).where(ofSource(job)).for('update');
    if (!current || current.attempt !== job.attempt) return;
    if (current.status !== 'processing' && current.status !== 'queued') return;
    const st = schema.kbStagedFacts;
    await tx.delete(st).where(and(eq(st.tenantId, job.tenantId), eq(st.sourceId, job.sourceId)));
    await tx
      .update(schema.kbSources)
      .set({
        status: 'failed',
        stage: null,
        failure,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
        version: sql`${schema.kbSources.version} + 1`,
      })
      .where(ofSource(job));
    await also?.(tx);
  });
}
