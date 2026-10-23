import {
  ConflictList,
  ResolveConflictBody,
  ResolveConflictResponse,
  type Conflict,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import {
  contentChanged,
  dashboardKb,
  FactNotFoundError,
  getFact,
  listConflicts,
  mergePatch,
  prepareChunk,
  resolveConflict,
  type ConflictRecord,
  type FactRecord,
} from '@kaki/kb';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { ForbiddenError, patchOf, toFact } from './facts.js';
import { toReviewFact } from './review.js';
import type { App, Deps } from './server.js';

export const toConflict = (c: ConflictRecord): Conflict => ({
  id: c.id,
  type: c.type,
  suggestedId: c.suggestedId,
  facts: c.facts.map(
    (m) =>
      ({
        ...toReviewFact(m),
        sourceDate: m.sourceDate.toISOString(),
        newer: m.newer,
      }) as Conflict['facts'][number],
  ),
});

/**
 * Conflicts (KB-06, UC-12; FEAT-014 §3), dashboard trust zone, `kb.manage`. Resolving
 * is one command on the kb module; entering a value (or choosing a price's GST
 * treatment) embeds before the transaction like any edit (FEAT-022 D4).
 */
export function registerConflictRoutes(
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

  app.get('/api/v1/kb/conflicts', async (req) => {
    const s = await reviewer(req);
    const conflicts = await inTenant(s, listConflicts);
    return ConflictList.parse({ conflicts: conflicts.map(toConflict) });
  });

  app.post('/api/v1/kb/conflicts/resolve', async (req) => {
    const s = await reviewer(req);
    const body = ResolveConflictBody.parse(req.body);
    let edit: Parameters<typeof resolveConflict>[4];
    const editing =
      body.action === 'enter' || (body.action === 'use' && body.gstTreatment !== undefined);
    if (editing) {
      // Another tenant's fact isn't found here; the command then answers conflict_changed.
      const current: FactRecord | null = await inTenant(s, (ctx) =>
        getFact(ctx, body.keepId),
      ).catch((err: unknown) => {
        if (err instanceof FactNotFoundError) return null;
        throw err;
      });
      if (current) {
        const { action: _action, facts: _facts, keepId: _keepId, ...fields } = body;
        const next = mergePatch(current, patchOf(current, { version: current.version, ...fields }));
        if (contentChanged(current, next))
          edit = { next, chunk: await prepareChunk(llm, s.tenantId, next) };
      }
    }
    const { fact, rejected } = await inTenant(s, (ctx) =>
      resolveConflict(ctx, body.facts, body.keepId, body.action, edit),
    );
    return ResolveConflictResponse.parse({ fact: toFact(fact), rejected });
  });
}
