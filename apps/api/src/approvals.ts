import {
  AlreadyDecided,
  ApprovalExpired,
  ApprovalNotFound,
  approvalById,
  decide,
  InvalidTerms,
  listApprovals,
  rulesInForce,
  summaryOf,
  termsOf,
  totalsFor,
  type ApprovalRow,
  type Terms,
} from '@kaki/approvals';
import {
  ApprovalDecision,
  ApprovalDetail,
  ApprovalList,
  ApprovalListQuery,
  type RealtimeEvent,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can, canApprove, memberNames } from '@kaki/identity';
import { conversationSummary, getThread, NotFoundError, toMessage } from '@kaki/inbox';
import { factVersions } from '@kaki/kb';
import { contactOf } from '@kaki/leads';
import { channels } from '@kaki/platform';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The conversation messages shown with a request (SCR-APP-018). */
const EXCERPT = 10;

/**
 * Approvals (APR-02, APR-04, APR-06; UC-22 5, 5a, 5c; FEAT-055 §3, §5.4): the queue, the
 * detail and the decision. Any member reads (D8: an Agent without rights sees it read-only);
 * deciding needs `canApprove`. No re-auth (deciding isn't in AUTH-03's list). The result is
 * delivered in the decision's transaction and published after commit.
 */
export function registerApprovalRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
  notify: (channelNames: string[], event: RealtimeEvent) => Promise<void>,
) {
  const { dashboardDb, identityDb } = deps;

  async function reader(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'inbox.read')) throw new ForbiddenError('inbox.read');
    return s;
  }
  const idOf = (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!UUID_RE.test(req.params.id)) throw new NotFoundError('approval not found');
    return req.params.id;
  };

  /** The contact name per conversation (FEAT-049's contact; null before they left details). */
  async function contactNames(tx: Tx, t: string, rows: ApprovalRow[]) {
    const ids = [...new Set(rows.map((r) => r.conversationId))];
    const names = new Map<string, string | null>();
    for (const id of ids) names.set(id, (await contactOf(tx, t, id))?.name ?? null);
    return names;
  }

  /** `ApprovalDetail` from the row (§3): excerpt, prices with `current`, the decider's name. */
  async function detailOf(t: string, s: TenantSession, row: ApprovalRow): Promise<ApprovalDetail> {
    const data = await withTenant(dashboardDb, t, async (tx) => {
      const thread = await getThread(tx, t, row.conversationId, { limit: 50 });
      const prices = row.prices as {
        factId: string;
        version: number;
        name: string;
        priceCents: number;
        unit: string | null;
      }[];
      const versions = await factVersions(
        tx,
        t,
        prices.map((p) => p.factId),
      );
      const rules = await rulesInForce(tx, t);
      const contact = await contactOf(tx, t, row.conversationId);
      return { thread, prices, versions, rules, contact };
    });
    const by = row.decidedBy
      ? ((await withTenant(identityDb, t, (tx) => memberNames(tx, [row.decidedBy!]))).get(
          row.decidedBy,
        ) ?? 'A team member')
      : null;
    const { draft, final } = termsOf(row);
    const totals = totalsFor(row);
    const request = row.request as {
      items?: string | null;
      quantity?: string | null;
      date?: string | null;
      discountPct?: number | null;
    };
    const upTo = row.createdAt.getTime();
    const excerpt = data.thread.messages
      .filter((m) => new Date(m.createdAt).getTime() <= upTo)
      .slice(-EXCERPT);
    const summary = summaryOf(row);
    return ApprovalDetail.parse({
      ...summary,
      contactName: data.contact?.name ?? null,
      request: {
        items: request.items ?? null,
        quantity: request.quantity ?? null,
        date: request.date ?? null,
        discountPct: request.discountPct ?? null,
      },
      draft,
      draftTotals: totals.draft,
      final,
      finalTotals: totals.final,
      prices: data.prices.map((p) => {
        const v = data.versions.get(p.factId);
        return { ...p, current: !!v && v.approved && v.version === p.version };
      }),
      excerpt,
      maxDiscountPct: data.rules.rules.maxDiscountPct,
      decision: row.decidedAt
        ? {
            by: row.decidedBy ? { userId: row.decidedBy, name: by! } : null,
            at: row.decidedAt.toISOString(),
            reason: row.reason ?? null,
          }
        : null,
      version: row.version,
      canDecide: canApprove(s) && row.status === 'pending',
    });
  }

  app.get('/api/v1/approvals', async (req) => {
    const s = await reader(req);
    const q = ApprovalListQuery.parse(req.query);
    const t = s.tenantId;
    const out = await withTenant(dashboardDb, t, async (tx) => {
      const page = await listApprovals(tx, t, { view: q.view, cursor: q.cursor });
      return { page, names: await contactNames(tx, t, page.items) };
    });
    return ApprovalList.parse({
      items: out.page.items.map((row) => ({
        ...summaryOf(row),
        contactName: out.names.get(row.conversationId) ?? null,
      })),
      nextCursor: out.page.nextCursor,
      pendingCount: out.page.pendingCount,
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/approvals/:id', async (req) => {
    const s = await reader(req);
    const id = idOf(req);
    const row = await withTenant(dashboardDb, s.tenantId, (tx) => approvalById(tx, s.tenantId, id));
    if (!row) throw new NotFoundError('approval not found');
    return detailOf(s.tenantId, s, row);
  });

  app.post<{ Params: { id: string } }>('/api/v1/approvals/:id/decision', async (req, reply) => {
    const s = await reader(req);
    const id = idOf(req);
    const t = s.tenantId;
    if (!canApprove(s)) throw new ForbiddenError('approvals.decide');
    const body = ApprovalDecision.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'invalid_decision', message: 'Check the decision' });
    let out;
    try {
      out = await withTenant(dashboardDb, t, async (tx) => {
        const r = await decide(tx, {
          tenantId: t,
          approvalId: id,
          userId: s.userId,
          decision:
            body.data.action === 'edit_approve'
              ? { ...body.data, terms: body.data.terms as Terms }
              : body.data,
        });
        const summary = r.conversation ? await conversationSummary(tx, t, r.conversation.id) : null;
        return { ...r, summary };
      });
    } catch (err) {
      if (err instanceof ApprovalNotFound) throw new NotFoundError('approval not found');
      if (err instanceof AlreadyDecided)
        return reply.code(409).send({
          error: 'already_decided',
          message: 'Someone else decided this request first.',
          approval: await detailOf(t, s, err.approval),
        });
      if (err instanceof ApprovalExpired)
        return reply
          .code(409)
          .send({ error: 'expired', message: 'This request expired and can no longer be sent.' });
      if (err instanceof InvalidTerms)
        return reply.code(422).send({
          error: 'invalid_terms',
          message: 'Add at least one line or a note, and keep the total above zero.',
        });
      throw err;
    }
    const conv = out.approval.conversationId;
    await notify([channels.conversation(t, conv), channels.inbox(t)], {
      type: 'message',
      message: toMessage(out.message),
    });
    if (out.summary)
      await notify([channels.inbox(t)], { type: 'conversation', conversation: out.summary });
    await notify([channels.inbox(t)], { type: 'approval', id, status: out.approval.status });
    return detailOf(t, s, out.approval);
  });
}
