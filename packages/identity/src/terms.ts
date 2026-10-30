import { schema, sql, type Tx } from '@kaki/db';

export type TermsDocument = (typeof schema.TERMS_DOCUMENTS)[number];

/**
 * The documents a new Owner accepts (AUTH-08) and their current versions. Constants
 * until the operator publishes versions (SCR-OPS-009, FEAT-073; FEAT-005 D9).
 */
export const CURRENT_TERMS: Record<TermsDocument, { title: string; version: string }> = {
  tos: { title: 'Terms of Service', version: '2026-10-20' },
  aup: { title: 'Acceptable Use Policy', version: '2026-10-20' },
  dpa: { title: 'Data Processing Agreement', version: '2026-10-20' },
};

export const TERMS_DOCUMENTS = schema.TERMS_DOCUMENTS;

/** True when every document's accepted version is the current one. */
export function termsAreCurrent(accepted: Record<TermsDocument, string>): boolean {
  return TERMS_DOCUMENTS.every((d) => accepted[d] === CURRENT_TERMS[d].version);
}

/**
 * True when the tenant's newest acceptance of every document is the current version (ONB-09
 * `terms`; FEAT-035 §5.1). Dashboard zone; a document never accepted is false.
 */
export async function termsAccepted(tx: Tx, tenantId: string): Promise<boolean> {
  const res = await tx.execute<{ document: TermsDocument; version: string }>(
    sql`select distinct on (document) document, version from terms_acceptances
        where tenant_id = ${tenantId} order by document, accepted_at desc`,
  );
  const accepted = Object.fromEntries(res.rows.map((r) => [r.document, r.version]));
  return termsAreCurrent(accepted as Record<TermsDocument, string>);
}
