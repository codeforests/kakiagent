import {
  applyHoursWith,
  CoachingSessionNotFoundError,
  createSession,
  getReplay,
  getSession,
  listSessions,
  reanswer,
  replayCandidates,
  replayNext,
  runCoachingTurn,
  sessionMessages,
  startReplay,
  type CoachingMessageRow,
  type CoachingSessionRow,
  type ReplayTurnRow,
  type ReplayView,
} from '@kaki/agent';
import {
  CoachSessionCreate,
  CoachSessionDetail,
  CoachSessionList,
  CoachSessionListQuery,
  CoachSessionResponse,
  CoachSuggestions,
  CoachTurnRequest,
  CoachTurnResponse,
  CorrectionConfirmResponse,
  CorrectionDecision,
  CorrectionResponse,
  Explainer,
  ReplayCandidateList,
  ReplayCandidateQuery,
  ReplayCreate,
  ReplayNextRequest,
  ReplayNextResponse,
  ReplayResponse,
  type CoachMessage,
  type Replay,
  type ReplayTurn,
  type CoachSession,
  type Correction,
  type FactValueView,
  type ProposedChange,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import {
  confirmCorrection,
  correctionFactInput,
  CorrectionNotFoundError,
  dashboardKb,
  dismissCorrection,
  getCorrection,
  listFacts,
  prepareChunk,
  sgDateOf,
  sgLastDayOf,
  type CorrectionRecord,
  type FactContent,
  type FactInput,
} from '@kaki/kb';
import { getBusinessProfile, INDUSTRY_TEMPLATES, questionKey, sgDay } from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { UnavailableError, type TenantSession } from './auth.js';
import { ForbiddenError, fromCents } from './facts.js';
import type { App, Deps } from './server.js';

/** 422 `invalid_body` for a coaching body that doesn't parse (FEAT-027 §3). */
export class InvalidCoachBodyError extends Error {}
/** 429 after 20 turns a minute per user (FEAT-027 §3). */
export class CoachRateLimitedError extends Error {}
/** 429 after 30 replayed questions a minute per user (FEAT-028 §3). */
export class ReplayRateLimitedError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURNS_PER_MINUTE = 20;
const REPLAYS_PER_MINUTE = 30;
const SUGGESTED_FROM_TEMPLATE = 3;
const SUGGESTED_FROM_FACTS = 3;

function toSession(r: CoachingSessionRow): CoachSession {
  return {
    id: r.id,
    // Correction replays never reach Coach (FEAT-018 §3): `listSessions` leaves them out.
    origin: r.origin as CoachSession['origin'],
    title: r.title,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** A stored value as the fact contract shows it: prices in dollars, no currency. */
function valueView(type: FactInput['type'], value: FactInput['value']): Record<string, unknown> {
  if (type !== 'product' && type !== 'promotion') return { ...value };
  const { priceCents, currency: _currency, ...rest } = value as unknown as Record<string, unknown>;
  return typeof priceCents === 'number' ? { ...rest, price: fromCents(priceCents) } : rest;
}

function contentView(type: FactInput['type'], c: FactContent): FactValueView {
  return {
    value: valueView(type, c.value),
    gstTreatment: c.gstTreatment,
    validFrom: c.validFrom ? sgDateOf(new Date(c.validFrom)) : null,
    validUntil: c.validUntil ? sgLastDayOf(new Date(c.validUntil)) : null,
  };
}

export function changeView(c: CorrectionRecord['change']): ProposedChange {
  switch (c.kind) {
    case 'edit_fact':
      return {
        ...c,
        before: contentView(c.factType, c.before),
        after: contentView(c.factType, c.after),
      };
    case 'add_faq':
      return c;
    case 'edit_hours':
      return c as ProposedChange;
    case 'reconfirm':
      return c;
  }
}

export function toCorrection(c: CorrectionRecord): Correction {
  return {
    id: c.id,
    status: c.status,
    change: changeView(c.change),
    decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null,
  };
}

/** Messages in contract shape, each with its correction read in the same transaction. */
async function toMessages(
  tx: Tx,
  tenantId: string,
  rows: CoachingMessageRow[],
): Promise<CoachMessage[]> {
  const corrections = new Map<string, Correction>();
  for (const id of new Set(rows.map((r) => r.correctionId).filter((id) => id !== null)))
    corrections.set(id, toCorrection(await getCorrection({ tx, tenantId }, id)));
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    author: r.author,
    kind: r.kind,
    text: r.body,
    includeUnreviewed: r.includeUnreviewed,
    createdAt: r.createdAt.toISOString(),
    explainer: r.explainer ? Explainer.parse(r.explainer) : null,
    correction: r.correctionId ? (corrections.get(r.correctionId) ?? null) : null,
  }));
}

function toReplayTurn(t: ReplayTurnRow, message: CoachMessage | null): ReplayTurn {
  return {
    messageId: t.messageId,
    index: t.index,
    question: t.question,
    askedAt: t.askedAt.toISOString(),
    original: t.original.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })),
    status: t.replayed ? 'done' : 'pending',
    replayed: message,
    effects: t.effects,
    factsChanged: t.factsChanged,
  };
}

/** A replay in contract shape; replayed answers carry no correction (FEAT-028 §3). */
async function toReplay(tx: Tx, tenantId: string, r: ReplayView): Promise<Replay> {
  const rows = r.turns.flatMap((t) => (t.replayed ? [t.replayed] : []));
  const messages = new Map((await toMessages(tx, tenantId, rows)).map((m) => [m.id, m]));
  return {
    id: r.session.id,
    conversationId: r.conversationId,
    includeUnreviewed: r.session.includeUnreviewed,
    createdAt: r.session.createdAt.toISOString(),
    totalQuestions: r.totalQuestions,
    turns: r.turns.map((t) =>
      toReplayTurn(t, t.replayed ? (messages.get(t.replayed.id) ?? null) : null),
    ),
  };
}

function bodyOf<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new InvalidCoachBodyError('invalid body');
  return parsed.data;
}

/**
 * Coaching (AGT-17, ONB-05; FEAT-027 §3, §5.5), dashboard trust zone, Owner and Admin
 * only (`coach.use`). Turns run here, synchronously (D1); the tenant comes from the
 * session only. A confirm embeds before its transaction and re-answers after it.
 */
export function registerCoachRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, llm, rateLimiter } = deps;
  const coach = { zdb: dashboardDb, llm };

  async function coachUser(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'coach.use')) throw new ForbiddenError('coach.use');
    return s;
  }

  const sessionId = (id: string) => {
    if (!UUID_RE.test(id)) throw new CoachingSessionNotFoundError('session not found');
    return id;
  };
  const correctionId = (id: string) => {
    if (!UUID_RE.test(id)) throw new CorrectionNotFoundError('correction not found');
    return id;
  };

  app.post('/api/v1/coach/sessions', async (req, reply) => {
    const s = await coachUser(req);
    const { origin } = bodyOf(CoachSessionCreate, req.body);
    const row = await withTenant(dashboardDb, s.tenantId, (tx) =>
      createSession(tx, { tenantId: s.tenantId, userId: s.userId, origin }),
    );
    return reply.code(201).send(CoachSessionResponse.parse({ session: toSession(row) }));
  });

  app.get('/api/v1/coach/sessions', async (req) => {
    const s = await coachUser(req);
    const { cursor } = CoachSessionListQuery.parse(req.query);
    const page = await withTenant(dashboardDb, s.tenantId, (tx) =>
      listSessions(tx, s.tenantId, cursor),
    );
    return CoachSessionList.parse({
      sessions: page.sessions.map(toSession),
      nextCursor: page.nextCursor,
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/coach/sessions/:id', async (req) => {
    const s = await coachUser(req);
    const id = sessionId(req.params.id);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const session = await getSession(tx, s.tenantId, id);
      if (!session) throw new CoachingSessionNotFoundError('session not found');
      const rows = await sessionMessages(tx, s.tenantId, id);
      return CoachSessionDetail.parse({
        session: toSession(session),
        messages: await toMessages(tx, s.tenantId, rows),
      });
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/coach/sessions/:id/messages',
    async (req, reply) => {
      const s = await coachUser(req);
      const id = sessionId(req.params.id);
      const body = bodyOf(CoachTurnRequest, req.body);
      const exists = await withTenant(dashboardDb, s.tenantId, (tx) =>
        getSession(tx, s.tenantId, id),
      );
      if (!exists) throw new CoachingSessionNotFoundError('session not found');
      let allowed: boolean;
      try {
        allowed = (await rateLimiter.hit(`coach:${s.userId}`, TURNS_PER_MINUTE, 60_000)).allowed;
      } catch (err) {
        req.log.error({ err }, 'rate limiter unavailable');
        throw new UnavailableError('rate limiter');
      }
      if (!allowed) throw new CoachRateLimitedError();
      const r = await runCoachingTurn(coach, {
        tenantId: s.tenantId,
        userId: s.userId,
        sessionId: id,
        text: body.text,
        includeUnreviewed: body.includeUnreviewed,
      });
      const [question, answer] = await withTenant(dashboardDb, s.tenantId, (tx) =>
        toMessages(tx, s.tenantId, [r.question, r.answer]),
      );
      return reply.code(201).send(CoachTurnResponse.parse({ question, answer }));
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/coach/corrections/:id/confirm', async (req) => {
    const s = await coachUser(req);
    const id = correctionId(req.params.id);
    bodyOf(CorrectionDecision, req.body);
    const current = await withTenant(dashboardDb, s.tenantId, (tx) =>
      getCorrection({ tx, tenantId: s.tenantId }, id),
    );
    const input = correctionFactInput(current);
    const chunk = input ? await prepareChunk(llm, s.tenantId, input) : undefined;
    const done = await withTenant(dashboardDb, s.tenantId, (tx) =>
      confirmCorrection(dashboardKb(tx, s.tenantId, s.userId), id, {
        ...(chunk ? { chunk } : {}),
        applyHours: applyHoursWith({ tenantId: s.tenantId, userId: s.userId }),
      }),
    );
    const { before, after } = await reanswer(coach, {
      tenantId: s.tenantId,
      userId: s.userId,
      correction: done,
    });
    const shown = await withTenant(dashboardDb, s.tenantId, (tx) =>
      toMessages(
        tx,
        s.tenantId,
        [before, after].filter((m) => m !== null),
      ),
    );
    return CorrectionConfirmResponse.parse({
      correction: toCorrection(done),
      before: before ? shown.find((m) => m.id === before.id) : null,
      after: after ? shown.find((m) => m.id === after.id) : null,
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/coach/corrections/:id/dismiss', async (req) => {
    const s = await coachUser(req);
    const id = correctionId(req.params.id);
    bodyOf(CorrectionDecision, req.body);
    const done = await withTenant(dashboardDb, s.tenantId, (tx) =>
      dismissCorrection(dashboardKb(tx, s.tenantId, s.userId), id),
    );
    return CorrectionResponse.parse({ correction: toCorrection(done) });
  });

  // ---- Replay (AGT-17, UC-04 4b; FEAT-028 §3, §5.3): one question per request (D1).

  app.get('/api/v1/coach/replay-candidates', async (req) => {
    const s = await coachUser(req);
    const { cursor } = ReplayCandidateQuery.parse(req.query);
    const page = await replayCandidates(coach, {
      tenantId: s.tenantId,
      ...(cursor ? { cursor } : {}),
    });
    return ReplayCandidateList.parse({
      conversations: page.conversations.map((c) => ({
        id: c.conversation.id,
        channel: c.conversation.channel,
        status: c.conversation.status,
        startedAt: c.conversation.createdAt.toISOString(),
        lastMessageAt: c.conversation.lastMessageAt.toISOString(),
        firstQuestion: c.firstQuestion,
        questions: c.questions,
        flagged: c.conversation.flaggedAt !== null,
        lastReplayId: c.lastReplayId,
      })),
      nextCursor: page.nextCursor,
    });
  });

  app.post('/api/v1/coach/replays', async (req, reply) => {
    const s = await coachUser(req);
    const body = bodyOf(ReplayCreate, req.body);
    const r = await startReplay(coach, {
      tenantId: s.tenantId,
      userId: s.userId,
      conversationId: body.conversationId,
      includeUnreviewed: body.includeUnreviewed,
    });
    const replay = await withTenant(dashboardDb, s.tenantId, (tx) => toReplay(tx, s.tenantId, r));
    return reply.code(201).send(ReplayResponse.parse({ replay }));
  });

  app.get<{ Params: { id: string } }>('/api/v1/coach/replays/:id', async (req) => {
    const s = await coachUser(req);
    const id = sessionId(req.params.id);
    const r = await getReplay(coach, { tenantId: s.tenantId, sessionId: id });
    const replay = await withTenant(dashboardDb, s.tenantId, (tx) => toReplay(tx, s.tenantId, r));
    return ReplayResponse.parse({ replay });
  });

  app.post<{ Params: { id: string } }>('/api/v1/coach/replays/:id/next', async (req) => {
    const s = await coachUser(req);
    const id = sessionId(req.params.id);
    bodyOf(ReplayNextRequest, req.body);
    // 404 before the limiter: another tenant's replay never spends the user's budget.
    await getReplay(coach, { tenantId: s.tenantId, sessionId: id });
    let allowed: boolean;
    try {
      allowed = (await rateLimiter.hit(`replay:${s.userId}`, REPLAYS_PER_MINUTE, 60_000)).allowed;
    } catch (err) {
      req.log.error({ err }, 'rate limiter unavailable');
      throw new UnavailableError('rate limiter');
    }
    if (!allowed) throw new ReplayRateLimitedError();
    const r = await replayNext(coach, { tenantId: s.tenantId, userId: s.userId, sessionId: id });
    const [message] = await withTenant(dashboardDb, s.tenantId, (tx) =>
      toMessages(tx, s.tenantId, r.turn.replayed ? [r.turn.replayed] : []),
    );
    return ReplayNextResponse.parse({
      turn: toReplayTurn(r.turn, message ?? null),
      remaining: r.remaining,
    });
  });

  /**
   * Up to 3 template questions not yet answered by an approved FAQ, then up to 3 about
   * the newest approved products and policies (FEAT-027 §3).
   */
  app.get('/api/v1/coach/suggestions', async (req) => {
    const s = await coachUser(req);
    const questions = await withTenant(dashboardDb, s.tenantId, async (tx) => {
      const kb = dashboardKb(tx, s.tenantId, s.userId);
      const profile = await getBusinessProfile(tx, s.tenantId, sgDay(new Date()));
      const template = profile.industry ? INDUSTRY_TEMPLATES[profile.industry] : undefined;
      const out: string[] = [];
      if (template) {
        const answered = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await listFacts(kb, { type: 'faq', status: 'approved', cursor, limit: 200 });
          for (const f of page.facts)
            if (f.type === 'faq') answered.add(questionKey(f.value.question));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        out.push(
          ...template.suggestedFaqs
            .filter((f) => !answered.has(questionKey(f.question)))
            .slice(0, SUGGESTED_FROM_TEMPLATE)
            .map((f) => f.question),
        );
      }
      const newest = [
        ...(await listFacts(kb, { type: 'product', status: 'approved', limit: 3 })).facts,
        ...(await listFacts(kb, { type: 'policy', status: 'approved', limit: 3 })).facts,
      ]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, SUGGESTED_FROM_FACTS);
      for (const f of newest)
        if (f.type === 'product') out.push(`How much is ${f.value.name}?`);
        else if (f.type === 'policy') out.push(`What's your ${f.value.title}?`);
      return out;
    });
    return CoachSuggestions.parse({ questions });
  });
}
