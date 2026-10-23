import { and, eq, inArray, schema, sql, withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import type { LlmGateway } from '@kaki/llm-gateway';
import { chunkContent } from '../chunk.js';
import { entityKey, inputOf, planPromotion } from '../conflicts.js';
import { EmbeddingUnavailableError } from '../errors.js';
import type { SourceRecord } from '../sources.js';
import type { FactInput } from '../types.js';
import { moveFacts } from '../writes.js';
import { StaleRunError } from './crawl.js';

const INGEST_ACTOR = { type: 'system', id: 'ingest-worker' } as const;

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

/** The tenant's facts of these types, as the plan compares them (FEAT-014 §5.2). */
async function existingFacts(
  tx: Tx,
  tenantId: string,
  types: FactInput['type'][],
  lock?: string[],
) {
  const f = schema.facts;
  const q = tx
    .select({
      id: f.id,
      type: f.type,
      status: f.status,
      version: f.version,
      value: f.value,
      gstTreatment: f.gstTreatment,
      validFrom: f.validFrom,
      validUntil: f.validUntil,
    })
    .from(f)
    .where(and(eq(f.tenantId, tenantId), lock ? inArray(f.id, lock) : inArray(f.type, types)))
    .orderBy(f.id);
  const rows = lock ? (lock.length ? await q.for('update') : []) : await q;
  return rows.map((r) => ({ id: r.id, status: r.status, version: r.version, input: inputOf(r) }));
}

/**
 * The promote stage (ADR-018 decision 7; FEAT-012 §5.4, FEAT-014 §5.2): the attempt's
 * staged facts, in confidence then crawl order, are planned against each other and the
 * tenant's facts: agreeing findings collapse, findings the tenant already has (any
 * status) are dropped, and where findings and live facts disagree (KB-06) the new facts
 * are written `conflicted` and the live ones flagged, leaving visitor answers. The rest
 * are embedded and written in **one** transaction as `needs_review` facts with their
 * versions, chunks and provenance, with one audit entry; the staging is cleared and the
 * source is `ready`. Until that commit nothing of the run is a fact, so a failure leaves
 * none behind (KB-12). Returns the number of facts.
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
      url: string;
      title: string | null;
      ocr_confidence: number | null;
    }>(sql`
      select s.type, s.value, s.gst_treatment, s.valid_from, s.valid_until, s.quote,
             s.quote_start, s.quote_end, s.confidence, p.url, p.title, p.ocr_confidence
      from kb_staged_facts s
        join kb_source_pages p on p.tenant_id = s.tenant_id and p.id = s.page_id
      where s.tenant_id = ${tenantId} and s.source_id = ${sourceId} and s.attempt = ${attempt}
      order by s.confidence desc, p.seq, s.quote_start`),
  );
  const all: Candidate[] = rows.rows.map((r) => {
    const validity =
      r.type === 'promotion' || r.valid_from || r.valid_until
        ? {
            validFrom: r.valid_from ? new Date(r.valid_from) : null,
            validUntil: r.valid_until ? new Date(r.valid_until) : null,
          }
        : undefined;
    return {
      input: { type: r.type, value: r.value, gstTreatment: r.gst_treatment, validity } as FactInput,
      // A fact read from an OCR'd page is no surer than the OCR (FEAT-015 D6).
      confidence:
        r.ocr_confidence === null ? r.confidence : Math.min(r.confidence, r.ocr_confidence),
      provenance: {
        url: r.url,
        title: r.title,
        quote: r.quote,
        start: r.quote_start,
        end: r.quote_end,
      },
    };
  });
  const types = [...new Set(all.map((c) => c.input.type))];
  // A first plan, without locks, decides what to embed; the write re-plans under the lock.
  const candidates = all.length
    ? planPromotion(
        all,
        await withTenant(zdb, tenantId, (tx) => existingFacts(tx, tenantId, types)),
      ).insert.map((i) => i.candidate)
    : [];

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
    // Two sources of one tenant promote one at a time, so each sees the other's facts (D9).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`kb.conflicts:${tenantId}`}, 0))`,
    );
    const keys = new Set(candidates.map((c) => entityKey(c.input)));
    const matched = (await existingFacts(tx, tenantId, types))
      .filter((e) => keys.has(entityKey(e.input)))
      .map((e) => e.id);
    const plan = planPromotion(candidates, await existingFacts(tx, tenantId, types, matched));
    const embeddingOf = new Map(candidates.map((c, i) => [c, embeddings[i]!]));
    for (const { candidate: c, status } of plan.insert) {
      const [fact] = await tx
        .insert(schema.facts)
        .values({
          tenantId,
          type: c.input.type,
          status,
          value: c.input.value,
          gstTreatment: c.input.gstTreatment,
          validFrom: c.input.validity?.validFrom ?? null,
          validUntil: c.input.validity?.validUntil ?? null,
          source: source.kind,
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
        status,
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
        embedding: embeddingOf.get(c)!,
      });
    }
    // ADR-010 "approved → conflicted: new source disagrees": out of answers in this commit.
    const from = new Map(plan.flag.map((e) => [e.id, e.status]));
    await moveFacts(
      tx,
      tenantId,
      INGEST_ACTOR,
      plan.flag.map((e) => e.id),
      'conflicted',
      (ref) => ({
        action: 'fact.conflicted',
        payload: {
          version: ref.version,
          from: auditCode(from.get(ref.id)!),
          source: auditId(sourceId),
        },
      }),
    );
    const written = plan.insert.length;
    const conflicted = plan.insert.filter((i) => i.status === 'conflicted').length;
    const st = schema.kbStagedFacts;
    await tx.delete(st).where(and(eq(st.tenantId, tenantId), eq(st.sourceId, sourceId)));
    await tx
      .update(schema.kbSources)
      .set({
        status: 'ready',
        stage: null,
        factsCount: written,
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
      payload: conflicted ? { facts: written, attempt, conflicted } : { facts: written, attempt },
    });
    return written;
  });
}
