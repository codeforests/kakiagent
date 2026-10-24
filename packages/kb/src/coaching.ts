import { sql } from '@kaki/db';
import { vectorLiteral } from './chunk.js';
import type { CoachingKbContext } from './context.js';
import type { VisitorFact } from './types.js';
import { DEFAULT_SEARCH, type SearchOptions } from './visitor.js';

export type CoachingFact = VisitorFact & { distance: number; status: 'approved' | 'needs_review' };

/**
 * `lookup_kb` for coaching (AGT-17, KB-16; FEAT-027 §5.1): the same k-NN and distance cut
 * as `searchVisitorFacts`, with `visitor_facts`' validity and GST conditions, over the
 * approved facts, or also the unreviewed ones when the owner asks. Never rejected,
 * conflicted or disabled facts.
 */
export async function searchCoachingFacts(
  ctx: CoachingKbContext,
  embedding: number[],
  opts: SearchOptions & { includeUnreviewed: boolean },
): Promise<CoachingFact[]> {
  const { k, maxDistance } = { ...DEFAULT_SEARCH, ...opts };
  const statuses = opts.includeUnreviewed ? ['approved', 'needs_review'] : ['approved'];
  const res = await ctx.tx.execute<{
    id: string;
    type: VisitorFact['type'];
    version: number;
    status: CoachingFact['status'];
    value: VisitorFact['value'];
    gst_treatment: VisitorFact['gstTreatment'];
    valid_until: Date | string | null;
    distance: number;
  }>(sql`
    select f.id, f.type, f.version, f.status, f.value, f.gst_treatment, f.valid_until,
           (c.embedding <=> ${vectorLiteral(embedding)}::vector) as distance
    from kb_chunks c
    join facts f on f.tenant_id = c.tenant_id and f.id = c.fact_id and f.version = c.fact_version
    where c.tenant_id = ${ctx.tenantId} and f.tenant_id = ${ctx.tenantId}
      and f.status in (${sql.join(
        statuses.map((s) => sql`${s}`),
        sql`, `,
      )})
      and (f.valid_from is null or f.valid_from <= now())
      and (f.valid_until is null or f.valid_until > now())
      and not (
        f.gst_treatment is not null and f.gst_treatment = 'unknown'
        and coalesce((select bp.gst_registered from business_profiles bp
                      where bp.tenant_id = f.tenant_id), true)
      )
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
          status: r.status,
          value: r.value,
          gstTreatment: r.gst_treatment,
          ...(r.type === 'promotion'
            ? { validUntil: r.valid_until === null ? null : new Date(r.valid_until) }
            : {}),
          distance: Number(r.distance),
        }) as CoachingFact,
    );
}
