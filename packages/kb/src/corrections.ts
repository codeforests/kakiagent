import { and, eq, schema, sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId } from '@kaki/governance';
import type { PreparedChunk } from './chunk.js';
import type { CoachingKbContext, DashboardKbContext } from './context.js';
import {
  CorrectionClosedError,
  CorrectionNotFoundError,
  CorrectionStaleError,
  FactNotFoundError,
  InvalidCorrectionError,
  InvalidFactError,
  InvalidStateError,
  VersionConflictError,
} from './errors.js';
import {
  checkFact,
  contentChanged,
  createFact,
  getFact,
  mergePatch,
  updateFact,
  type FactPatch,
  type FactRecord,
} from './facts.js';
import type { FactInput, GstTreatment } from './types.js';

/**
 * The corrections queue (ADR-010 decision 4; FEAT-027 §5.1). A proposal never edits a
 * fact; confirming one does, through `updateFact`/`createFact`, in the same transaction
 * as the decision, so visitors get the new value on commit (AGT-17's 60 s).
 */

/** A fact's content as a correction stores it; validity as ISO instants. */
export interface FactContent {
  value: FactInput['value'];
  gstTreatment: GstTreatment | null;
  validFrom: string | null;
  validUntil: string | null;
}

/** Days of the week to their intervals, only the days that change (D10). */
export type HoursChange = Record<string, { open: string; close: string }[]>;

export type ProposedChange =
  | {
      kind: 'edit_fact';
      factId: string;
      factVersion: number;
      factType: FactInput['type'];
      label: string;
      before: FactContent;
      after: FactContent;
    }
  | { kind: 'add_faq'; question: string; answer: string }
  | { kind: 'edit_hours'; profileVersion: number; before: HoursChange; after: HoursChange };

/** What the coaching propose step asks for. Hours are validated by tenancy's port. */
export type ProposalInput =
  | { kind: 'edit_fact'; factId: string; patch: Omit<FactPatch, 'version' | 'status'> }
  | { kind: 'add_faq'; question: string; answer: string }
  | { kind: 'edit_hours'; profileVersion: number; before: HoursChange; after: HoursChange };

export type CorrectionStatus = (typeof schema.CORRECTION_STATUSES)[number];

export interface CorrectionRecord {
  id: string;
  status: CorrectionStatus;
  sourceType: (typeof schema.CORRECTION_SOURCES)[number];
  coachingSessionId: string | null;
  coachingMessageId: string | null;
  factRefs: string[];
  change: ProposedChange;
  decidedAt: Date | null;
  createdAt: Date;
}

type Row = typeof schema.corrections.$inferSelect;

function toRecord(row: Row): CorrectionRecord {
  return {
    id: row.id,
    status: row.status,
    sourceType: row.sourceType,
    coachingSessionId: row.coachingSessionId,
    coachingMessageId: row.coachingMessageId,
    factRefs: row.factRefs,
    change: row.proposedChange as ProposedChange,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const date = (s: string | null) => (s ? new Date(s) : null);

export function contentOf(input: FactInput): FactContent {
  return {
    value: input.value,
    gstTreatment: input.gstTreatment,
    validFrom: iso(input.validity?.validFrom ?? null),
    validUntil: iso(input.validity?.validUntil ?? null),
  };
}

/** The name a fact goes by in the chat: a product's name, an FAQ's question, a title. */
export function factLabel(fact: Pick<FactInput, 'type' | 'value'>): string {
  const f = fact as FactInput;
  switch (f.type) {
    case 'product':
      return f.value.name;
    case 'faq':
      return f.value.question;
    case 'policy':
    case 'promotion':
      return f.value.title;
  }
}

/** The fact as the correction leaves it: what the caller embeds before confirming. */
export function correctionFactInput(c: CorrectionRecord): FactInput | null {
  switch (c.change.kind) {
    case 'edit_fact': {
      const a = c.change.after;
      return {
        type: c.change.factType,
        value: a.value,
        gstTreatment: a.gstTreatment,
        validity: { validFrom: date(a.validFrom), validUntil: date(a.validUntil) },
      } as FactInput;
    }
    case 'add_faq':
      return {
        type: 'faq',
        value: { question: c.change.question, answer: c.change.answer },
        gstTreatment: null,
      };
    case 'edit_hours':
      return null;
  }
}

function checked(fn: () => FactInput): FactInput {
  try {
    return fn();
  } catch (err) {
    if (err instanceof InvalidFactError) throw new InvalidCorrectionError(err.message);
    throw err;
  }
}

async function editChange(
  ctx: CoachingKbContext,
  input: Extract<ProposalInput, { kind: 'edit_fact' }>,
): Promise<ProposedChange> {
  let current: FactRecord;
  try {
    current = await getFact({ ...ctx, scope: 'dashboard' }, input.factId);
  } catch (err) {
    if (err instanceof FactNotFoundError) throw new InvalidCorrectionError('unknown fact');
    throw err;
  }
  if (current.status === 'rejected' || current.status === 'conflicted')
    throw new InvalidCorrectionError(`a ${current.status} fact can't be corrected here`);
  const next = checked(() => mergePatch(current, { ...input.patch, version: current.version }));
  if (!contentChanged(current, next)) throw new InvalidCorrectionError('nothing would change');
  return {
    kind: 'edit_fact',
    factId: current.id,
    factVersion: current.version,
    factType: current.type,
    label: factLabel(current),
    before: contentOf({ ...current, validity: current.validity } as FactInput),
    after: contentOf(next),
  };
}

/**
 * Validates a proposal and stores it as an open correction from coaching (AGT-17).
 * Throws `InvalidCorrectionError` for an unknown or undecidable fact, a patch that
 * fails the type's rules, or a change that changes nothing.
 */
export async function proposeCorrection(
  ctx: CoachingKbContext,
  input: { proposal: ProposalInput; messageId?: string | null },
): Promise<CorrectionRecord> {
  const p = input.proposal;
  let change: ProposedChange;
  switch (p.kind) {
    case 'edit_fact':
      change = await editChange(ctx, p);
      break;
    case 'add_faq': {
      const question = p.question.trim();
      const answer = p.answer.trim();
      if (!question || !answer || question.length > 300 || answer.length > 2000)
        throw new InvalidCorrectionError('an FAQ needs a question and an answer');
      checked(() => {
        const f: FactInput = { type: 'faq', value: { question, answer }, gstTreatment: null };
        checkFact(f);
        return f;
      });
      change = { kind: 'add_faq', question, answer };
      break;
    }
    case 'edit_hours':
      if (Object.keys(p.after).length === 0) throw new InvalidCorrectionError('no day changes');
      if (JSON.stringify(p.before) === JSON.stringify(p.after))
        throw new InvalidCorrectionError('nothing would change');
      change = p;
      break;
  }
  const factRefs = change.kind === 'edit_fact' ? [change.factId] : [];
  const [row] = await ctx.tx
    .insert(schema.corrections)
    .values({
      tenantId: ctx.tenantId,
      sourceType: 'coaching',
      proposedBy: 'coaching',
      coachingSessionId: ctx.sessionId,
      coachingMessageId: input.messageId ?? null,
      factRefs,
      proposedChange: change,
      createdBy: ctx.userId,
    })
    .returning();
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'correction.proposed',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'correction',
    subjectId: row!.id,
    related: [{ type: 'coaching_session', id: ctx.sessionId }],
    payload: {
      kind: auditCode(change.kind),
      sourceType: auditCode('coaching'),
      factIds: factRefs.map(auditId),
    },
  });
  return toRecord(row!);
}

/** Links a correction to the chat message that shows it. */
export async function attachCorrectionMessage(
  ctx: CoachingKbContext,
  id: string,
  messageId: string,
): Promise<void> {
  await ctx.tx.execute(
    sql`update corrections set coaching_message_id = ${messageId}
        where tenant_id = ${ctx.tenantId} and id = ${id} and coaching_message_id is null`,
  );
}

export async function getCorrection(
  ctx: { tx: Tx; tenantId: string },
  id: string,
  lock = false,
): Promise<CorrectionRecord> {
  const q = ctx.tx
    .select()
    .from(schema.corrections)
    .where(and(eq(schema.corrections.tenantId, ctx.tenantId), eq(schema.corrections.id, id)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new CorrectionNotFoundError('correction not found');
  return toRecord(row);
}

/** Saves an hours change under the proposal's profile version (wired to tenancy; D10). */
export type ApplyHours = (
  tx: Tx,
  change: Extract<ProposedChange, { kind: 'edit_hours' }>,
) => Promise<void>;

async function decide(
  ctx: DashboardKbContext,
  id: string,
  status: 'accepted' | 'dismissed',
): Promise<CorrectionRecord> {
  const [row] = await ctx.tx
    .update(schema.corrections)
    .set({ status, decidedBy: ctx.userId, decidedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(schema.corrections.tenantId, ctx.tenantId), eq(schema.corrections.id, id)))
    .returning();
  return toRecord(row!);
}

async function auditDecision(ctx: DashboardKbContext, c: CorrectionRecord, action: string) {
  await audit.append(ctx.tx, ctx.tenantId, {
    action,
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'correction',
    subjectId: c.id,
    payload: { kind: auditCode(c.change.kind), factIds: c.factRefs.map(auditId) },
  });
}

/**
 * Accepts an open correction (ADR-010 decision 5): the fact edit, new FAQ or hours
 * change and the decision commit together. `chunk` is the embedded `correctionFactInput`
 * for a fact change. A fact or profile changed since the proposal → `CorrectionStaleError`.
 */
export async function confirmCorrection(
  ctx: DashboardKbContext,
  id: string,
  opts: { chunk?: PreparedChunk; applyHours?: ApplyHours } = {},
): Promise<CorrectionRecord> {
  const c = await getCorrection(ctx, id, true);
  if (c.status !== 'open') throw new CorrectionClosedError('already decided');
  const change = c.change;
  switch (change.kind) {
    case 'edit_fact': {
      if (!opts.chunk) throw new Error('confirmCorrection: a fact change needs its chunk');
      const a = change.after;
      try {
        await updateFact(
          ctx,
          change.factId,
          {
            version: change.factVersion,
            value: a.value,
            gstTreatment: a.gstTreatment,
            ...(change.factType === 'promotion'
              ? { validity: { validFrom: date(a.validFrom), validUntil: date(a.validUntil) } }
              : {}),
          },
          opts.chunk,
        );
      } catch (err) {
        if (
          err instanceof VersionConflictError ||
          err instanceof InvalidStateError ||
          err instanceof FactNotFoundError
        )
          throw new CorrectionStaleError('the fact changed since the proposal');
        if (err instanceof InvalidFactError) throw new InvalidCorrectionError(err.message);
        throw err;
      }
      break;
    }
    case 'add_faq':
      if (!opts.chunk) throw new Error('confirmCorrection: a new FAQ needs its chunk');
      await createFact(ctx, correctionFactInput(c)!, opts.chunk, 'coaching');
      break;
    case 'edit_hours':
      if (!opts.applyHours) throw new Error('confirmCorrection: an hours change needs applyHours');
      await opts.applyHours(ctx.tx, change);
      break;
  }
  const out = await decide(ctx, id, 'accepted');
  await auditDecision(ctx, out, 'correction.accepted');
  return out;
}

/** Closes an open correction with no change (UC-04 5a). */
export async function dismissCorrection(
  ctx: DashboardKbContext,
  id: string,
): Promise<CorrectionRecord> {
  const c = await getCorrection(ctx, id, true);
  if (c.status !== 'open') throw new CorrectionClosedError('already decided');
  const out = await decide(ctx, id, 'dismissed');
  await auditDecision(ctx, out, 'correction.dismissed');
  return out;
}
