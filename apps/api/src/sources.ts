import {
  ConfirmImportBody,
  CreateSourceBody,
  CHAT_EXTENSIONS,
  FILE_EXTENSIONS,
  ImportBody,
  ImportPreview,
  MAX_FILE_BYTES,
  RetrySourceBody,
  SHEET_EXTENSIONS,
  UPLOAD_EXTENSIONS,
  SourceDetail,
  SourceList,
  SourceResponse,
  type Source,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import {
  assertPublicHost,
  confirmImport,
  createFileSource,
  createWebsiteSource,
  dashboardKb,
  deleteSource,
  getSource,
  isUpload,
  listSources,
  parseWebsite,
  previewImport,
  retryable,
  retrySource,
  sourceFactCounts,
  SourceNotFoundError,
  type ChatRecord,
  type MappingRecord,
  type Resolver,
  type SheetRecord,
  type SourceRecord,
} from '@kaki/kb';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** `attested` missing or false (KB-13, UC-03 4b): nothing is written. */
export class AttestationRequiredError extends Error {}
/** A file name without an allowed extension (KB-02, KB-03; FEAT-015 §3.2, FEAT-016 §3.2). */
export class UnsupportedFileError extends Error {}
/** Over the 25 MB a file may be (KB-02). */
export class FileTooLargeError extends Error {}

/**
 * The early checks on a file's name and declared size; the scan decides what it is (D5).
 * An upload may be a file or a spreadsheet; a source must have its kind's extension.
 */
export function checkFile(
  fileName: string,
  sizeBytes: number,
  extensions: readonly string[] = UPLOAD_EXTENSIONS,
) {
  const name = fileName.toLowerCase();
  if (!extensions.some((ext) => name.endsWith(ext))) throw new UnsupportedFileError();
  if (sizeBytes > MAX_FILE_BYTES) throw new FileTooLargeError();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DeleteQuery = z.object({ version: z.coerce.number().int().min(1) });

type Counts = { facts: number; needsReview: number };

/** A spreadsheet's layout and confirmed mapping; who confirmed stays in the audit log. */
function sheetOf(r: SourceRecord): Source['sheet'] {
  if (r.kind !== 'spreadsheet' || !r.sheet) return null;
  const sheet = r.sheet as SheetRecord;
  const mapping = r.mapping as MappingRecord | null;
  return {
    name: sheet.name,
    headerRow: sheet.headerRow,
    rows: sheet.rows,
    rowsSkipped: sheet.rowsSkipped,
    columns: sheet.columns,
    suggested: sheet.suggested,
    mapping: mapping
      ? { columns: mapping.columns, gst: mapping.gst, confirmedAt: mapping.confirmedAt }
      : null,
  };
}

/** A chat export's redacted summary; the owner's business names aren't returned (§3.1). */
function chatOf(r: SourceRecord): Source['chat'] {
  if (r.kind !== 'chat' || !r.chat) return null;
  const { businessNames: _names, ...chat } = r.chat as ChatRecord;
  return chat.format ? (chat as Source['chat']) : null;
}

function toSource(r: SourceRecord, counts: Counts | undefined): Source {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    stage: r.stage,
    name: r.name,
    url: r.url,
    domain: r.domain,
    subdomains: r.subdomains,
    pageLimit: r.pageLimit,
    failure: r.failure,
    retryable: retryable(r),
    file: isUpload(r.kind)
      ? {
          name: r.name,
          sizeBytes: r.fileSize ?? 0,
          type: r.fileType,
          ocrPages: r.ocrPages,
          scannedAt: r.scannedAt?.toISOString() ?? null,
        }
      : null,
    sheet: sheetOf(r),
    chat: chatOf(r),
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
    attestedAt: r.attestedAt?.toISOString() ?? null,
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
    return SourceList.parse({
      ...body,
      pageLimit: config.CRAWL_PAGE_LIMIT,
      fileLimit: config.FILE_LIMIT,
      maxFileBytes: MAX_FILE_BYTES,
    });
  });

  app.post('/api/v1/kb/sources', async (req, reply) => {
    const s = await manager(req);
    const body = CreateSourceBody.parse(req.body);
    if (body.kind === 'file' || body.kind === 'spreadsheet' || body.kind === 'chat') {
      checkFile(
        body.fileName,
        body.sizeBytes,
        body.kind === 'file'
          ? FILE_EXTENSIONS
          : body.kind === 'spreadsheet'
            ? SHEET_EXTENSIONS
            : CHAT_EXTENSIONS,
      );
      const source = await withKb(s, async (ctx) =>
        withCounts(ctx, await createFileSource(ctx, body, { fileLimit: config.FILE_LIMIT })),
      );
      return reply.code(201).send(SourceResponse.parse({ source }));
    }
    if (body.attested !== true) throw new AttestationRequiredError();
    const scope = parseWebsite(body.url, body.subdomains ?? []);
    await assertPublicHost(new URL(scope.url).hostname, {
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
      // Dev-only (FEAT-012 §5.6): production builds always check the address.
      allowPrivate: process.env.KAKI_BUILD !== 'production' && config.CRAWL_ALLOW_PRIVATE_HOSTS,
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

  // The spreadsheet's mapping (KB-03, UC-10 3-5; FEAT-016 §3.2): the preview writes
  // nothing; the confirm re-runs the same validation and is the import's approval.
  app.post<{ Params: { id: string } }>('/api/v1/kb/sources/:id/preview', async (req) => {
    const s = await manager(req);
    const id = sourceId(req.params.id);
    const choice = ImportBody.parse(req.body);
    return ImportPreview.parse(await withKb(s, (ctx) => previewImport(ctx, id, choice)));
  });

  app.post<{ Params: { id: string } }>('/api/v1/kb/sources/:id/import', async (req) => {
    const s = await manager(req);
    const id = sourceId(req.params.id);
    const body = ConfirmImportBody.parse(req.body);
    const source = await withKb(s, async (ctx) =>
      withCounts(ctx, await confirmImport(ctx, id, body)),
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
