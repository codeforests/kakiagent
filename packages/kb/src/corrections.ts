import { and, desc, eq, inArray, lt, or, schema, sql, type Tx } from '@kaki/db';
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
  InvalidCursorError,
  InvalidStateError,
  NotEditableError,
  VersionConflictError,
} from './errors.js';
import {
  checkFact,
  contentChanged,
  createFact,
  getFact,
  mergePatch,
  toRecord as toFactRecord,
  updateFact,
  writeVersion,
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
  | { kind: 'edit_hours'; profileVersion: number; before: HoursChange; after: HoursChange }
  /** A stale fact (KB-17, FEAT-018): accepting it re-confirms the fact, same value. */
  | {
      kind: 'reconfirm';
      factId: string;
      factVersion: number;
      factType: FactInput['type'];
      label: string;
      lastConfirmedAt: string;
    };

/** What the coaching propose step asks for. Hours are validated by tenancy's port. */
export type ProposalInput =
  | { kind: 'edit_fact'; factId: string; patch: Omit<FactPatch, 'version' | 'status'> }
  | { kind: 'add_faq'; question: string; answer: string }
  | { kind: 'edit_hours'; profileVersion: number; before: HoursChange; after: HoursChange };

export type CorrectionStatus = (typeof schema.CORRECTION_STATUSES)[number];

export type CorrectionSource = (typeof schema.CORRECTION_SOURCES)[number];

export interface CorrectionRecord {
  id: string;
  status: CorrectionStatus;
  sourceType: CorrectionSource;
  proposedBy: 'system' | 'coaching' | 'staff';
  conversationRef: string | null;
  coachingSessionId: string | null;
  coachingMessageId: string | null;
  factRefs: string[];
  change: ProposedChange;
  /** What was accepted when the fix was edited (FEAT-018 D7). */
  acceptedChange: ProposedChange | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** An edit of the proposed fix before accepting it (UC-16 3, FEAT-018 §3). */
export type CorrectionEdit =
  | { kind: 'edit_fact'; patch: Omit<FactPatch, 'version' | 'status'> }
  | { kind: 'add_faq'; question: string; answer: string };

type Row = typeof schema.corrections.$inferSelect;

function toRecord(row: Row): CorrectionRecord {
  return {
    id: row.id,
    status: row.status,
    sourceType: row.sourceType,
    proposedBy: row.proposedBy,
    conversationRef: row.conversationRef,
    coachingSessionId: row.coachingSessionId,
    coachingMessageId: row.coachingMessageId,
    factRefs: row.factRefs,
    change: row.proposedChange as ProposedChange,
    acceptedChange: (row.acceptedChange as ProposedChange | null) ?? null,
    decidedBy: row.decidedBy,
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

/** The change an accepted correction applies: the edited fix, else the proposal. */
export const effectiveChange = (c: CorrectionRecord): ProposedChange =>
  c.acceptedChange ?? c.change;

/**
 * The fact as the correction leaves it: what the caller embeds before accepting. With
 * `accepted` (from `editedChange`), the edited fix's fact. Null when nothing is embedded
 * (hours, a re-confirm: its content and chunk stay as they are).
 */
export function correctionFactInput(
  c: CorrectionRecord,
  accepted: ProposedChange | null = null,
): FactInput | null {
  const change = accepted ?? c.change;
  switch (change.kind) {
    case 'edit_fact': {
      const a = change.after;
      return {
        type: change.factType,
        value: a.value,
        gstTreatment: a.gstTreatment,
        validity: { validFrom: date(a.validFrom), validUntil: date(a.validUntil) },
      } as FactInput;
    }
    case 'add_faq':
      return {
        type: 'faq',
        value: { question: change.question, answer: change.answer },
        gstTreatment: null,
      };
    case 'edit_hours':
    case 'reconfirm':
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

type KbTx = { tx: Tx; tenantId: string; userId: string };

async function editChange(
  ctx: KbTx,
  input: Extract<ProposalInput, { kind: 'edit_fact' }>,
  expectVersion?: number,
): Promise<Extract<ProposedChange, { kind: 'edit_fact' }>> {
  let current: FactRecord;
  try {
    current = await getFact({ ...ctx, scope: 'dashboard' }, input.factId);
  } catch (err) {
    if (err instanceof FactNotFoundError) {
      if (expectVersion !== undefined) throw new CorrectionStaleError('the fact is gone');
      throw new InvalidCorrectionError('unknown fact');
    }
    throw err;
  }
  if (expectVersion !== undefined && current.version !== expectVersion)
    throw new CorrectionStaleError('the fact changed since the proposal');
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

function faqChange(q: string, a: string): Extract<ProposedChange, { kind: 'add_faq' }> {
  const question = q.trim();
  const answer = a.trim();
  if (!question || !answer || question.length > 300 || answer.length > 2000)
    throw new InvalidCorrectionError('an FAQ needs a question and an answer');
  checked(() => {
    const f: FactInput = { type: 'faq', value: { question, answer }, gstTreatment: null };
    checkFact(f);
    return f;
  });
  return { kind: 'add_faq', question, answer };
}

/** Where a proposal came from, for producers other than coaching (FEAT-018 §5.1). */
export interface CorrectionOrigin {
  sourceType: CorrectionSource;
  proposedBy: 'system' | 'coaching' | 'staff';
  conversationRef?: string | null;
}

/**
 * Validates a proposal and stores it as an open correction from coaching (AGT-17).
 * Throws `InvalidCorrectionError` for an unknown or undecidable fact, a patch that
 * fails the type's rules, or a change that changes nothing.
 */
export async function proposeCorrection(
  ctx: CoachingKbContext,
  input: { proposal: ProposalInput; messageId?: string | null; origin?: CorrectionOrigin },
): Promise<CorrectionRecord> {
  const origin = input.origin ?? { sourceType: 'coaching', proposedBy: 'coaching' };
  const p = input.proposal;
  let change: ProposedChange;
  switch (p.kind) {
    case 'edit_fact':
      change = await editChange(ctx, p);
      break;
    case 'add_faq':
      change = faqChange(p.question, p.answer);
      break;
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
      sourceType: origin.sourceType,
      proposedBy: origin.proposedBy,
      conversationRef: origin.conversationRef ?? null,
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
      sourceType: auditCode(origin.sourceType),
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
  status: 'accepted' | 'edited_and_accepted' | 'dismissed',
  acceptedChange: ProposedChange | null = null,
): Promise<CorrectionRecord> {
  const [row] = await ctx.tx
    .update(schema.corrections)
    .set({
      status,
      acceptedChange,
      decidedBy: ctx.userId,
      decidedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
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
    payload: {
      kind: auditCode(effectiveChange(c).kind),
      sourceType: auditCode(c.sourceType),
      factIds: c.factRefs.map(auditId),
    },
  });
}

/** JSON with sorted keys, so two values compare by content. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * The fix as the owner edited it (UC-16 3 "edits it"), or null when the edit is the
 * proposal itself. A fact edit is checked against the version the item names, so a fact
 * changed since gives `CorrectionStaleError`; a re-confirm edited becomes a fact edit.
 * `InvalidCorrectionError` for an edit that breaks the fact rules or changes nothing;
 * `NotEditableError` for an hours item or a mismatched kind.
 */
export async function editedChange(
  ctx: KbTx,
  c: CorrectionRecord,
  edit: CorrectionEdit,
): Promise<ProposedChange | null> {
  const change = c.change;
  if (edit.kind === 'edit_fact' && (change.kind === 'edit_fact' || change.kind === 'reconfirm')) {
    const next = await editChange(
      ctx,
      { kind: 'edit_fact', factId: change.factId, patch: edit.patch },
      change.factVersion,
    );
    if (change.kind === 'edit_fact' && sameJson(next.after, change.after)) return null;
    return next;
  }
  if (edit.kind === 'add_faq' && change.kind === 'add_faq') {
    const next = faqChange(edit.question, edit.answer);
    return sameJson(next, change) ? null : next;
  }
  throw new NotEditableError(`a ${change.kind} item can't take a ${edit.kind} edit`);
}

/**
 * Re-confirms a fact (KB-17, ADR-010 "re-confirm = new version"): a new version with the
 * same value, `last_confirmed_at` now, and the chunk moved to the new version without
 * re-embedding (its content is unchanged). The fact must still be approved at `version`,
 * else `CorrectionStaleError`.
 */
export async function reconfirmFact(
  ctx: DashboardKbContext,
  factId: string,
  version: number,
): Promise<FactRecord> {
  const f = schema.facts;
  const [row] = await ctx.tx
    .update(f)
    .set({
      version: sql`${f.version} + 1`,
      lastConfirmedAt: sql`now()`,
      updatedBy: ctx.userId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(f.tenantId, ctx.tenantId),
        eq(f.id, factId),
        eq(f.version, version),
        eq(f.status, 'approved'),
      ),
    )
    .returning();
  if (!row) throw new CorrectionStaleError('the fact changed since it was flagged');
  await writeVersion(ctx, row);
  await ctx.tx
    .update(schema.kbChunks)
    .set({ factVersion: row.version })
    .where(and(eq(schema.kbChunks.tenantId, ctx.tenantId), eq(schema.kbChunks.factId, factId)));
  await audit.append(ctx.tx, ctx.tenantId, {
    action: 'fact.reconfirmed',
    actorType: 'user',
    actorId: ctx.userId,
    subjectType: 'fact',
    subjectId: factId,
    payload: { factId: auditId(factId), version: row.version },
  });
  return toFactRecord(row);
}

async function applyChange(
  ctx: DashboardKbContext,
  c: CorrectionRecord,
  change: ProposedChange,
  opts: { chunk?: PreparedChunk; applyHours?: ApplyHours },
) {
  switch (change.kind) {
    case 'edit_fact': {
      if (!opts.chunk) throw new Error('acceptCorrection: a fact change needs its chunk');
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
      return;
    }
    case 'add_faq':
      if (!opts.chunk) throw new Error('acceptCorrection: a new FAQ needs its chunk');
      await createFact(
        ctx,
        correctionFactInput(c, change)!,
        opts.chunk,
        c.sourceType === 'coaching' ? 'coaching' : 'manual',
      );
      return;
    case 'edit_hours':
      if (!opts.applyHours) throw new Error('acceptCorrection: an hours change needs applyHours');
      await opts.applyHours(ctx.tx, change);
      return;
    case 'reconfirm':
      await reconfirmFact(ctx, change.factId, change.factVersion);
      return;
  }
}

/**
 * Accepts an open correction (ADR-010 decision 5, UC-16 3): the fact edit, new FAQ, hours
 * change or re-confirm and the decision commit together, so visitors get the change on
 * commit. With `edit`, the edited fix is applied and kept in `accepted_change` (D7).
 * `chunk` is the embedded `correctionFactInput(c, editedChange(...))` for a fact change.
 * A fact or profile changed since → `CorrectionStaleError`.
 */
export async function acceptCorrection(
  ctx: DashboardKbContext,
  id: string,
  opts: { edit?: CorrectionEdit | null; chunk?: PreparedChunk; applyHours?: ApplyHours } = {},
): Promise<CorrectionRecord> {
  const c = await getCorrection(ctx, id, true);
  if (c.status !== 'open') throw new CorrectionClosedError('already decided');
  const edited = opts.edit ? await editedChange(ctx, c, opts.edit) : null;
  await applyChange(ctx, c, edited ?? c.change, opts);
  const out = await decide(ctx, id, edited ? 'edited_and_accepted' : 'accepted', edited);
  await auditDecision(ctx, out, edited ? 'correction.edited' : 'correction.accepted');
  return out;
}

/** Accepts a coaching proposal as proposed (FEAT-027's confirm; FEAT-018 §5.1). */
export async function confirmCorrection(
  ctx: DashboardKbContext,
  id: string,
  opts: { chunk?: PreparedChunk; applyHours?: ApplyHours } = {},
): Promise<CorrectionRecord> {
  return acceptCorrection(ctx, id, opts);
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

// ---- The queue (KB-18, FEAT-018 §5.1) ------------------------------------------------

const c$ = schema.corrections;
export const CORRECTIONS_PAGE = 20;

/** An approved fact past its type's review interval, not an expired promotion (KB-17). */
export const overdueSql = (f: typeof schema.facts) =>
  sql`(${f.status} = 'approved'
    and ${f.lastConfirmedAt} < now() - make_interval(months => (
      select (t.fact_review_months ->> ${f.type})::int from tenants t where t.id = ${f.tenantId}))
    and (${f.type} <> 'promotion' or ${f.validUntil} > now()))`;

function encodeCursor(at: Date, id: string) {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const d = new Date(at ?? '');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(d.getTime()))
    throw new InvalidCursorError('bad cursor');
  return { at: d, id };
}

/**
 * One page of the queue: open items newest first, or closed items by decision time,
 * newest first; optionally one source.
 */
export async function listCorrections(
  ctx: { tx: Tx; tenantId: string },
  q: { status: 'open' | 'closed'; source?: CorrectionSource; cursor?: string },
): Promise<{ corrections: CorrectionRecord[]; nextCursor: string | null }> {
  const open = q.status === 'open';
  const key = open ? c$.createdAt : c$.decidedAt;
  const where: (ReturnType<typeof sql> | undefined)[] = [
    eq(c$.tenantId, ctx.tenantId),
    open ? eq(c$.status, 'open') : sql`${c$.status} <> 'open'`,
  ];
  if (q.source) where.push(eq(c$.sourceType, q.source));
  if (q.cursor) {
    const { at, id } = decodeCursor(q.cursor);
    where.push(or(lt(key, at), and(eq(key, at), lt(c$.id, id))));
  }
  const rows = await ctx.tx
    .select()
    .from(c$)
    .where(and(...where))
    .orderBy(desc(key), desc(c$.id))
    .limit(CORRECTIONS_PAGE + 1);
  const page = rows.slice(0, CORRECTIONS_PAGE).map(toRecord);
  const last = page.at(-1);
  return {
    corrections: page,
    nextCursor:
      rows.length > CORRECTIONS_PAGE && last
        ? encodeCursor((open ? last.createdAt : last.decidedAt)!, last.id)
        : null,
  };
}

export interface CorrectionFactView {
  id: string;
  label: string;
  type: FactInput['type'];
  status: FactRecord['status'] | 'deleted';
  version: number;
  lastConfirmedAt: Date | null;
  overdue: boolean;
}

/**
 * Each correction's facts as they are now, by correction ID. A deleted fact keeps the
 * label and type its change recorded, with version 0.
 */
export async function correctionFacts(
  ctx: { tx: Tx; tenantId: string },
  items: CorrectionRecord[],
): Promise<Map<string, CorrectionFactView[]>> {
  const ids = [...new Set(items.flatMap((c) => c.factRefs))];
  const f = schema.facts;
  const rows = ids.length
    ? await ctx.tx
        .select({
          id: f.id,
          type: f.type,
          value: f.value,
          status: f.status,
          version: f.version,
          lastConfirmedAt: f.lastConfirmedAt,
          overdue: sql<boolean>`${overdueSql(f)}`,
        })
        .from(f)
        .where(and(eq(f.tenantId, ctx.tenantId), inArray(f.id, ids)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, CorrectionFactView[]>();
  for (const c of items) {
    const change = c.change;
    out.set(
      c.id,
      c.factRefs.map((id) => {
        const r = byId.get(id);
        if (r)
          return {
            id,
            label: factLabel({ type: r.type, value: r.value } as FactInput),
            type: r.type,
            status: r.status,
            version: r.version,
            lastConfirmedAt: r.lastConfirmedAt,
            overdue: Boolean(r.overdue),
          };
        const known = change.kind === 'edit_fact' || change.kind === 'reconfirm';
        return {
          id,
          label: known ? change.label : '',
          type: known ? change.factType : 'faq',
          status: 'deleted' as const,
          version: 0,
          lastConfirmedAt: null,
          overdue: false,
        };
      }),
    );
  }
  return out;
}

/** The Review counts (KB-18 "number of open items", KB-17 "number of overdue facts"). */
export async function correctionCounts(ctx: {
  tx: Tx;
  tenantId: string;
}): Promise<{ open: number; overdueFacts: number }> {
  const [open] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(c$)
    .where(and(eq(c$.tenantId, ctx.tenantId), eq(c$.status, 'open')));
  const f = schema.facts;
  const [overdue] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(f)
    .where(and(eq(f.tenantId, ctx.tenantId), overdueSql(f)));
  return { open: open?.n ?? 0, overdueFacts: overdue?.n ?? 0 };
}
