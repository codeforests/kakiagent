import {
  NothingToAnswerError,
  suggestReply,
  SuggestPausedError,
  TooManySuggestionsError,
} from '@kaki/agent';
import {
  CloseConversationBody,
  CloseConversationResponse,
  ConversationList,
  ConversationListQuery,
  ConversationSearchRequest,
  ConversationSearchResults,
  ConversationThread,
  HandBackBody,
  InboxMembers,
  StaffMessageBody,
  StaffMessageResponse,
  SuggestionRequest,
  SuggestionResponse,
  TakeOverBody,
  TakeoverResult,
  ThreadPage,
  ThreadPageQuery,
  type ConversationSummary,
  type MemberEvent,
  type RealtimeEvent,
  type ThreadEvent,
} from '@kaki/contracts';
import { pendingApprovalOf } from '@kaki/approvals';
import { withTenant } from '@kaki/db';
import { can, displayNameOf, inboxMembers, memberNames } from '@kaki/identity';
import {
  AlreadyClosedError,
  AlreadyOwnerError,
  BadCursorError,
  closeByStaff,
  ConversationNotFoundError,
  conversationSummary,
  getConversation,
  getMessage,
  getThread,
  handBack,
  IllegalTransitionError,
  inboxCounts,
  intentCounts,
  listConversations,
  NotFoundError,
  NotOwnedError,
  NotOwnerError,
  OwnedError,
  QueryTooShortError,
  recordSuggestionUse,
  requestHandover,
  searchConversations,
  sendStaffMessage,
  sidebarFacts,
  StateChangedError,
  takeOver,
  threadEvents,
  toMessage,
  toSummary,
  visitorHistory,
  type ConversationRow,
  type OwnerNames,
} from '@kaki/inbox';
import { dashboardKb, factChips, proposeReplyEdit } from '@kaki/kb';
import { contactOf, leadSummaryOf } from '@kaki/leads';
import { channels } from '@kaki/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { widgetLive } from './channels.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREAD_PAGE = 100;

function conversationIdOf(req: FastifyRequest<{ Params: { id: string } }>): string {
  if (!UUID_RE.test(req.params.id)) throw new NotFoundError('conversation not found');
  return req.params.id;
}

const badCursor = (reply: FastifyReply) =>
  reply.code(400).send({ error: 'bad_cursor', message: 'Reload the inbox.' });

/**
 * The inbox (INB-01, INB-04, INB-08; FEAT-042 §3, §5.4): dashboard trust zone. The views
 * with keyset pages and tab counts, a thread with its dividers and sidebar, older pages,
 * and staff close. The tenant comes only from the session.
 */
export function registerInboxRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
  notify: (channelNames: string[], event: RealtimeEvent) => Promise<void>,
) {
  const { dashboardDb, identityDb, publisher } = deps;

  /** Staff-facing names through the identity zone (FEAT-042 D7), for owners on summaries. */
  const namesIn =
    (t: string): OwnerNames =>
    (ids) =>
      ids.length
        ? withTenant(identityDb, t, (tx) => memberNames(tx, ids))
        : Promise.resolve(new Map());
  const nameOf = async (t: string, userId: string) =>
    (await namesIn(t)([userId])).get(userId) ?? 'A team member';
  const summaryOf = async (t: string, id: string, row?: ConversationRow) =>
    (await withTenant(dashboardDb, t, (tx) => conversationSummary(tx, t, id, namesIn(t)))) ??
    (row ? toSummary(row, null) : null);
  /** To one member's sockets only (FEAT-043 §5.4); post-commit, a failure is only logged. */
  const notifyMember = async (t: string, userId: string, event: MemberEvent) => {
    try {
      await publisher.publish(channels.member(t, userId), event);
    } catch (err) {
      deps.logger.warn({ err }, 'member publish failed');
    }
  };
  const ownedReply = async (reply: FastifyReply, t: string, err: OwnedError) => {
    const name = await nameOf(t, err.owner.userId);
    return reply.code(409).send({
      error: 'owned',
      message: `${name} is handling this conversation.`,
      owner: { userId: err.owner.userId, name },
    });
  };
  const stateChangedReply = async (
    reply: FastifyReply,
    t: string,
    id: string,
    row: ConversationRow,
  ) =>
    reply.code(409).send({
      error: 'state_changed',
      message: 'This conversation changed. Check it and try again.',
      conversation: await summaryOf(t, id, row),
    });
  const replier = async (req: FastifyRequest) => {
    const s = await sessionFrom(req);
    if (!can(s.role, 'inbox.reply')) throw new ForbiddenError('inbox.reply');
    return s;
  };

  const reader = async (req: FastifyRequest) => {
    const s = await sessionFrom(req);
    if (!can(s.role, 'inbox.read')) throw new ForbiddenError('inbox.read');
    return s;
  };

  app.get('/api/v1/conversations', async (req, reply) => {
    const s = await reader(req);
    const { assignee, ...q } = ConversationListQuery.parse(req.query);
    // INB-01 by assignee (FEAT-043 D7): `me` is the session's user, never a body value.
    const filter =
      assignee === undefined
        ? undefined
        : assignee === 'none'
          ? ({ kind: 'none' } as const)
          : ({ kind: 'user', userId: assignee === 'me' ? s.userId : assignee } as const);
    try {
      const out = await withTenant(dashboardDb, s.tenantId, async (tx) => ({
        ...(await listConversations(
          tx,
          s.tenantId,
          { ...q, assignee: filter },
          namesIn(s.tenantId),
        )),
        counts: await inboxCounts(tx, s.tenantId),
      }));
      return ConversationList.parse(out);
    } catch (err) {
      if (err instanceof BadCursorError) return badCursor(reply);
      throw err;
    }
  });

  /**
   * Conversation search (INB-11; FEAT-046 §3, §5.2). A POST so the text stays out of URLs
   * and request logs (D3); nothing about the query is logged or audited (D7).
   */
  app.post('/api/v1/conversations/search', async (req, reply) => {
    const s = await reader(req);
    const body = ConversationSearchRequest.parse(req.body);
    try {
      const out = await withTenant(dashboardDb, s.tenantId, (tx) =>
        searchConversations(tx, s.tenantId, body, namesIn(s.tenantId)),
      );
      return ConversationSearchResults.parse(out);
    } catch (err) {
      if (err instanceof BadCursorError) return badCursor(reply);
      if (err instanceof QueryTooShortError)
        return reply
          .code(400)
          .send({ error: 'query_too_short', message: 'Type at least 2 characters.' });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/conversations/:id', async (req) => {
    const s = await reader(req);
    const id = conversationIdOf(req);
    const t = s.tenantId;
    const data = await withTenant(dashboardDb, t, async (tx) => {
      const row = await getConversation(tx, t, id);
      if (!row) return null;
      const used = await sidebarFacts(tx, t, id);
      const chips = await factChips(
        tx,
        t,
        used.map((f) => f.factId),
      );
      return {
        row,
        summary: (await conversationSummary(tx, t, id, namesIn(t)))!,
        thread: await getThread(tx, t, id, { limit: THREAD_PAGE }),
        events: await threadEvents(tx, t, id),
        history: (await visitorHistory(tx, t, id))!,
        intents: await intentCounts(tx, t, id),
        // FEAT-049 §5.4: the contact who left details here, and their lead (api-side: inbox
        // never imports leads).
        contact: await contactOf(tx, t, id),
        duplicates: 0,
        lead: await leadSummaryOf(tx, t, id),
        // FEAT-055 §5.3: the pending approval (api-side: inbox never imports approvals).
        approval: await pendingApprovalOf(tx, t, id),
        facts: chips.map((chip) => ({
          ...chip,
          uses: used.find((u) => u.factId === chip.id)!.uses,
        })),
      };
    });
    if (!data) throw new NotFoundError('conversation not found');
    // Audit entries hold user IDs only (ADR-014); names come from identity per request (D7).
    const userIds = data.events.flatMap((e) => [
      ...(e.actor.id ? [e.actor.id] : []),
      ...(e.subject?.id ? [e.subject.id] : []),
    ]);
    const names = userIds.length
      ? await withTenant(identityDb, t, (tx) => memberNames(tx, userIds))
      : new Map<string, string>();
    const events: ThreadEvent[] = data.events.map(({ actor, subject, ...e }) => ({
      ...e,
      actor: { type: actor.type, name: actor.id ? (names.get(actor.id) ?? null) : null },
      subject: subject ? { name: subject.id ? (names.get(subject.id) ?? null) : null } : null,
    }));
    return ConversationThread.parse({
      conversation: {
        ...data.summary,
        version: data.row.version,
        createdAt: data.row.createdAt.toISOString(),
      },
      messages: data.thread.messages,
      hasEarlier: data.thread.hasEarlier,
      events,
      sidebar: {
        contact: {
          contactId: data.contact?.contactId ?? null,
          name: data.contact?.name ?? null,
          email: data.contact?.email ?? null,
          phone: data.contact?.phone ?? null,
          telegramUsername: data.contact?.telegramUsername ?? null,
          label: data.contact?.name ?? 'Website visitor',
          firstSeenAt: data.history.firstSeenAt.toISOString(),
          previousConversations: data.history.previousConversations,
          verified: data.contact?.verified ?? { email: false, telegram: false },
          duplicates: data.duplicates,
        },
        channel: data.row.channel,
        intents: data.intents,
        lead: data.lead,
        facts: data.facts,
        approval: data.approval
          ? {
              id: data.approval.id,
              status: 'pending',
              slaDueAt: data.approval.slaDueAt.toISOString(),
            }
          : null,
      },
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/conversations/:id/messages', async (req) => {
    const s = await reader(req);
    const id = conversationIdOf(req);
    const { before } = ThreadPageQuery.parse(req.query);
    const page = await withTenant(dashboardDb, s.tenantId, async (tx) =>
      (await getConversation(tx, s.tenantId, id))
        ? getThread(tx, s.tenantId, id, { before, limit: THREAD_PAGE })
        : null,
    );
    if (!page) throw new NotFoundError('conversation not found');
    return ThreadPage.parse(page);
  });

  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/close', async (req, reply) => {
    const s = await replier(req);
    const id = conversationIdOf(req);
    const { version } = CloseConversationBody.parse(req.body);
    const t = s.tenantId;
    let summary;
    try {
      summary = await withTenant(dashboardDb, t, async (tx) => {
        await closeByStaff(tx, { tenantId: t, conversationId: id, userId: s.userId, version });
        return (await conversationSummary(tx, t, id, namesIn(t)))!;
      });
    } catch (err) {
      if (err instanceof ConversationNotFoundError) throw new NotFoundError('not found');
      // Only the owner closes a taken-over conversation (FEAT-043 D6).
      if (err instanceof OwnedError) return ownedReply(reply, t, err);
      if (err instanceof AlreadyClosedError)
        return reply
          .code(409)
          .send({ error: 'already_closed', message: 'This conversation is already closed.' });
      if (err instanceof StateChangedError)
        return stateChangedReply(reply, t, id, err.conversation);
      throw err;
    }
    // After commit; a failed publish is logged by notify (the inbox refetches on reconnect).
    await notify([channels.inbox(t)], { type: 'conversation', conversation: summary });
    return CloseConversationResponse.parse({ conversation: summary });
  });

  // ---- Takeover (INB-02, INB-09; FEAT-043 §3, §5.4) -----------------------------------------

  /** After commit: the summary to the inbox, the notice to the widget's stream and the inbox. */
  const publishChange = async (
    t: string,
    id: string,
    summary: ConversationSummary,
    message: RealtimeEvent & { type: 'message' },
  ) => {
    await notify([channels.conversation(t, id), channels.inbox(t)], message);
    await notify([channels.inbox(t)], { type: 'conversation', conversation: summary });
  };

  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/takeover', async (req, reply) => {
    const s = await replier(req);
    const id = conversationIdOf(req);
    const body = TakeOverBody.parse(req.body);
    // Taking it from a teammate is for owners and admins (D1).
    if (body.from !== undefined && !can(s.role, 'inbox.reassign'))
      throw new ForbiddenError('inbox.reassign');
    const t = s.tenantId;
    // The visitor-facing name is snapshotted now, through the identity zone (D3).
    const visitorName = await withTenant(identityDb, t, (tx) => displayNameOf(tx, s.userId));
    let out;
    try {
      out = await withTenant(dashboardDb, t, async (tx) => {
        const r = await takeOver(tx, {
          tenantId: t,
          conversationId: id,
          userId: s.userId,
          visitorName,
          version: body.version,
          from: body.from,
        });
        return { ...r, summary: (await conversationSummary(tx, t, id, namesIn(t)))! };
      });
    } catch (err) {
      if (err instanceof ConversationNotFoundError) throw new NotFoundError('not found');
      if (err instanceof OwnedError) return ownedReply(reply, t, err);
      if (err instanceof AlreadyOwnerError)
        return reply
          .code(409)
          .send({ error: 'already_owner', message: 'You are already handling this conversation.' });
      if (err instanceof IllegalTransitionError && err.from === 'closed')
        return reply.code(409).send({ error: 'closed', message: 'This conversation is closed.' });
      if (err instanceof StateChangedError)
        return stateChangedReply(reply, t, id, err.conversation);
      if (err instanceof IllegalTransitionError) {
        const row = await withTenant(dashboardDb, t, (tx) => getConversation(tx, t, id));
        return stateChangedReply(reply, t, id, row!);
      }
      throw err;
    }
    const notice = toMessage(out.notice);
    await publishChange(t, id, out.summary, { type: 'message', message: notice });
    if (out.previousOwner)
      await notifyMember(t, out.previousOwner, {
        type: 'taken_from_you',
        conversationId: id,
        by: { userId: s.userId, name: await nameOf(t, s.userId) },
      });
    return TakeoverResult.parse({ conversation: out.summary, notice });
  });

  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/handback', async (req, reply) => {
    const s = await replier(req);
    const id = conversationIdOf(req);
    const { version } = HandBackBody.parse(req.body);
    const t = s.tenantId;
    let out;
    try {
      out = await withTenant(dashboardDb, t, async (tx) => {
        const r = await handBack(tx, {
          tenantId: t,
          conversationId: id,
          userId: s.userId,
          version,
          // D5: a pending approval sends the hand-back to `waiting_approval`.
          hasPendingApproval: (q) => pendingApprovalOf(q, t, id).then(Boolean),
        });
        return { ...r, summary: (await conversationSummary(tx, t, id, namesIn(t)))! };
      });
    } catch (err) {
      if (err instanceof ConversationNotFoundError) throw new NotFoundError('not found');
      if (err instanceof NotOwnerError)
        return reply.code(409).send({
          error: 'not_owner',
          message: "You aren't handling this conversation.",
          conversation: await summaryOf(t, id, err.conversation),
        });
      if (err instanceof StateChangedError)
        return stateChangedReply(reply, t, id, err.conversation);
      throw err;
    }
    const notice = toMessage(out.notice);
    await publishChange(t, id, out.summary, { type: 'message', message: notice });
    return TakeoverResult.parse({ conversation: out.summary, notice });
  });

  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/messages', async (req, reply) => {
    const s = await replier(req);
    const id = conversationIdOf(req);
    const parsed = StaffMessageBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(422).send({ error: 'validation', message: 'Write a message to send.' });
    const t = s.tenantId;
    let out;
    try {
      out = await withTenant(dashboardDb, t, async (tx) => {
        const r = await sendStaffMessage(tx, {
          tenantId: t,
          conversationId: id,
          userId: s.userId,
          body: parsed.data.body,
          clientMessageId: parsed.data.clientMessageId,
        });
        // FEAT-045 §5.4: a draft's use is recorded once, with the send; a retry does nothing.
        const suggestionId = parsed.data.suggestionId;
        if (r.created && suggestionId) {
          const use = await recordSuggestionUse(tx, {
            tenantId: t,
            conversationId: id,
            userId: s.userId,
            suggestionId,
            message: r.message,
          });
          if (use.used && use.edited)
            await proposeReplyEdit(dashboardKb(tx, t, s.userId), {
              conversationId: id,
              suggestionId,
              factIds: use.factIds,
            });
          else if (use.used) r.message = { ...r.message, factIds: use.factIds };
        }
        return { ...r, summary: (await conversationSummary(tx, t, id, namesIn(t)))! };
      });
    } catch (err) {
      if (err instanceof ConversationNotFoundError) throw new NotFoundError('not found');
      if (err instanceof NotOwnerError)
        return reply.code(409).send({
          error: 'not_owner',
          message: "You aren't handling this conversation.",
          conversation: await summaryOf(t, id, err.conversation),
        });
      throw err;
    }
    const message = toMessage(out.message);
    if (out.created) await publishChange(t, id, out.summary, { type: 'message', message });
    return reply.code(out.created ? 201 : 200).send(
      StaffMessageResponse.parse({
        message: {
          ...message,
          factIds: out.message.factIds,
          authorUserId: out.message.authorUserId,
        },
      }),
    );
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/conversations/:id/handover-request',
    async (req, reply) => {
      const s = await replier(req);
      const id = conversationIdOf(req);
      const t = s.tenantId;
      let ownerId: string;
      try {
        ownerId = await withTenant(dashboardDb, t, async (tx) => {
          if (!(await getConversation(tx, t, id))) throw new NotFoundError('not found');
          return requestHandover(tx, { tenantId: t, conversationId: id, userId: s.userId });
        });
      } catch (err) {
        if (err instanceof NotOwnedError)
          return reply.code(409).send({
            error: 'not_owned',
            message: 'Nobody is handling this conversation. Take it over instead.',
          });
        if (err instanceof AlreadyOwnerError)
          return reply.code(409).send({
            error: 'already_owner',
            message: 'You are already handling this conversation.',
          });
        throw err;
      }
      await notifyMember(t, ownerId, {
        type: 'handover_requested',
        conversationId: id,
        by: { userId: s.userId, name: await nameOf(t, s.userId) },
      });
      const summary = await summaryOf(t, id);
      if (summary)
        await notify([channels.inbox(t)], { type: 'conversation', conversation: summary });
      return reply.code(202).send({});
    },
  );

  /**
   * A suggested reply for the owner's composer (INB-03; FEAT-045 §5.4): synchronous, like
   * replay (D1). Nothing is sent, published or stored as a message.
   */
  app.post<{ Params: { id: string } }>(
    '/api/v1/conversations/:id/suggestion',
    async (req, reply) => {
      const s = await replier(req);
      const id = conversationIdOf(req);
      if (!SuggestionRequest.safeParse(req.body ?? {}).success)
        return reply.code(422).send({ error: 'validation', message: 'Nothing to send here.' });
      const t = s.tenantId;
      let row;
      try {
        row = await suggestReply(
          { zdb: dashboardDb, llm: deps.llm, channelLive: widgetLive(dashboardDb, t) },
          { tenantId: t, conversationId: id, userId: s.userId },
        );
      } catch (err) {
        if (err instanceof ConversationNotFoundError) throw new NotFoundError('not found');
        if (err instanceof NotOwnerError)
          return reply.code(409).send({
            error: 'not_owner',
            message: "You aren't handling this conversation.",
            conversation: await summaryOf(t, id, err.conversation),
          });
        if (err instanceof SuggestPausedError)
          return reply.code(409).send({
            error: 'ai_paused',
            message: "The assistant is paused, so it can't suggest replies.",
          });
        if (err instanceof NothingToAnswerError)
          return reply.code(409).send({
            error: 'nothing_to_answer',
            message: "There's no customer message to answer yet.",
          });
        if (err instanceof TooManySuggestionsError)
          return reply.code(429).header('Retry-After', String(err.retryAfterS)).send({
            error: 'too_many_suggestions',
            message: 'Too many suggestions for this conversation. Try again later.',
          });
        throw err;
      }
      const ready = row.outcome === 'ready' && row.body !== null;
      const suggestion = ready
        ? await withTenant(dashboardDb, t, async (tx) => ({
            id: row.id,
            text: row.body!,
            facts: await factChips(tx, t, row.factIds),
            forMessageId: row.forMessageId,
            forSeq: (await getMessage(tx, t, row.forMessageId))!.seq,
            language: row.language,
            createdAt: row.createdAt.toISOString(),
          }))
        : null;
      return reply.code(201).send(
        SuggestionResponse.parse({
          suggestion,
          none: ready ? null : row.outcome,
        }),
      );
    },
  );

  app.get('/api/v1/inbox/members', async (req) => {
    const s = await reader(req);
    const members = await withTenant(identityDb, s.tenantId, (tx) => inboxMembers(tx));
    return InboxMembers.parse({ members });
  });
}
