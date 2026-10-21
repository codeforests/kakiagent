import {
  CreateSourceBody,
  RetrySourceBody,
  SourceDetail,
  SourceList,
  SourceResponse,
  type Source,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import {
  assertPublicHost,
  createWebsiteSource,
  dashboardKb,
  deleteSource,
  getSource,
  listSources,
  parseWebsite,
  retrySource,
  sourceFactCounts,
  SourceNotFoundError,
  type Resolver,
  type SourceRecord,
} from '@kaki/kb';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** `attested` missing or false (KB-13, UC-03 4b): nothing is written. */
export class AttestationRequiredError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DeleteQuery = z.object({ version: z.coerce.number().int().min(1) });

type Counts = { facts: number; needsReview: number };

function toSource(r: SourceRecord, counts: Counts | undefined): Source {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    stage: r.stage,
    name: r.domain,
    url: r.url,
    domain: r.domain,
    subdomains: r.subdomains,
    pageLimit: r.pageLimit,
    failure: r.failure,
    counts: {
      pagesFound: r.pagesFound,
      pagesIncluded: r.pagesIncluded,
      pagesExcluded: r.pagesExcluded,
      pagesFailed: r.pagesFailed,
      pagesSkipped: r.pagesSkipped,
      pagesExtracted: r.pagesExtracted,
      facts: counts?.facts ?? 0,
      factsNeedingReview: counts?.needsReview ?? 0,
    },
    attestedAt: r.attestedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    version: r.version,
  };
}

/**
 * The knowledge-source routes (KB-01, KB-12, KB-13; FEAT-012 §3.2), dashboard trust zone,
 * for roles with `kb.manage`. The website's host is resolved before anything is written,
 * so a private address is refused with a clear error (§7 D7); the worker guards every
 * request again. `resolve` is for tests.
 */
export function registerSourceRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
  opts: { resolve?: Resolver } = {},
) {
  const { dashboardDb, config } = deps;

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'kb.manage')) throw new ForbiddenError('kb.manage');
    return s;
  }
  const sourceId = (id: string) => {
    if (!UUID_RE.test(id)) throw new SourceNotFoundError('source not found');
    return id;
  };
  const withKb = <T>(s: TenantSession, fn: (ctx: ReturnType<typeof dashboardKb>) => Promise<T>) =>
    withTenant(dashboardDb, s.tenantId, (tx) => fn(dashboardKb(tx, s.tenantId, s.userId)));
  const withCounts = async (ctx: ReturnType<typeof dashboardKb>, r: SourceRecord) =>
    toSource(r, (await sourceFactCounts(ctx)).get(r.id));

  app.get('/api/v1/kb/sources', async (req) => {
    const s = await manager(req);
    const body = await withKb(s, async (ctx) => {
      const [rows, counts] = await Promise.all([listSources(ctx), sourceFactCounts(ctx)]);
      return { sources: rows.map((r) => toSource(r, counts.get(r.id))) };
    });
    return SourceList.parse({ ...body, pageLimit: config.CRAWL_PAGE_LIMIT });
  });

  app.post('/api/v1/kb/sources', async (req, reply) => {
    const s = await manager(req);
    const body = CreateSourceBody.parse(req.body);
    if (body.attested !== true) throw new AttestationRequiredError();
    const scope = parseWebsite(body.url, body.subdomains ?? []);
    await assertPublicHost(new URL(scope.url).hostname, {
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
      allowPrivate: config.CRAWL_ALLOW_PRIVATE_HOSTS,
    });
    const source = await withKb(s, async (ctx) =>
      withCounts(
        ctx,
        await createWebsiteSource(ctx, scope, { pageLimit: config.CRAWL_PAGE_LIMIT }),
      ),
    );
    return reply.code(201).send(SourceResponse.parse({ source }));
  });

  app.get<{ Params: { id: string } }>('/api/v1/kb/sources/:id', async (req) => {
    const s = await manager(req);
    const id = sourceId(req.params.id);
    const detail = await withKb(s, async (ctx) => {
      const { source, pages } = await getSource(ctx, id);
      return { source: await withCounts(ctx, source), pages };
    });
    return SourceDetail.parse(detail);
  });

  app.post<{ Params: { id: string } }>('/api/v1/kb/sources/:id/retry', async (req) => {
    const s = await manager(req);
    const id = sourceId(req.params.id);
    const { version } = RetrySourceBody.parse(req.body);
    const source = await withKb(s, async (ctx) =>
      withCounts(ctx, await retrySource(ctx, id, version)),
    );
    return SourceResponse.parse({ source });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/kb/sources/:id', async (req, reply) => {
    const s = await manager(req);
    const id = sourceId(req.params.id);
    const { version } = DeleteQuery.parse(req.query);
    await withKb(s, (ctx) => deleteSource(ctx, id, version));
    return reply.code(204).send();
  });
}
