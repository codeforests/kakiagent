import { and, eq, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit } from '@kaki/governance';
import type { LlmGateway } from '@kaki/llm-gateway';
import { chunkContent } from '../chunk.js';
import { EmbeddingUnavailableError } from '../errors.js';
import type { SourceRecord } from '../sources.js';
import type { FactInput } from '../types.js';
import { StaleRunError } from './crawl.js';

export const EMBED_BATCH = 96;

/** Locks the source and checks it is still this run's (retry and delete change it). */
export async function lockRun(tx: Tx, source: SourceRecord): Promise<void> {
  const [row] = await tx
    .select({ attempt: schema.kbSources.attempt, status: schema.kbSources.status })
    .from(schema.kbSources)
    .where(and(eq(schema.kbSources.tenantId, source.tenantId), eq(schema.kbSources.id, source.id)))
    .for('update');
  if (!row || row.attempt !== source.attempt || row.status !== 'processing')
    throw new StaleRunError('source changed');
}

interface Candidate {
  input: FactInput;
  confidence: number;
  provenance: { url: string; title: string | null; quote: string; start: number; end: number };
}

/**
 * The promote stage (ADR-018 decision 7; FEAT-012 §5.4): the attempt's staged facts,
 * collapsed by entity key (highest confidence, then crawl order), minus any the tenant
 * already has word for word, are embedded and then written in **one** transaction as
 * `needs_review` facts with their versions, chunks and provenance, with one audit entry;
 * the staging is cleared and the source is `ready`. Until that commit nothing of the run
 * is a fact, so a failure leaves none behind (KB-12). Returns the number of facts.
 */
export async function promoteSource(
  zdb: ZoneDb,
  source: SourceRecord,
  llm: LlmGateway,
): Promise<number> {
  const { tenantId, id: sourceId, attempt } = source;
  const rows = await withTenant(zdb, tenantId, (tx) =>
    tx.execute<{
      type: FactInput['type'];
      value: FactInput['value'];
      gst_treatment: FactInput['gstTreatment'];
      valid_from: string | null;
      valid_until: string | null;
      quote: string;
      quote_start: number;
      quote_end: number;
      confidence: number;
      dedupe_key: string;
      url: string;
      title: string | null;
      duplicate: boolean;
    }>(sql`
      select s.type, s.value, s.gst_treatment, s.valid_from, s.valid_until, s.quote,
             s.quote_start, s.quote_end, s.confidence, s.dedupe_key, p.url, p.title,
             exists (select 1 from facts f where f.tenant_id = s.tenant_id and f.type = s.type
                     and f.value = s.value) as duplicate
      from kb_staged_facts s
        join kb_source_pages p on p.tenant_id = s.tenant_id and p.id = s.page_id
      where s.tenant_id = ${tenantId} and s.source_id = ${sourceId} and s.attempt = ${attempt}
      order by s.confidence desc, p.seq, s.quote_start`),
  );
  const byKey = new Map<string, Candidate>();
  for (const r of rows.rows) {
    if (r.duplicate || byKey.has(r.dedupe_key)) continue;
    const validity =
      r.type === 'promotion' || r.valid_from || r.valid_until
        ? {
            validFrom: r.valid_from ? new Date(r.valid_from) : null,
            validUntil: r.valid_until ? new Date(r.valid_until) : null,
          }
        : undefined;
    byKey.set(r.dedupe_key, {
      input: { type: r.type, value: r.value, gstTreatment: r.gst_treatment, validity } as FactInput,
      confidence: r.confidence,
      provenance: {
        url: r.url,
        title: r.title,
        quote: r.quote,
        start: r.quote_start,
        end: r.quote_end,
      },
    });
  }
  const candidates = [...byKey.values()];

  const embeddings: number[][] = [];
  try {
    for (let i = 0; i < candidates.length; i += EMBED_BATCH) {
      const batch = candidates.slice(i, i + EMBED_BATCH).map((c) => chunkContent(c.input));
      const { vectors } = await llm.embed({
        texts: batch,
        purpose: 'document',
        meta: { tenantId },
      });
      embeddings.push(...vectors);
    }
  } catch (err) {
    throw new EmbeddingUnavailableError('embedding failed', { cause: err });
  }

  return withTenant(zdb, tenantId, async (tx) => {
    await lockRun(tx, source);
    for (const [i, c] of candidates.entries()) {
      const [fact] = await tx
        .insert(schema.facts)
        .values({
          tenantId,
          type: c.input.type,
          status: 'needs_review',
          value: c.input.value,
          gstTreatment: c.input.gstTreatment,
          validFrom: c.input.validity?.validFrom ?? null,
          validUntil: c.input.validity?.validUntil ?? null,
          source: 'website',
          sourceId,
          confidence: c.confidence,
          provenance: c.provenance,
          createdBy: source.createdBy,
          updatedBy: source.createdBy,
        })
        .returning();
      await tx.insert(schema.factVersions).values({
        tenantId,
        factId: fact!.id,
        version: 1,
        status: 'needs_review',
        value: fact!.value,
        gstTreatment: fact!.gstTreatment,
        validFrom: fact!.validFrom,
        validUntil: fact!.validUntil,
        changedBy: source.createdBy,
      });
      await tx.insert(schema.kbChunks).values({
        tenantId,
        factId: fact!.id,
        factVersion: 1,
        content: chunkContent(c.input),
        embedding: embeddings[i]!,
      });
    }
    const st = schema.kbStagedFacts;
    await tx.delete(st).where(and(eq(st.tenantId, tenantId), eq(st.sourceId, sourceId)));
    await tx
      .update(schema.kbSources)
      .set({
        status: 'ready',
        stage: null,
        factsCount: candidates.length,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
        version: sql`${schema.kbSources.version} + 1`,
      })
      .where(and(eq(schema.kbSources.tenantId, tenantId), eq(schema.kbSources.id, sourceId)));
    await audit.append(tx, tenantId, {
      action: 'kb_source.promoted',
      actorType: 'system',
      actorId: 'ingest-worker',
      subjectType: 'kb_source',
      subjectId: sourceId,
      payload: { facts: candidates.length, attempt },
    });
    return candidates.length;
  });
}
