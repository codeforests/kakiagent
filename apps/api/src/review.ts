import {
  ApproveAllBody,
  ApproveAllResponse,
  ApproveFactBody,
  ApprovePreview,
  ApproveSelectionResponse,
  FactResponse,
  RejectFactBody,
  RejectSelectionResponse,
  ReviewList,
  ReviewListQuery,
  ReviewScopeQuery,
  ReviewIntervalsBody,
  ReviewIntervalsResponse,
  ReviewSummary,
  SelectionBody,
  UndoBody,
  UndoResponse,
  type ReviewFact,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import { reviewIntervals, saveReviewIntervals } from '@kaki/tenancy';
import {
  approveAll,
  approveFact,
  approveSelected,
  contentChanged,
  dashboardKb,
  getFact,
  listReviewFacts,
  mergePatch,
  prepareChunk,
  previewApproveAll,
  rejectFact,
  rejectSelected,
  reviewSummary,
  undoReview,
  type ApprovePreview as KbPreview,
  type ReviewRecord,
} from '@kaki/kb';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { bodyOf } from './corrections.js';
import { FactNotFound, ForbiddenError, patchOf, toFact } from './facts.js';
import type { App, Deps } from './server.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toReviewFact(r: ReviewRecord): ReviewFact {
  return {
    ...toFact(r),
    passage: r.passage,
    sourceName: r.sourceName,
    sourceCapturedAt: r.sourceCapturedAt?.toISOString() ?? null,
  };
}

/** The contract's preview: the scope without unset keys. */
export const toPreview = (p: KbPreview) =>
  ApprovePreview.parse({
    ...p,
    scope: {
      ...(p.scope.sourceId ? { sourceId: p.scope.sourceId } : {}),
      ...(p.scope.type ? { type: p.scope.type } : {}),
    },
  });

/**
 * Fact review (KB-16; FEAT-013 §3), dashboard trust zone, `kb.manage`. Every decision
 * is a command on the kb module, which audits each fact (ADR-010 decision 3); "edit
 * and approve" embeds before the transaction like any edit (FEAT-022 D4).
 */
export function registerReviewRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, llm } = deps;

  async function reviewer(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'kb.manage')) throw new ForbiddenError('kb.manage');
    return s;
  }
  const inTenant = <T>(s: TenantSession, fn: (ctx: ReturnType<typeof dashboardKb>) => Promise<T>) =>
    withTenant(dashboardDb, s.tenantId, (tx) => fn(dashboardKb(tx, s.tenantId, s.userId)));
  const factId = (id: string) => {
    if (!UUID_RE.test(id)) throw new FactNotFound();
    return id;
  };

  app.get('/api/v1/kb/review/facts', async (req) => {
    const s = await reviewer(req);
    const { cursor, limit, ...scope } = ReviewListQuery.parse(req.query);
    const page = await inTenant(s, (ctx) => listReviewFacts(ctx, scope, cursor, limit));
    return ReviewList.parse({ facts: page.facts.map(toReviewFact), nextCursor: page.nextCursor });
  });

  app.get('/api/v1/kb/review/summary', async (req) => {
    const s = await reviewer(req);
    return ReviewSummary.parse(await inTenant(s, reviewSummary));
  });

  // Review intervals per fact type (KB-17; FEAT-018 §3, D6): last write wins.
  app.get('/api/v1/kb/review-intervals', async (req) => {
    const s = await reviewer(req);
    const intervals = await withTenant(dashboardDb, s.tenantId, (tx) =>
      reviewIntervals(tx, s.tenantId),
    );
    return ReviewIntervalsResponse.parse({ intervals });
  });

  app.put('/api/v1/kb/review-intervals', async (req) => {
    const s = await reviewer(req);
    const { intervals } = bodyOf(ReviewIntervalsBody, req.body);
    const saved = await withTenant(dashboardDb, s.tenantId, (tx) =>
      saveReviewIntervals(tx, s.tenantId, s.userId, intervals),
    );
    return ReviewIntervalsResponse.parse({ intervals: saved });
  });

  app.get('/api/v1/kb/review/preview', async (req) => {
    const s = await reviewer(req);
    const scope = ReviewScopeQuery.parse(req.query);
    return toPreview(await inTenant(s, (ctx) => previewApproveAll(ctx, scope)));
  });

  app.post('/api/v1/kb/review/approve-all', async (req) => {
    const s = await reviewer(req);
    const { previewHash, ...scope } = ApproveAllBody.parse(req.body);
    const { facts } = await inTenant(s, (ctx) => approveAll(ctx, scope, previewHash));
    return ApproveAllResponse.parse({ approved: facts.length, facts });
  });

  app.post<{ Params: { id: string } }>('/api/v1/kb/facts/:id/approve', async (req) => {
    const s = await reviewer(req);
    const id = factId(req.params.id);
    const body = ApproveFactBody.parse(req.body);
    const current = await inTenant(s, (ctx) => getFact(ctx, id));
    const next = mergePatch(current, patchOf(current, body));
    const edit = contentChanged(current, next)
      ? { next, chunk: await prepareChunk(llm, s.tenantId, next) }
      : undefined;
    const fact = await inTenant(s, (ctx) => approveFact(ctx, id, body.version, edit));
    return FactResponse.parse({ fact: toFact(fact) });
  });

  app.post<{ Params: { id: string } }>('/api/v1/kb/facts/:id/reject', async (req) => {
    const s = await reviewer(req);
    const id = factId(req.params.id);
    const { version } = RejectFactBody.parse(req.body);
    const fact = await inTenant(s, (ctx) => rejectFact(ctx, id, version));
    return FactResponse.parse({ fact: toFact(fact) });
  });

  app.post('/api/v1/kb/review/approve', async (req) => {
    const s = await reviewer(req);
    const { facts } = SelectionBody.parse(req.body);
    return ApproveSelectionResponse.parse(await inTenant(s, (ctx) => approveSelected(ctx, facts)));
  });

  app.post('/api/v1/kb/review/reject', async (req) => {
    const s = await reviewer(req);
    const { facts } = SelectionBody.parse(req.body);
    return RejectSelectionResponse.parse(await inTenant(s, (ctx) => rejectSelected(ctx, facts)));
  });

  app.post('/api/v1/kb/review/undo', async (req) => {
    const s = await reviewer(req);
    const { facts } = UndoBody.parse(req.body);
    return UndoResponse.parse(await inTenant(s, (ctx) => undoReview(ctx, facts)));
  });
}
