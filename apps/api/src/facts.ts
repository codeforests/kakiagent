import {
  CreateFactBody,
  FactList,
  FactListQuery,
  FactResponse,
  FaqValueInput,
  PolicyValueInput,
  ProductValueInput,
  PromotionValueInput,
  UpdateFactBody,
  type Fact,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import {
  contentChanged,
  createFact,
  dashboardKb,
  deleteFact,
  getFact,
  listFacts,
  mergePatch,
  prepareChunk,
  sgDateOf,
  sgDayAfter,
  sgDayStart,
  sgLastDayOf,
  updateFact,
  type FactInput,
  type FactPatch,
  type FactRecord,
  type PromotionValue,
} from '@kaki/kb';
import type { FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { TenantSession } from './auth.js';
import type { App, Deps } from './server.js';

export class ForbiddenError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dollars as typed → integer cents, without floating point. */
export function toCents(price: string): number {
  const [dollars, cents = ''] = price.split('.');
  return Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
}

export const fromCents = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

export function toFact(r: FactRecord): Fact {
  const base = {
    id: r.id,
    status: r.status,
    version: r.version,
    source: r.source,
    updatedAt: r.updatedAt.toISOString(),
    validFrom: null,
    validUntil: null,
    sourceId: r.sourceId,
    confidence: r.confidence,
    provenance: r.provenance && r.sourceId ? { sourceId: r.sourceId, ...r.provenance } : null,
  };
  switch (r.type) {
    case 'product':
      return {
        ...base,
        type: 'product',
        value: {
          name: r.value.name,
          price: fromCents(r.value.priceCents),
          ...(r.value.unit ? { unit: r.value.unit } : {}),
        },
        gstTreatment: r.gstTreatment,
      };
    case 'faq':
      return { ...base, type: 'faq', value: r.value, gstTreatment: null };
    case 'policy':
      return { ...base, type: 'policy', value: r.value, gstTreatment: null };
    case 'promotion': {
      const { validFrom, validUntil } = r.validity;
      return {
        ...base,
        type: 'promotion',
        value: {
          title: r.value.title,
          details: r.value.details,
          ...(r.value.priceCents !== undefined ? { price: fromCents(r.value.priceCents) } : {}),
        },
        gstTreatment: r.gstTreatment,
        validFrom: validFrom ? sgDateOf(validFrom) : null,
        validUntil: validUntil ? sgLastDayOf(validUntil) : null,
      };
    }
  }
}

function productValue(v: z.infer<typeof ProductValueInput>) {
  return { name: v.name, priceCents: toCents(v.price), currency: 'SGD' as const, unit: v.unit };
}

function promotionValue(v: z.infer<typeof PromotionValueInput>): PromotionValue {
  const { title, details } = v;
  return v.price === undefined
    ? { title, details }
    : { title, details, priceCents: toCents(v.price), currency: 'SGD' };
}

/** The stored input for a validated create body (FEAT-011 §3.2). */
function inputOf(body: CreateFactBody): FactInput {
  switch (body.type) {
    case 'product':
      return { type: 'product', value: productValue(body.value), gstTreatment: body.gstTreatment };
    case 'faq':
      return { type: 'faq', value: body.value, gstTreatment: null };
    case 'policy':
      return { type: 'policy', value: body.value, gstTreatment: null };
    case 'promotion':
      return {
        type: 'promotion',
        value: promotionValue(body.value),
        gstTreatment: body.gstTreatment ?? null,
        validity: {
          validFrom: body.validFrom ? sgDayStart(body.validFrom) : null,
          validUntil: sgDayAfter(body.validUntil),
        },
      };
  }
}

/**
 * The kb patch for an edit body (FEAT-011 §3.2): the value is validated against the
 * fact's own type; only priced types take GST, and only promotions take validity (kb's
 * `mergePatch` checks the combination). Shared with "edit and approve" (FEAT-013).
 */
export function patchOf(
  current: FactRecord,
  body: Omit<UpdateFactBody, 'status'> & { status?: UpdateFactBody['status'] },
): FactPatch {
  const patch: FactPatch = { version: body.version, status: body.status };
  const priced = current.type === 'product' || current.type === 'promotion';
  if (!priced && body.gstTreatment) throw new ZodError([]);
  if (current.type !== 'promotion' && (body.validFrom !== undefined || body.validUntil))
    throw new ZodError([]);
  patch.gstTreatment = body.gstTreatment;
  if (body.value)
    switch (current.type) {
      case 'product':
        patch.value = productValue(ProductValueInput.parse(body.value));
        break;
      case 'faq':
        patch.value = FaqValueInput.parse(body.value);
        break;
      case 'policy':
        patch.value = PolicyValueInput.parse(body.value);
        break;
      case 'promotion':
        patch.value = promotionValue(PromotionValueInput.parse(body.value));
        break;
    }
  if (body.validFrom !== undefined || body.validUntil !== undefined)
    patch.validity = {
      ...(body.validFrom !== undefined
        ? { validFrom: body.validFrom === null ? null : sgDayStart(body.validFrom) }
        : {}),
      ...(body.validUntil ? { validUntil: sgDayAfter(body.validUntil) } : {}),
    };
  return patch;
}

const DeleteQuery = z.object({ version: z.coerce.number().int().min(1) });

/**
 * The KB manager's fact routes (KB-07; FEAT-022 §3.2, FEAT-011 §3), dashboard trust
 * zone. The tenant comes from the session only. Embedding happens before the
 * transaction (FEAT-022 D4); the fact, its version, its chunk and the audit entry
 * commit together, so the next visitor turn sees the change.
 */
export function registerFactRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, llm } = deps;

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'kb.manage')) throw new ForbiddenError('kb.manage');
    return s;
  }

  const factId = (id: string) => {
    if (!UUID_RE.test(id)) throw new FactNotFound();
    return id;
  };

  app.get('/api/v1/kb/facts', async (req) => {
    const s = await manager(req);
    const query = FactListQuery.parse(req.query);
    const page = await withTenant(dashboardDb, s.tenantId, (tx) =>
      listFacts(dashboardKb(tx, s.tenantId, s.userId), query),
    );
    return FactList.parse({ facts: page.facts.map(toFact), nextCursor: page.nextCursor });
  });

  app.get<{ Params: { id: string } }>('/api/v1/kb/facts/:id', async (req) => {
    const s = await manager(req);
    const id = factId(req.params.id);
    const fact = await withTenant(dashboardDb, s.tenantId, (tx) =>
      getFact(dashboardKb(tx, s.tenantId, s.userId), id),
    );
    return FactResponse.parse({ fact: toFact(fact) });
  });

  app.post('/api/v1/kb/facts', async (req, reply) => {
    const s = await manager(req);
    const input = inputOf(CreateFactBody.parse(req.body));
    const chunk = await prepareChunk(llm, s.tenantId, input);
    const fact = await withTenant(dashboardDb, s.tenantId, (tx) =>
      createFact(dashboardKb(tx, s.tenantId, s.userId), input, chunk),
    );
    return reply.code(201).send(FactResponse.parse({ fact: toFact(fact) }));
  });

  app.patch<{ Params: { id: string } }>('/api/v1/kb/facts/:id', async (req) => {
    const s = await manager(req);
    const id = factId(req.params.id);
    const body = UpdateFactBody.parse(req.body);
    const current = await withTenant(dashboardDb, s.tenantId, (tx) =>
      getFact(dashboardKb(tx, s.tenantId, s.userId), id),
    );
    const patch = patchOf(current, body);
    const next = mergePatch(current, patch);
    const chunk = contentChanged(current, next)
      ? await prepareChunk(llm, s.tenantId, next)
      : undefined;
    const fact = await withTenant(dashboardDb, s.tenantId, (tx) =>
      updateFact(dashboardKb(tx, s.tenantId, s.userId), id, patch, chunk),
    );
    return FactResponse.parse({ fact: toFact(fact) });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/kb/facts/:id', async (req, reply) => {
    const s = await manager(req);
    const id = factId(req.params.id);
    const { version } = DeleteQuery.parse(req.query);
    await withTenant(dashboardDb, s.tenantId, (tx) =>
      deleteFact(dashboardKb(tx, s.tenantId, s.userId), id, version),
    );
    return reply.code(204).send();
  });
}

/** A malformed ID is reported like a missing fact. */
class FactNotFound extends Error {}
export { FactNotFound };
