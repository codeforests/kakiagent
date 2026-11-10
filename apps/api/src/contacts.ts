import {
  contactDetail,
  ContactNotFound,
  mergeContacts,
  NotMergeable,
  searchContacts,
  undoMerge,
  UndoBlocked,
  type ChannelContactDetail,
} from '@kaki/channels/contacts';
import {
  ContactConflict409,
  ContactDetail,
  ContactSearchBody,
  ContactSearchResponse,
  MergeBody,
  MergePreview,
  MergeResponse,
  UndoMergeResponse,
  type ConsentDecision,
  type ContactIdentity,
  type ContactSide,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can, memberNames } from '@kaki/identity';
import { NotFoundError } from '@kaki/inbox';
import { contactLeads, contactLeadSummary, type ContactLeadSummary } from '@kaki/leads';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** 409s and 404s of the contact routes (FEAT-039 §3). */
export function contactsErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof NotMergeable)
    return {
      status: 409,
      body: ContactConflict409.parse({ error: 'not_mergeable', reason: err.reason }),
    };
  if (err instanceof UndoBlocked)
    return {
      status: 409,
      body: ContactConflict409.parse({ error: 'undo_blocked', reason: err.reason }),
    };
  if (err instanceof ContactNotFound)
    return { status: 404, body: { error: 'not_found', message: 'Contact not found' } };
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The later of two consent decisions per purpose (D8: the latest row wins, FEAT-051). */
function consentAfter(a: ContactLeadSummary, b: ContactLeadSummary): ContactSide['consent'] {
  const pick = (p: 'enquiry' | 'marketing'): ConsentDecision | null => {
    const [x, y] = [a, b].map((s) => ({ at: s.latest[p], decision: s.consent[p] }));
    if (!x!.at) return y!.decision;
    if (!y!.at) return x!.decision;
    return x!.at.getTime() >= y!.at.getTime() ? x!.decision : y!.decision;
  };
  return { enquiry: pick('enquiry'), marketing: pick('marketing') };
}

/** Both contacts' identifiers, one per (kind, value), verified if either holds it verified. */
function unionIdentities(a: ContactIdentity[], b: ContactIdentity[]): ContactIdentity[] {
  const out = new Map<string, ContactIdentity>();
  for (const i of [...a, ...b]) {
    const key = `${i.kind}:${i.value}`;
    const had = out.get(key);
    if (!had || (i.verified && !had.verified)) out.set(key, i);
  }
  return [...out.values()].sort((x, y) => x.firstSeenAt.localeCompare(y.firstSeenAt));
}

/**
 * The Contact page and contact merge (SCR-APP-016; CHN-08, UC-26 4a; FEAT-039 §3, §5.4). Viewing
 * needs `inbox.read`; merging and undoing `contacts.merge` (all staff). The tenant comes from the
 * session only; another tenant's contact or merge is 404.
 */
export function registerContactRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, identityDb } = deps;
  const namesIn = (tenantId: string) => (ids: string[]) =>
    withTenant(identityDb, tenantId, (itx) => memberNames(itx, ids));

  async function member(req: FastifyRequest, capability: 'inbox.read' | 'contacts.merge') {
    const s = await sessionFrom(req);
    if (!can(s.role, capability)) throw new ForbiddenError(capability);
    return s;
  }
  const uuid = (v: string | undefined) => {
    if (!v || !UUID_RE.test(v)) throw new NotFoundError('contact not found');
    return v;
  };
  const invalid = (reply: FastifyReply) =>
    reply.code(422).send({ error: 'invalid_body', message: 'Check the values and try again.' });

  async function channelSide(tx: Tx, s: TenantSession, id: string) {
    const c = await contactDetail(tx, s.tenantId, id, namesIn(s.tenantId));
    if (!c) throw new NotFoundError('contact not found');
    return c;
  }

  async function detailOf(tx: Tx, s: TenantSession, id: string): Promise<ContactDetail> {
    const c = await channelSide(tx, s, id);
    const leads = c.mergedInto
      ? { leads: [], consents: [] }
      : await contactLeads(tx, s.tenantId, id, namesIn(s.tenantId));
    return ContactDetail.parse({ ...c, ...leads, canMerge: can(s.role, 'contacts.merge') });
  }

  async function sideOf(
    tx: Tx,
    s: TenantSession,
    c: ChannelContactDetail,
  ): Promise<{ side: ContactSide; summary: ContactLeadSummary }> {
    const summary = await contactLeadSummary(tx, s.tenantId, c.id);
    return {
      summary,
      side: {
        contactId: c.id,
        label: c.label,
        identities: c.identities,
        conversationCount: c.conversationCount,
        openLead: summary.openLead,
        consent: summary.consent,
      },
    };
  }

  app.get('/api/v1/contacts/:id', async (req) => {
    const s = await member(req, 'inbox.read');
    const id = uuid((req.params as { id: string }).id);
    return withTenant(dashboardDb, s.tenantId, (tx) => detailOf(tx, s, id));
  });

  app.post('/api/v1/contacts/search', async (req, reply) => {
    const s = await member(req, 'inbox.read');
    const body = ContactSearchBody.safeParse(req.body);
    if (!body.success) return invalid(reply);
    return ContactSearchResponse.parse({
      contacts: await withTenant(dashboardDb, s.tenantId, (tx) =>
        searchContacts(tx, s.tenantId, body.data.q, body.data.exclude),
      ),
    });
  });

  // The preview: nothing is written; refusals as the merge would give them.
  app.get('/api/v1/contacts/:id/merge/:otherId', async (req) => {
    const s = await member(req, 'contacts.merge');
    const p = req.params as { id: string; otherId: string };
    const id = uuid(p.id);
    const otherId = uuid(p.otherId);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const keep = await channelSide(tx, s, id);
      const merge = await channelSide(tx, s, otherId);
      if (id === otherId) throw new NotMergeable('same_contact');
      if (keep.mergedInto || merge.mergedInto) throw new NotMergeable('merged');
      const k = await sideOf(tx, s, keep);
      const m = await sideOf(tx, s, merge);
      const leadOutcome =
        k.side.openLead && m.side.openLead
          ? 'supersede'
          : k.side.openLead
            ? 'keep'
            : m.side.openLead
              ? 'move'
              : 'none';
      return MergePreview.parse({
        keep: k.side,
        merge: m.side,
        after: {
          identities: unionIdentities(keep.identities, merge.identities),
          conversationCount: keep.conversationCount + merge.conversationCount,
          leadOutcome,
          consent: consentAfter(k.summary, m.summary),
        },
      });
    });
  });

  // "Merge the other into this one" (D5): the contact whose page staff are on survives.
  app.post('/api/v1/contacts/:id/merge', async (req, reply) => {
    const s = await member(req, 'contacts.merge');
    const id = uuid((req.params as { id: string }).id);
    const body = MergeBody.safeParse(req.body);
    if (!body.success) return invalid(reply);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const { mergeId } = await mergeContacts(tx, {
        tenantId: s.tenantId,
        survivorId: id,
        mergedId: body.data.otherId,
        automatic: false,
        actorId: s.userId,
      });
      return MergeResponse.parse({ mergeId, contact: await detailOf(tx, s, id) });
    });
  });

  app.post('/api/v1/contacts/merges/:mergeId/undo', async (req) => {
    const s = await member(req, 'contacts.merge');
    const mergeId = uuid((req.params as { mergeId: string }).mergeId);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const { mergedId } = await undoMerge(tx, {
        tenantId: s.tenantId,
        mergeId,
        actorId: s.userId,
      });
      return UndoMergeResponse.parse({ contact: await detailOf(tx, s, mergedId) });
    });
  });
}
