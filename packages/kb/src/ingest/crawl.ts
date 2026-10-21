import { createHash } from 'node:crypto';
import { and, eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { piiMask } from '@kaki/platform/pii-mask';
import type { PageReason, PageStatus, SourceFailure, SourceRecord } from '../sources.js';
import { robotsPolicy, type RobotsPolicy } from './robots.js';
import { inScope, normaliseUrl } from './scope.js';

/** What the browser gives the crawler (FEAT-012 D3): Chromium in the worker, a fake in tests. */
export interface PageFetcher {
  /** A plain GET of `<origin>/robots.txt`; null when the host can't be reached. */
  robots(origin: string): Promise<{ status: number; body: string } | null>;
  page(url: string): Promise<FetchedPage>;
}

export type FetchedPage =
  | {
      ok: true;
      finalUrl: string;
      httpStatus: number;
      contentType: string;
      title: string;
      text: string;
      links: string[];
    }
  | {
      ok: false;
      reason: 'timeout' | 'http_error' | 'blocked_address' | 'load_error';
      httpStatus?: number | undefined;
    };

export interface CrawlOptions {
  /** Pages fetched at once for one source (ADR-018 decision 4). */
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type CrawlOutcome = { next: 'extract' } | { next: 'failed'; failure: SourceFailure };

/** The source was retried, deleted or finished by someone else while this run worked. */
export class StaleRunError extends Error {}

export const MAX_PAGE_TEXT = 50_000;
export const MAX_SKIPPED_ROWS = 2_000;
/** An included page with less text than this gives the extractor nothing. */
export const MIN_PAGE_TEXT = 20;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const collapse = (s: string) =>
  s
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();

interface PageRow {
  seq: number;
  url: string;
  status: PageStatus;
  reason: PageReason | null;
  httpStatus?: number | undefined;
  title?: string | null | undefined;
  content?: string | null | undefined;
  contentHash?: string | null | undefined;
}

/**
 * Crawls a website source's current attempt (KB-01, KB-13; FEAT-012 §5.2): breadth-first
 * from the start URL, within the confirmed hosts, obeying robots.txt, up to the source's
 * page limit; every URL it meets is listed with its result. Pages are written as they
 * finish, with the source's counts, so the page list grows while the owner watches.
 * Throws `StaleRunError` if the source stops being this run's.
 */
export async function crawlSource(
  zdb: ZoneDb,
  source: SourceRecord,
  fetcher: PageFetcher,
  opts: CrawlOptions = {},
): Promise<CrawlOutcome> {
  const concurrency = opts.concurrency ?? 4;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const hosts = [source.domain, `www.${source.domain}`, ...source.subdomains];
  const { tenantId, id: sourceId, attempt } = source;

  // A redelivered crawl starts again: the attempt's pages from a crashed run go first.
  await withTenant(zdb, tenantId, async (tx) => {
    await assertRun(tx);
    await tx
      .delete(schema.kbSourcePages)
      .where(
        and(
          eq(schema.kbSourcePages.tenantId, tenantId),
          eq(schema.kbSourcePages.sourceId, sourceId),
          eq(schema.kbSourcePages.attempt, attempt),
        ),
      );
  });

  async function assertRun(tx: Tx) {
    const [row] = await tx
      .select({ attempt: schema.kbSources.attempt, status: schema.kbSources.status })
      .from(schema.kbSources)
      .where(and(eq(schema.kbSources.tenantId, tenantId), eq(schema.kbSources.id, sourceId)))
      .for('update');
    if (!row || row.attempt !== attempt || row.status !== 'processing')
      throw new StaleRunError('source changed');
  }

  const counts = { found: 0, included: 0, excluded: 0, failed: 0, skipped: 0 };
  async function write(row: PageRow) {
    counts[row.status === 'included' ? 'included' : row.status] += 1;
    await withTenant(zdb, tenantId, async (tx) => {
      await assertRun(tx);
      await tx.insert(schema.kbSourcePages).values({
        tenantId,
        sourceId,
        attempt,
        seq: row.seq,
        url: row.url,
        title: row.title ?? null,
        status: row.status,
        reason: row.reason,
        httpStatus: row.httpStatus ?? null,
        content: row.content ?? null,
        contentHash: row.contentHash ?? null,
      });
      await tx
        .update(schema.kbSources)
        .set({
          pagesFound: counts.found,
          pagesIncluded: counts.included,
          pagesExcluded: counts.excluded,
          pagesFailed: counts.failed,
          pagesSkipped: counts.skipped,
          updatedAt: sql`now()`,
        })
        .where(and(eq(schema.kbSources.tenantId, tenantId), eq(schema.kbSources.id, sourceId)));
    });
  }

  const robots = new Map<string, Promise<RobotsPolicy>>();
  const policyFor = (url: string) => {
    const origin = new URL(url).origin;
    let p = robots.get(origin);
    if (!p) {
      p = fetcher.robots(origin).then(robotsPolicy, () => robotsPolicy(null));
      robots.set(origin, p);
    }
    return p;
  };
  const lastRequest = new Map<string, number>();
  async function politely(url: string, delayS: number) {
    if (delayS <= 0) return;
    const host = new URL(url).host;
    const wait = (lastRequest.get(host) ?? 0) + delayS * 1000 - Date.now();
    lastRequest.set(host, Math.max(Date.now(), (lastRequest.get(host) ?? 0) + delayS * 1000));
    if (wait > 0) await sleep(wait);
  }

  const seen = new Set<string>();
  const hashes = new Set<string>();
  const queue: { url: string; seq: number }[] = [];
  let nextSeq = 0;
  function discover(url: string) {
    if (seen.has(url)) return;
    seen.add(url);
    counts.found += 1;
    queue.push({ url, seq: nextSeq++ });
  }
  discover(source.url);

  let inFlight = 0;
  let waiters: (() => void)[] = [];
  const changed = () => new Promise<void>((r) => waiters.push(r));
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  };

  async function visit(item: { url: string; seq: number }) {
    const policy = await policyFor(item.url);
    if (!policy.allowed(item.url)) return write({ ...item, status: 'excluded', reason: 'robots' });
    await politely(item.url, policy.crawlDelay);
    const page = await fetcher.page(item.url);
    if (!page.ok)
      return write({ ...item, status: 'failed', reason: page.reason, httpStatus: page.httpStatus });
    const finalUrl = normaliseUrl(page.finalUrl) ?? item.url;
    if (!inScope(finalUrl, hosts))
      return write({ ...item, status: 'excluded', reason: 'off_domain_redirect' });
    if (finalUrl !== item.url) {
      if (seen.has(finalUrl))
        return write({
          ...item,
          status: 'excluded',
          reason: 'duplicate',
          httpStatus: page.httpStatus,
        });
      seen.add(finalUrl);
    }
    if (page.httpStatus >= 400)
      return write({
        ...item,
        status: 'failed',
        reason: 'http_error',
        httpStatus: page.httpStatus,
      });
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(page.contentType))
      return write({
        ...item,
        status: 'excluded',
        reason: 'not_html',
        httpStatus: page.httpStatus,
      });
    const content = piiMask(collapse(page.text)).slice(0, MAX_PAGE_TEXT);
    const contentHash = sha256(content);
    if (hashes.has(contentHash))
      return write({
        ...item,
        status: 'excluded',
        reason: 'duplicate',
        httpStatus: page.httpStatus,
      });
    hashes.add(contentHash);
    for (const href of page.links) {
      const link = normaliseUrl(href, finalUrl);
      if (link && inScope(link, hosts)) discover(link);
    }
    return write({
      ...item,
      status: 'included',
      reason: null,
      httpStatus: page.httpStatus,
      title: page.title.trim().slice(0, 300) || null,
      content,
      contentHash,
    });
  }

  let firstError: unknown = null;
  async function worker() {
    while (firstError === null) {
      const item = queue.shift();
      if (!item) {
        if (inFlight === 0) return;
        await changed();
        continue;
      }
      if (counts.included >= source.pageLimit) {
        if (counts.skipped < MAX_SKIPPED_ROWS)
          await write({ ...item, status: 'skipped', reason: 'plan_limit' });
        continue;
      }
      if (counts.included + inFlight >= source.pageLimit) {
        // The limit may be reached by pages still loading: decide after they finish.
        queue.unshift(item);
        await changed();
        continue;
      }
      inFlight += 1;
      try {
        await visit(item);
      } catch (err) {
        firstError ??= err;
      } finally {
        inFlight -= 1;
        wake();
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (firstError !== null) throw firstError;

  if (counts.included > 0) return { next: 'extract' };
  return {
    next: 'failed',
    failure: counts.failed > 0 && counts.excluded === 0 ? 'site_unreachable' : 'no_pages',
  };
}
