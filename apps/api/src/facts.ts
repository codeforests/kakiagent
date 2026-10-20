import {
  CreateFactBody,
  FactList,
  FactListQuery,
  FactResponse,
  FaqValueInput,
  ProductValueInput,
  UpdateFactBody,
  type Fact,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import {
  contentChanged,
  createFact,
  dashboardKb,
  getFact,
  listFacts,
  mergePatch,
  prepareChunk,
  updateFact,
  type FactInput,
  type FactPatch,
  type FactRecord,
} from '@kaki/kb';
import type { FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
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

function toFact(r: FactRecord): Fact {
  const base = {
    id: r.id,
    status: r.status,
    version: r.version,
    source: r.source,
    updatedAt: r.updatedAt.toISOString(),
  };
  if (r.type === 'product')
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
  return { ...base, type: 'faq', value: r.value, gstTreatment: null };
}

function productValue(v: { name: string; price: string; unit?: string | undefined }) {
  return { name: v.name, priceCents: toCents(v.price), currency: 'SGD' as const, unit: v.unit };
}

/**
 * Facts entered by hand (KB-07; FEAT-022 design §3.2), dashboard trust zone. The
 * tenant comes from the session only. Embedding happens before the transaction (D4);
 * the fact, its version, its chunk and the audit entry commit together, so the next
 * visitor turn sees the change.
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
    const facts = await withTenant(dashboardDb, s.tenantId, (tx) =>
      listFacts(dashboardKb(tx, s.tenantId, s.userId), query),
    );
    return FactList.parse({ facts: facts.map(toFact) });
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
    const body = CreateFactBody.parse(req.body);
    const input: FactInput =
      body.type === 'product'
        ? { type: 'product', value: productValue(body.value), gstTreatment: body.gstTreatment }
        : { type: 'faq', value: body.value, gstTreatment: null };
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
    // The value is validated against the fact's own type; FAQs have no GST treatment.
    const patch: FactPatch = { version: body.version, status: body.status };
    if (current.type === 'product') {
      if (body.value) patch.value = productValue(ProductValueInput.parse(body.value));
      patch.gstTreatment = body.gstTreatment;
    } else {
      if (body.gstTreatment) throw new ZodError([]);
      if (body.value) patch.value = FaqValueInput.parse(body.value);
    }
    const next = mergePatch(current, patch);
    const chunk = contentChanged(current, next)
      ? await prepareChunk(llm, s.tenantId, next)
      : undefined;
    const fact = await withTenant(dashboardDb, s.tenantId, (tx) =>
      updateFact(dashboardKb(tx, s.tenantId, s.userId), id, patch, chunk),
    );
    return FactResponse.parse({ fact: toFact(fact) });
  });
}

/** A malformed ID is reported like a missing fact. */
class FactNotFound extends Error {}
export { FactNotFound };
