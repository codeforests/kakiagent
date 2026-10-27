import {
  applyHoursWith,
  correctionReplayNext,
  CorrectionReplayNotFoundError,
  getCoachingMessage,
  getCorrectionReplay,
  sessionMessages,
  type CorrectionReplayTurnRow,
  type CorrectionReplayView,
} from '@kaki/agent';
import {
  CorrectionAccept,
  CorrectionAcceptResponse,
  CorrectionDecision,
  CorrectionDetail,
  CorrectionItemResponse,
  CorrectionList,
  CorrectionListQuery,
  CorrectionReplayNextResponse,
  type CorrectionContext,
  type CorrectionEdit,
  type CorrectionItem,
  type CorrectionReplay,
  type CorrectionReplayTurn,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import { messagesUpTo } from '@kaki/inbox';
import {
  acceptCorrection,
  correctionFactInput,
  correctionFacts,
  CorrectionNotFoundError,
  CorrectionStaleError,
  dashboardKb,
  dismissCorrection,
  editedChange,
  FactNotFoundError,
  getCorrection,
  getFact,
  InvalidCorrectionError,
  InvalidFactError,
  listCorrections,
  NotEditableError,
  prepareChunk,
  type CorrectionEdit as KbEdit,
  type CorrectionFactView,
  type CorrectionRecord,
} from '@kaki/kb';
import type { FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { UnavailableError, type TenantSession } from './auth.js';
import { changeView, ReplayRateLimitedError, startReplaySafely, toMessages } from './coach.js';
import { ForbiddenError, patchOf } from './facts.js';
import { gapContext, gapStatsIn } from './gaps.js';
import { widgetLive } from './channels.js';
import type { App, Deps } from './server.js';

/** 422 `invalid_query` for a list query that doesn't parse (FEAT-018 §3). */
export class InvalidQueryError extends Error {}
/** 422 `invalid_body` for a body that doesn't parse. */
export class InvalidBodyError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLAYS_PER_MINUTE = 30;
const CONTEXT_MESSAGES = 6;

export function bodyOf<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new InvalidBodyError('invalid body');
  return parsed.data;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toItem(
  c: CorrectionRecord,
  facts: CorrectionFactView[],
  gap: CorrectionItem['gap'] = null,
): CorrectionItem {
  return {
    id: c.id,
    status: c.status,
    source: c.sourceType,
    proposedBy: c.proposedBy,
    change: changeView(c.change),
    acceptedChange: c.acceptedChange ? changeView(c.acceptedChange) : null,
    facts: facts.map((f) => ({ ...f, lastConfirmedAt: iso(f.lastConfirmedAt) })),
    coachingSessionId: c.coachingSessionId,
    conversationId: c.conversationRef,
    createdAt: c.createdAt.toISOString(),
    decidedAt: iso(c.decidedAt),
    closedBySystem: c.status === 'dismissed' && c.decidedBy === null,
    gap,
  };
}

/** The list row's newest ask and count for each coverage-gap item (FEAT-019, SCR-APP-021). */
async function gapSummaries(tx: Tx, tenantId: string, items: CorrectionRecord[]) {
  const ids = items.filter((c) => c.sourceType === 'coverage_gap').map((c) => c.id);
  const stats = ids.length ? await gapStatsIn(tx, tenantId)(ids, new Date()) : new Map();
  return new Map<string, CorrectionItem['gap']>(
    ids.map((id) => {
      const s = stats.get(id);
      return [id, { question: s?.newest ?? '', asksTotal: s?.asksTotal ?? 0 }];
    }),
  );
}

async function itemOf(tx: Tx, tenantId: string, c: CorrectionRecord): Promise<CorrectionItem> {
  const facts = await correctionFacts({ tx, tenantId }, [c]);
  const gaps = await gapSummaries(tx, tenantId, [c]);
  return toItem(c, facts.get(c.id) ?? [], gaps.get(c.id) ?? null);
}

function toTurn(t: CorrectionReplayTurnRow, replayed: CorrectionReplayTurn['replayed']) {
  return {
    messageId: t.messageId,
    conversationId: t.conversationId,
    index: t.index,
    question: t.question,
    askedAt: t.askedAt.toISOString(),
    original: t.original.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })),
    status: t.replayed ? ('done' as const) : ('pending' as const),
    replayed,
    effects: t.effects,
    answerChanged: t.answerChanged,
  };
}

async function toReplay(
  tx: Tx,
  tenantId: string,
  r: CorrectionReplayView,
): Promise<CorrectionReplay> {
  const rows = r.turns.flatMap((t) => (t.replayed ? [t.replayed] : []));
  const shown = new Map((await toMessages(tx, tenantId, rows)).map((m) => [m.id, m]));
  return {
    status: r.status,
    matched: r.matched,
    turns: r.turns.map((t) => toTurn(t, t.replayed ? (shown.get(t.replayed.id) ?? null) : null)),
  };
}

/** The owner's teaching message and the proposal, or the conversation excerpt (AC-2). */
async function contextOf(
  tx: Tx,
  tenantId: string,
  c: CorrectionRecord,
): Promise<CorrectionContext> {
  let coaching: CorrectionContext['coaching'] = null;
  if (c.coachingSessionId && c.coachingMessageId) {
    const proposal = await getCoachingMessage(tx, tenantId, c.coachingMessageId);
    if (proposal) {
      const question = (await sessionMessages(tx, tenantId, c.coachingSessionId))
        .filter((m) => m.author === 'owner' && m.seq < proposal.seq)
        .at(-1);
      coaching = { question: question?.body ?? null, proposal: proposal.body };
    }
  }
  // A coverage gap shows its asked questions instead of one conversation (FEAT-019 §3).
  if (c.sourceType === 'coverage_gap')
    return { coaching, conversation: null, gap: await gapContext(tx, tenantId, c.id) };
  const conversation = c.conversationRef
    ? (
        await messagesUpTo(tx, {
          tenantId,
          conversationId: c.conversationRef,
          upTo: c.createdAt,
          limit: CONTEXT_MESSAGES,
        })
      ).map((m) => ({
        author: m.author,
        text: m.body,
        factIds: m.factIds,
        createdAt: m.createdAt.toISOString(),
      }))
    : null;
  return { coaching, conversation, gap: null };
}

/**
 * The kb edit for a contract edit: a fact edit's view (prices in dollars, SG dates) goes
 * through the fact routes' `patchOf` against the fact as it is now. A fact gone since
 * is stale; a value that fails the fact rules is an invalid correction.
 */
async function kbEditOf(tx: Tx, s: TenantSession, c: CorrectionRecord, edit: CorrectionEdit) {
  if (edit.kind === 'add_faq')
    return { kind: 'add_faq', question: edit.question, answer: edit.answer } satisfies KbEdit;
  const change = c.change;
  if (change.kind !== 'edit_fact' && change.kind !== 'reconfirm')
    throw new NotEditableError(`a ${change.kind} item takes no fact edit`);
  let current;
  try {
    current = await getFact(dashboardKb(tx, s.tenantId, s.userId), change.factId);
  } catch (err) {
    if (err instanceof FactNotFoundError) throw new CorrectionStaleError('the fact is gone');
    throw err;
  }
  const a = edit.after;
  try {
    const {
      version: _v,
      status: _s,
      ...patch
    } = patchOf(current, {
      version: current.version,
      value: a.value,
      ...(a.gstTreatment ? { gstTreatment: a.gstTreatment } : {}),
      ...(current.type === 'promotion'
        ? { validFrom: a.validFrom, ...(a.validUntil ? { validUntil: a.validUntil } : {}) }
        : {}),
    } as Parameters<typeof patchOf>[1]);
    return { kind: 'edit_fact', patch } satisfies KbEdit;
  } catch (err) {
    if (err instanceof ZodError || err instanceof InvalidFactError)
      throw new InvalidCorrectionError('the edit fails the fact rules');
    throw err;
  }
}

/**
 * The corrections queue (KB-18, KB-17, UC-16; FEAT-018 §3, §5.5), dashboard trust zone,
 * `kb.manage`. Accepting embeds the effective fact before its transaction, as every fact
 * edit does (FEAT-022 D4), then starts the old-versus-new replay.
 */
export function registerCorrectionRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, llm, rateLimiter } = deps;
  const replayDeps = { zdb: dashboardDb, llm };

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'kb.manage')) throw new ForbiddenError('kb.manage');
    return s;
  }
  const idOf = (id: string) => {
    if (!UUID_RE.test(id)) throw new CorrectionNotFoundError('correction not found');
    return id;
  };
  const inTenant = <T>(s: TenantSession, fn: (tx: Tx) => Promise<T>) =>
    withTenant(dashboardDb, s.tenantId, fn);

  app.get('/api/v1/corrections', async (req) => {
    const s = await manager(req);
    const q = CorrectionListQuery.safeParse(req.query ?? {});
    if (!q.success) throw new InvalidQueryError('invalid query');
    return inTenant(s, async (tx) => {
      const page = await listCorrections({ tx, tenantId: s.tenantId }, q.data);
      const facts = await correctionFacts({ tx, tenantId: s.tenantId }, page.corrections);
      const gaps = await gapSummaries(tx, s.tenantId, page.corrections);
      return CorrectionList.parse({
        corrections: page.corrections.map((c) =>
          toItem(c, facts.get(c.id) ?? [], gaps.get(c.id) ?? null),
        ),
        nextCursor: page.nextCursor,
      });
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/corrections/:id', async (req) => {
    const s = await manager(req);
    const id = idOf(req.params.id);
    const c = await inTenant(s, (tx) => getCorrection({ tx, tenantId: s.tenantId }, id));
    const accepted = c.status === 'accepted' || c.status === 'edited_and_accepted';
    const replay = accepted
      ? ((await getCorrectionReplay(replayDeps, { tenantId: s.tenantId, correctionId: id })) ??
        (await startReplaySafely(deps, req.log, {
          tenantId: s.tenantId,
          userId: s.userId,
          correctionId: id,
        })))
      : null;
    return inTenant(s, async (tx) =>
      CorrectionDetail.parse({
        correction: await itemOf(tx, s.tenantId, c),
        context: await contextOf(tx, s.tenantId, c),
        replay: replay ? await toReplay(tx, s.tenantId, replay) : null,
      }),
    );
  });

  app.post<{ Params: { id: string } }>('/api/v1/corrections/:id/accept', async (req) => {
    const s = await manager(req);
    const id = idOf(req.params.id);
    const { edit } = bodyOf(CorrectionAccept, req.body);
    // Read and build the effective change, embed it outside the transaction, then accept:
    // `acceptCorrection` rebuilds the edit under the row lock and checks the fact version.
    const { kbEdit, input } = await inTenant(s, async (tx) => {
      const c = await getCorrection({ tx, tenantId: s.tenantId }, id);
      if (c.change.kind === 'edit_hours' && edit) throw new NotEditableError('hours');
      const kbEdit = edit ? await kbEditOf(tx, s, c, edit) : null;
      const changed =
        kbEdit && c.status === 'open'
          ? await editedChange({ tx, tenantId: s.tenantId, userId: s.userId }, c, kbEdit)
          : null;
      return { kbEdit, input: correctionFactInput(c, changed) };
    });
    const chunk = input ? await prepareChunk(llm, s.tenantId, input) : undefined;
    const done = await inTenant(s, (tx) =>
      acceptCorrection(dashboardKb(tx, s.tenantId, s.userId), id, {
        edit: kbEdit,
        ...(chunk ? { chunk } : {}),
        applyHours: applyHoursWith({ tenantId: s.tenantId, userId: s.userId }),
      }),
    );
    const replay = await startReplaySafely(deps, req.log, {
      tenantId: s.tenantId,
      userId: s.userId,
      correctionId: id,
    });
    return inTenant(s, async (tx) =>
      CorrectionAcceptResponse.parse({
        correction: await itemOf(tx, s.tenantId, done),
        replay: replay ? await toReplay(tx, s.tenantId, replay) : null,
      }),
    );
  });

  app.post<{ Params: { id: string } }>('/api/v1/corrections/:id/close', async (req) => {
    const s = await manager(req);
    const id = idOf(req.params.id);
    bodyOf(CorrectionDecision, req.body);
    return inTenant(s, async (tx) => {
      const done = await dismissCorrection(dashboardKb(tx, s.tenantId, s.userId), id);
      return CorrectionItemResponse.parse({ correction: await itemOf(tx, s.tenantId, done) });
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/corrections/:id/replay/next', async (req) => {
    const s = await manager(req);
    const id = idOf(req.params.id);
    bodyOf(CorrectionDecision, req.body);
    // 404 before the limiter: another tenant's item never spends the user's budget.
    const exists = await getCorrectionReplay(replayDeps, {
      tenantId: s.tenantId,
      correctionId: id,
    });
    if (!exists) throw new CorrectionReplayNotFoundError('no replay');
    let allowed: boolean;
    try {
      allowed = (await rateLimiter.hit(`replay:${s.userId}`, REPLAYS_PER_MINUTE, 60_000)).allowed;
    } catch (err) {
      req.log.error({ err }, 'rate limiter unavailable');
      throw new UnavailableError('rate limiter');
    }
    if (!allowed) throw new ReplayRateLimitedError();
    const r = await correctionReplayNext(
      { ...replayDeps, channelLive: widgetLive(dashboardDb, s.tenantId) },
      {
        tenantId: s.tenantId,
        userId: s.userId,
        correctionId: id,
      },
    );
    const [message] = await inTenant(s, (tx) =>
      toMessages(tx, s.tenantId, r.turn.replayed ? [r.turn.replayed] : []),
    );
    return CorrectionReplayNextResponse.parse({
      turn: toTurn(r.turn, message ?? null),
      remaining: r.remaining,
    });
  });
}
