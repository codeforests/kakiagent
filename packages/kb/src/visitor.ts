import { sql } from '@kaki/db';
import { vectorLiteral } from './chunk.js';
import type { VisitorKbContext } from './context.js';
import type { VisitorFact } from './types.js';

export interface SearchOptions {
  /** Facts to return at most. */
  k?: number;
  /** Cosine distance above which a chunk is not a match (0 = identical, 2 = opposite). */
  maxDistance?: number;
}

export const DEFAULT_SEARCH: Required<SearchOptions> = { k: 6, maxDistance: 0.85 };

/**
 * `lookup_kb` for the visitor scope (AGT-06, ADR-005, ADR-009): exact k-NN over the
 * tenant's visitor-visible chunks. It reads only the visitor views, under RLS, and
 * also filters by tenant explicitly.
 */
export async function searchVisitorFacts(
  ctx: VisitorKbContext,
  embedding: number[],
  opts: SearchOptions = {},
): Promise<(VisitorFact & { distance: number })[]> {
  const { k, maxDistance } = { ...DEFAULT_SEARCH, ...opts };
  const res = await ctx.tx.execute<{
    id: string;
    type: VisitorFact['type'];
    version: number;
    value: VisitorFact['value'];
    gst_treatment: VisitorFact['gstTreatment'];
    valid_until: Date | string | null;
    distance: number;
  }>(sql`
    select vf.id, vf.type, vf.version, vf.value, vf.gst_treatment, vf.valid_until,
           (c.embedding <=> ${vectorLiteral(embedding)}::vector) as distance
    from visitor_chunks c
    join visitor_facts vf on vf.tenant_id = c.tenant_id and vf.id = c.fact_id
    where c.tenant_id = ${ctx.tenantId} and vf.tenant_id = ${ctx.tenantId}
    order by distance
    limit ${k}`);
  return res.rows
    .filter((r) => Number(r.distance) <= maxDistance)
    .map(
      (r) =>
        ({
          id: r.id,
          type: r.type,
          version: r.version,
          value: r.value,
          gstTreatment: r.gst_treatment,
          ...(r.type === 'promotion'
            ? { validUntil: r.valid_until === null ? null : new Date(r.valid_until) }
            : {}),
          distance: Number(r.distance),
        }) as VisitorFact & { distance: number },
    );
}
