import {
  CloseConversationBody,
  CloseConversationResponse,
  ConversationList,
  ConversationListQuery,
  ConversationThread,
  ThreadPage,
  ThreadPageQuery,
  type RealtimeEvent,
  type ThreadEvent,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can, memberNames } from '@kaki/identity';
import {
  AlreadyClosedError,
  BadCursorError,
  closeByStaff,
  ConversationNotFoundError,
  conversationSummary,
  getConversation,
  getThread,
  inboxCounts,
  intentCounts,
  listConversations,
  NotFoundError,
  sidebarFacts,
  StateChangedError,
  threadEvents,
  toSummary,
  visitorHistory,
} from '@kaki/inbox';
import { factChips } from '@kaki/kb';
import { channels } from '@kaki/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
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
  const { dashboardDb, identityDb } = deps;

  const reader = async (req: FastifyRequest) => {
    const s = await sessionFrom(req);
    if (!can(s.role, 'inbox.read')) throw new ForbiddenError('inbox.read');
    return s;
  };

  app.get('/api/v1/conversations', async (req, reply) => {
    const s = await reader(req);
    const q = ConversationListQuery.parse(req.query);
    try {
      const out = await withTenant(dashboardDb, s.tenantId, async (tx) => ({
        ...(await listConversations(tx, s.tenantId, q)),
        counts: await inboxCounts(tx, s.tenantId),
      }));
      return ConversationList.parse(out);
    } catch (err) {
      if (err instanceof BadCursorError) return badCursor(reply);
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
        summary: (await conversationSummary(tx, t, id))!,
        thread: await getThread(tx, t, id, { limit: THREAD_PAGE }),
        events: await threadEvents(tx, t, id),
        history: (await visitorHistory(tx, t, id))!,
        intents: await intentCounts(tx, t, id),
        facts: chips.map((chip) => ({
          ...chip,
          uses: used.find((u) => u.factId === chip.id)!.uses,
        })),
      };
    });
    if (!data) throw new NotFoundError('conversation not found');
    // Audit entries hold user IDs only (ADR-014); names come from identity per request (D7).
    const userIds = data.events.flatMap((e) => (e.actor.id ? [e.actor.id] : []));
    const names = userIds.length
      ? await withTenant(identityDb, t, (tx) => memberNames(tx, userIds))
      : new Map<string, string>();
    const events: ThreadEvent[] = data.events.map(({ actor, ...e }) => ({
      ...e,
      actor: { type: actor.type, name: actor.id ? (names.get(actor.id) ?? null) : null },
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
          label: 'Website visitor',
          firstSeenAt: data.history.firstSeenAt.toISOString(),
          previousConversations: data.history.previousConversations,
        },
        channel: data.row.channel,
        intents: data.intents,
        lead: null,
        facts: data.facts,
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
    const s = await sessionFrom(req);
    if (!can(s.role, 'inbox.reply')) throw new ForbiddenError('inbox.reply');
    const id = conversationIdOf(req);
    const { version } = CloseConversationBody.parse(req.body);
    const t = s.tenantId;
    let summary;
    try {
      summary = await withTenant(dashboardDb, t, async (tx) => {
        await closeByStaff(tx, { tenantId: t, conversationId: id, userId: s.userId, version });
        return (await conversationSummary(tx, t, id))!;
      });
    } catch (err) {
      if (err instanceof ConversationNotFoundError) throw new NotFoundError('not found');
      if (err instanceof AlreadyClosedError)
        return reply
          .code(409)
          .send({ error: 'already_closed', message: 'This conversation is already closed.' });
      if (err instanceof StateChangedError) {
        const current = await withTenant(dashboardDb, t, (tx) => conversationSummary(tx, t, id));
        return reply.code(409).send({
          error: 'state_changed',
          message: 'This conversation changed. Check it and try again.',
          conversation: current ?? toSummary(err.conversation, null),
        });
      }
      throw err;
    }
    // After commit; a failed publish is logged by notify (the inbox refetches on reconnect).
    await notify([channels.inbox(t)], { type: 'conversation', conversation: summary });
    return CloseConversationResponse.parse({ conversation: summary });
  });
}
