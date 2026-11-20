import {
  DSR_EXPORT_MAX_MESSAGES,
  sgToday,
  type DsrExport,
  type DsrSelection,
} from '@kaki/contracts';
import { and, asc, eq, inArray, or, schema, sql, type Tx } from '@kaki/db';
import { auditDsr, DsrError, isoOf, requireVerified, type DsrRow } from './requests.js';
import { checkSelection, findSubject, identifiersOf, type FoundSubject } from './find.js';
import { dsrRef } from './due.js';

const {
  approvals,
  consents,
  contactIdentities,
  contacts,
  conversations,
  emailAttachments,
  facts,
  kbStagedFacts,
  leads,
  messages,
} = schema;

/** The contacts a selection covers (with those merged into them) and its conversations. */
export async function scopeOf(
  tx: Tx,
  tenantId: string,
  found: FoundSubject,
  sel: DsrSelection,
): Promise<{ contactIds: string[]; conversationIds: string[] }> {
  void found;
  // Contacts merged into a selected one go with it (as `dsr_erase()` expands them).
  const contactIds = await expandMerged(tx, tenantId, sel.contactIds);
  const convs = contactIds.length
    ? await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.tenantId, tenantId), inArray(conversations.contactId, contactIds)),
        )
    : [];
  return {
    contactIds,
    conversationIds: [...new Set([...convs.map((c) => c.id), ...sel.conversationIds])],
  };
}

async function expandMerged(tx: Tx, tenantId: string, ids: string[]): Promise<string[]> {
  const out = new Set(ids);
  let frontier = ids;
  while (frontier.length) {
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.mergedInto, frontier)));
    frontier = rows.map((r) => r.id).filter((id) => !out.has(id));
    for (const id of frontier) out.add(id);
  }
  return [...out];
}

/**
 * The JSON export of an access request (UC-30 4a; FEAT-061 §5.3, D5): the selected contacts
 * with their identities, consents and leads, every message of their conversations and the
 * ticked mentions in order, attachments listed (not bundled), approvals and the ticked KB
 * items. `audit_pii` is left out: it only copies values held here (D5). Audited `dsr.exported`.
 */
export async function exportSubject(
  tx: Tx,
  tenantId: string,
  userId: string,
  requestId: string,
  version: number,
  sel: DsrSelection,
  now = new Date(),
): Promise<{ file: DsrExport; fileName: string; request: DsrRow }> {
  const req = await requireVerified(tx, tenantId, requestId);
  if (req.version !== version) throw new DsrError('state_changed');
  if (req.type === 'correction') throw new DsrError('wrong_type');
  const found = await findSubject(tx, tenantId, identifiersOf(req));
  checkSelection(found, sel, { atLeastOne: true });
  const { contactIds, conversationIds } = await scopeOf(tx, tenantId, found, sel);

  const [{ n } = { n: 0 }] = conversationIds.length
    ? await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(eq(messages.tenantId, tenantId), inArray(messages.conversationId, conversationIds)),
        )
    : [];
  if (n > DSR_EXPORT_MAX_MESSAGES) throw new DsrError('too_large');

  const byContact = contactIds.length > 0;
  const [cs, idents, cons, ls, convs, msgs, atts, apprs, fs, staged] = await Promise.all([
    byContact
      ? tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds)))
      : [],
    byContact
      ? tx
          .select()
          .from(contactIdentities)
          .where(
            and(
              eq(contactIdentities.tenantId, tenantId),
              inArray(contactIdentities.contactId, contactIds),
            ),
          )
      : [],
    byContact || conversationIds.length
      ? tx
          .select()
          .from(consents)
          .where(
            and(
              eq(consents.tenantId, tenantId),
              or(
                byContact ? inArray(consents.contactId, contactIds) : sql`false`,
                conversationIds.length
                  ? inArray(consents.conversationId, conversationIds)
                  : sql`false`,
              ),
            ),
          )
          .orderBy(asc(consents.createdAt))
      : [],
    byContact
      ? tx
          .select()
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), inArray(leads.contactId, contactIds)))
      : [],
    conversationIds.length
      ? tx
          .select()
          .from(conversations)
          .where(
            and(eq(conversations.tenantId, tenantId), inArray(conversations.id, conversationIds)),
          )
          .orderBy(asc(conversations.createdAt))
      : [],
    conversationIds.length
      ? tx
          .select({
            conversationId: messages.conversationId,
            at: messages.createdAt,
            author: messages.author,
            body: messages.body,
          })
          .from(messages)
          .where(
            and(eq(messages.tenantId, tenantId), inArray(messages.conversationId, conversationIds)),
          )
          .orderBy(asc(messages.seq))
      : [],
    conversationIds.length
      ? tx
          .select()
          .from(emailAttachments)
          .where(
            and(
              eq(emailAttachments.tenantId, tenantId),
              inArray(emailAttachments.conversationId, conversationIds),
            ),
          )
      : [],
    conversationIds.length
      ? tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.tenantId, tenantId),
              inArray(approvals.conversationId, conversationIds),
            ),
          )
      : [],
    sel.factIds.length
      ? tx
          .select({ id: facts.id, value: facts.value })
          .from(facts)
          .where(and(eq(facts.tenantId, tenantId), inArray(facts.id, sel.factIds)))
      : [],
    sel.stagedFactIds.length
      ? tx
          .select({ id: kbStagedFacts.id, value: kbStagedFacts.value })
          .from(kbStagedFacts)
          .where(
            and(eq(kbStagedFacts.tenantId, tenantId), inArray(kbStagedFacts.id, sel.stagedFactIds)),
          )
      : [],
  ]);

  const file: DsrExport = {
    request: { ref: dsrRef(req.id), type: req.type, receivedOn: req.receivedOn },
    exportedAt: now.toISOString(),
    contacts: cs.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      telegramId: c.telegramId !== null ? String(c.telegramId) : null,
      telegramUsername: c.telegramUsername,
      createdAt: isoOf(c.createdAt),
    })),
    identities: idents.map((i) => ({
      contactId: i.contactId,
      kind: i.kind,
      value: i.value,
      verified: i.verifiedAt !== null,
    })),
    consents: cons.map((c) => ({
      contactId: c.contactId,
      purpose: c.purpose,
      decision: c.decision,
      at: isoOf(c.createdAt),
    })),
    leads: ls.map((l) => ({
      contactId: l.contactId,
      status: l.status,
      need: l.need,
      budget: l.budget,
      preferredTime: l.preferredTime,
      createdAt: isoOf(l.createdAt),
    })),
    conversations: convs.map((c) => ({
      id: c.id,
      channel: c.channel,
      startedAt: isoOf(c.createdAt),
      messages: msgs
        .filter((m) => m.conversationId === c.id)
        .map((m) => ({ at: isoOf(m.at), author: m.author, body: m.body })),
    })),
    attachments: atts.map((a) => ({
      name: a.name,
      size: a.size,
      contentType: a.contentType,
      receivedAt: isoOf(a.createdAt),
    })),
    approvals: apprs.map((a) => ({
      conversationId: a.conversationId,
      kind: a.kind,
      status: a.status,
      at: isoOf(a.createdAt),
    })),
    kb: [
      ...fs.map((f) => ({ kind: 'fact' as const, id: f.id, value: f.value })),
      ...staged.map((f) => ({ kind: 'staged' as const, id: f.id, value: f.value })),
    ],
  };
  await auditDsr(tx, tenantId, {
    event: 'exported',
    requestId,
    actor: { type: 'user', id: userId },
    payload: { contacts: cs.length, conversations: convs.length, messages: msgs.length },
  });
  return {
    file,
    fileName: `data-request-${dsrRef(req.id)}-${sgToday(now)}.json`,
    request: req,
  };
}
