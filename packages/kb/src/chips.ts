import { and, eq, inArray, schema, type Tx } from '@kaki/db';
import { factLabel } from './corrections.js';
import type { FactStatus, FactType } from './facts.js';
import type { FactInput } from './types.js';

/** The contract's `FactChip` (FEAT-042 §3). */
export interface FactChip {
  id: string;
  type: FactType;
  label: string;
  status: FactStatus;
}

/**
 * The inbox's fact chips (INB-04; FEAT-042 §5.2): label, type and current status of each
 * fact an AI answer used, so a since-disabled fact shows as such. Missing IDs are dropped;
 * order follows `ids`.
 */
export async function factChips(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<FactChip[]> {
  if (ids.length === 0) return [];
  const f = schema.facts;
  const rows = await tx
    .select({ id: f.id, type: f.type, value: f.value, status: f.status })
    .from(f)
    .where(and(eq(f.tenantId, tenantId), inArray(f.id, [...new Set(ids)])));
  const byId = new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        type: r.type,
        label: factLabel({ type: r.type, value: r.value } as FactInput),
        status: r.status,
      },
    ]),
  );
  return [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
}
