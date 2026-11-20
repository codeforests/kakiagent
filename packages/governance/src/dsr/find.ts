import type { DsrFindResult, DsrSelection } from '@kaki/contracts';
import { and, eq, inArray, or, schema, sql, type Tx } from '@kaki/db';
import { DsrError, isoOf, type DsrRow } from './requests.js';
import { maskEmailValue, maskPhoneValue, maskTelegramValue } from './due.js';

const {
  approvals,
  auditPii,
  consents,
  contactIdentities,
  contacts,
  conversationSummaries,
  conversations,
  emailAttachments,
  escalations,
  facts,
  kbSources,
  kbStagedFacts,
  leads,
  messages,
  suggestions,
  telegramChats,
  visitorEvents,
} = schema;

export interface Identifiers {
  email?: string | undefined;
  phone?: string | undefined;
  telegramId?: string | undefined;
}

export const identifiersOf = (row: DsrRow): Identifiers => ({
  ...(row.requesterEmail ? { email: row.requesterEmail } : {}),
  ...(row.requesterPhone ? { phone: row.requesterPhone } : {}),
  ...(row.requesterTelegramId ? { telegramId: row.requesterTelegramId } : {}),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Text forms an identifier is searched in (≥ 5 characters, D10): the email, the phone as
 * stored and as people type it, the Telegram ID.
 */
export function mentionPatterns(ids: Identifiers): string[] {
  const forms: string[] = [];
  if (ids.email) forms.push(ids.email);
  if (ids.phone) {
    const local = ids.phone.replace(/^\+65/, '');
    forms.push(ids.phone, local, `${local.slice(0, 4)} ${local.slice(4)}`);
  }
  if (ids.telegramId) forms.push(ids.telegramId);
  return [...new Set(forms.filter((f) => f.length >= 5))].map((f) => `%${escapeLike(f)}%`);
}

/** The ID with every identifier masked, at most 160 characters around the first hit. */
export function excerptOf(text: string, ids: Identifiers): string {
  const values = [
    ids.email && { v: ids.email, m: maskEmailValue(ids.email) },
    ids.phone && { v: ids.phone, m: maskPhoneValue(ids.phone) },
    ids.phone && {
      v: ids.phone.replace(/^\+65/, ''),
      m: maskPhoneValue(ids.phone).replace('+65 ', ''),
    },
    ids.telegramId && { v: ids.telegramId, m: maskTelegramValue(ids.telegramId) },
  ].filter((x): x is { v: string; m: string } => !!x);
  const lower = text.toLowerCase();
  const at = Math.min(
    ...values.map((x) => lower.indexOf(x.v.toLowerCase())).filter((i) => i >= 0),
    text.length,
  );
  let out = text.slice(Math.max(0, at - 60), at + 100);
  for (const x of values)
    out = out.replace(new RegExp(x.v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), x.m);
  return out.slice(0, 160);
}

function factTitle(type: string, value: unknown): string {
  const v = (value ?? {}) as Record<string, unknown>;
  for (const k of ['name', 'question', 'title', 'topic'])
    if (typeof v[k] === 'string' && v[k]) return String(v[k]).slice(0, 120);
  return type;
}

/** Contact IDs and every contact merged into them, at any depth. */
async function withMerged(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const rootOf = new Map(ids.map((id) => [id, id]));
  let frontier = ids;
  while (frontier.length) {
    const rows = await tx
      .select({ id: contacts.id, into: contacts.mergedInto })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.mergedInto, frontier)));
    frontier = [];
    for (const r of rows)
      if (!rootOf.has(r.id)) {
        rootOf.set(r.id, rootOf.get(r.into!)!);
        frontier.push(r.id);
      }
  }
  return rootOf;
}

/** The survivor a merged contact ended up in. */
async function survivorsOf(tx: Tx, tenantId: string, ids: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const start of ids) {
    let id = start;
    for (let i = 0; i < 20; i++) {
      const [row] = await tx
        .select({ into: contacts.mergedInto })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, id)));
      if (!row?.into) break;
      id = row.into;
    }
    out.add(id);
  }
  return [...out];
}

export interface FoundSubject {
  result: DsrFindResult;
  /** Every contact a deletion would remove (listed contacts and those merged into them). */
  contactIds: Set<string>;
  /** Listed conversations: the contacts' and the mentions. */
  conversationIds: Set<string>;
  factIds: Set<string>;
  stagedIds: Set<string>;
}

/**
 * Everything the tenant holds for the requester (GOV-05 find; FEAT-061 §5.2, AC-3): exact
 * identifier matches for contacts, their conversations whole, and conversations or KB items
 * whose text mentions an identifier (listed, opt-in, D10). Read-only, dashboard zone.
 */
export async function findSubject(
  tx: Tx,
  tenantId: string,
  ids: Identifiers,
): Promise<FoundSubject> {
  const identityMatches = [
    ids.email && and(eq(contactIdentities.kind, 'email'), eq(contactIdentities.value, ids.email)),
    ids.phone && and(eq(contactIdentities.kind, 'phone'), eq(contactIdentities.value, ids.phone)),
    ids.telegramId &&
      and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.value, ids.telegramId)),
  ].filter((x) => !!x);
  const contactMatches = [
    ids.email && eq(contacts.email, ids.email),
    ids.phone && eq(contacts.phone, ids.phone),
    ids.telegramId && sql`${contacts.telegramId} = ${ids.telegramId}::bigint`,
  ].filter((x) => !!x);
  const matched = new Set<string>();
  if (identityMatches.length) {
    const rows = await tx
      .select({ id: contactIdentities.contactId })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.tenantId, tenantId), or(...identityMatches)));
    for (const r of rows) matched.add(r.id);
  }
  if (contactMatches.length) {
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), or(...contactMatches)));
    for (const r of rows) matched.add(r.id);
  }
  const roots = await survivorsOf(tx, tenantId, [...matched]);
  const rootOf = await withMerged(tx, tenantId, roots);
  const all = [...rootOf.keys()];

  const perRoot = (rows: { contactId: string | null }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const root = r.contactId ? rootOf.get(r.contactId) : undefined;
      if (root) m.set(root, (m.get(root) ?? 0) + 1);
    }
    return m;
  };

  const none = all.length === 0;
  const [contactRows, identRows, leadRows, consentRows, auditRows, convRows] = none
    ? [[], [], [], [], [], []]
    : await Promise.all([
        tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, roots))),
        tx
          .select({ contactId: contactIdentities.contactId })
          .from(contactIdentities)
          .where(
            and(
              eq(contactIdentities.tenantId, tenantId),
              inArray(contactIdentities.contactId, all),
            ),
          ),
        tx
          .select({
            id: leads.id,
            contactId: leads.contactId,
            status: leads.status,
            need: leads.need,
            budget: leads.budget,
            preferredTime: leads.preferredTime,
          })
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), inArray(leads.contactId, all))),
        tx
          .select({ contactId: consents.contactId })
          .from(consents)
          .where(and(eq(consents.tenantId, tenantId), inArray(consents.contactId, all))),
        tx
          .select({ contactId: auditPii.contactId })
          .from(auditPii)
          .where(and(eq(auditPii.tenantId, tenantId), inArray(auditPii.contactId, all))),
        tx
          .select({ id: conversations.id, contactId: conversations.contactId })
          .from(conversations)
          .where(and(eq(conversations.tenantId, tenantId), inArray(conversations.contactId, all))),
      ]);

  // Mentions: conversations and KB items whose text holds an identifier.
  const patterns = mentionPatterns(ids);
  const hits = patterns.length
    ? (
        await tx.execute<{ kind: string; id: string }>(
          sql`select kind, id from dsr_search_hits(array[${sql.join(
            patterns.map((p) => sql`${p}`),
            sql`, `,
          )}]::text[])`,
        )
      ).rows
    : [];
  const contactConvs = new Set(convRows.map((c) => c.id));
  const mentionConvs = hits
    .filter((h) => h.kind === 'conversation' && !contactConvs.has(h.id))
    .map((h) => h.id);
  const factHits = hits.filter((h) => h.kind === 'fact').map((h) => h.id);
  const stagedHits = hits.filter((h) => h.kind === 'staged').map((h) => h.id);
  const convIds = [...contactConvs, ...mentionConvs];

  const [convs, msgCounts, attachments, kbFacts, kbStaged] = await Promise.all([
    convIds.length
      ? tx
          .select()
          .from(conversations)
          .where(and(eq(conversations.tenantId, tenantId), inArray(conversations.id, convIds)))
      : [],
    convIds.length
      ? tx
          .select({ id: messages.conversationId, n: sql<number>`count(*)::int` })
          .from(messages)
          .where(and(eq(messages.tenantId, tenantId), inArray(messages.conversationId, convIds)))
          .groupBy(messages.conversationId)
      : [],
    convIds.length
      ? tx
          .select()
          .from(emailAttachments)
          .where(
            and(
              eq(emailAttachments.tenantId, tenantId),
              inArray(emailAttachments.conversationId, convIds),
            ),
          )
      : [],
    factHits.length
      ? tx
          .select({
            id: facts.id,
            type: facts.type,
            value: facts.value,
            sourceName: kbSources.name,
          })
          .from(facts)
          .leftJoin(
            kbSources,
            and(eq(kbSources.tenantId, facts.tenantId), eq(kbSources.id, facts.sourceId)),
          )
          .where(and(eq(facts.tenantId, tenantId), inArray(facts.id, factHits)))
      : [],
    stagedHits.length
      ? tx
          .select({
            id: kbStagedFacts.id,
            type: kbStagedFacts.type,
            value: kbStagedFacts.value,
            quote: kbStagedFacts.quote,
            sourceName: kbSources.name,
          })
          .from(kbStagedFacts)
          .leftJoin(
            kbSources,
            and(
              eq(kbSources.tenantId, kbStagedFacts.tenantId),
              eq(kbSources.id, kbStagedFacts.sourceId),
            ),
          )
          .where(and(eq(kbStagedFacts.tenantId, tenantId), inArray(kbStagedFacts.id, stagedHits)))
      : [],
  ]);

  const contactConvIds = [...contactConvs];
  const visitorIds = [
    ...new Set(convs.filter((c) => contactConvs.has(c.id)).map((c) => c.visitorId)),
  ];
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const n = sql<number>`count(*)::int`;
  const other = contactConvIds.length
    ? {
        approvals: await count(
          tx
            .select({ n })
            .from(approvals)
            .where(
              and(
                eq(approvals.tenantId, tenantId),
                inArray(approvals.conversationId, contactConvIds),
              ),
            ),
        ),
        escalations: await count(
          tx
            .select({ n })
            .from(escalations)
            .where(
              and(
                eq(escalations.tenantId, tenantId),
                inArray(escalations.conversationId, contactConvIds),
              ),
            ),
        ),
        suggestions: await count(
          tx
            .select({ n })
            .from(suggestions)
            .where(
              and(
                eq(suggestions.tenantId, tenantId),
                inArray(suggestions.conversationId, contactConvIds),
              ),
            ),
        ),
        summaries: await count(
          tx
            .select({ n })
            .from(conversationSummaries)
            .where(
              and(
                eq(conversationSummaries.tenantId, tenantId),
                inArray(conversationSummaries.conversationId, contactConvIds),
              ),
            ),
        ),
        trackingEvents: visitorIds.length
          ? await count(
              tx
                .select({ n })
                .from(visitorEvents)
                .where(
                  and(
                    eq(visitorEvents.tenantId, tenantId),
                    inArray(visitorEvents.visitorId, visitorIds),
                  ),
                ),
            )
          : 0,
        telegramChats: await count(
          tx
            .select({ n })
            .from(telegramChats)
            .where(
              and(eq(telegramChats.tenantId, tenantId), inArray(telegramChats.contactId, all)),
            ),
        ),
      }
    : {
        approvals: 0,
        escalations: 0,
        suggestions: 0,
        summaries: 0,
        trackingEvents: 0,
        telegramChats: all.length
          ? await count(
              tx
                .select({ n })
                .from(telegramChats)
                .where(
                  and(eq(telegramChats.tenantId, tenantId), inArray(telegramChats.contactId, all)),
                ),
            )
          : 0,
      };

  const msgs = new Map(msgCounts.map((m) => [m.id, m.n]));
  const atts = new Map<string, number>();
  for (const a of attachments) atts.set(a.conversationId, (atts.get(a.conversationId) ?? 0) + 1);
  const identities = perRoot(identRows);
  const consentN = perRoot(consentRows);
  const auditN = perRoot(auditRows);
  const convN = perRoot(convRows);
  const mergedN = new Map<string, number>();
  for (const [id, root] of rootOf) if (id !== root) mergedN.set(root, (mergedN.get(root) ?? 0) + 1);

  const result: DsrFindResult = {
    searchedFor: { ...ids },
    contacts: contactRows.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      telegram: c.telegramId !== null ? String(c.telegramId) : null,
      mergedFrom: mergedN.get(c.id) ?? 0,
      identities: identities.get(c.id) ?? 0,
      leads: leadRows
        .filter((l) => rootOf.get(l.contactId) === c.id)
        .map((l) => ({
          id: l.id,
          status: l.status,
          need: l.need,
          budget: l.budget,
          preferredTime: l.preferredTime,
        })),
      consents: consentN.get(c.id) ?? 0,
      conversations: convN.get(c.id) ?? 0,
      auditPii: auditN.get(c.id) ?? 0,
    })),
    conversations: convs
      .map((c) => ({
        id: c.id,
        channel: c.channel,
        startedAt: isoOf(c.createdAt),
        lastMessageAt: isoOf(c.lastMessageAt),
        messages: msgs.get(c.id) ?? 0,
        attachments: atts.get(c.id) ?? 0,
        contactId: c.contactId ? (rootOf.get(c.contactId) ?? c.contactId) : null,
        match: contactConvs.has(c.id) ? ('contact' as const) : ('mention' as const),
      }))
      .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1)),
    attachments: attachments.map((a) => ({
      id: a.id,
      conversationId: a.conversationId,
      name: a.name,
      size: a.size,
      contentType: a.contentType,
      status: a.status,
    })),
    kb: [
      ...kbFacts.map((f) => ({
        kind: 'fact' as const,
        id: f.id,
        title: factTitle(f.type, f.value),
        excerpt: excerptOf(JSON.stringify(f.value), ids),
        sourceName: f.sourceName ?? null,
      })),
      ...kbStaged.map((f) => ({
        kind: 'staged' as const,
        id: f.id,
        title: factTitle(f.type, f.value),
        excerpt: excerptOf(`${f.quote} ${JSON.stringify(f.value)}`, ids),
        sourceName: f.sourceName ?? null,
      })),
    ],
    other,
  };
  return {
    result,
    contactIds: new Set(all),
    conversationIds: new Set(convIds),
    factIds: new Set(factHits),
    stagedIds: new Set(stagedHits),
  };
}

/** The selection must come from this find result (D10); otherwise 422 `not_in_result`. */
export function checkSelection(
  found: FoundSubject,
  sel: DsrSelection,
  opts: { atLeastOne: boolean },
) {
  const listed = new Set(found.result.contacts.map((c) => c.id));
  const bad =
    sel.contactIds.some((id) => !listed.has(id)) ||
    sel.conversationIds.some((id) => !found.conversationIds.has(id)) ||
    sel.factIds.some((id) => !found.factIds.has(id)) ||
    sel.stagedFactIds.some((id) => !found.stagedIds.has(id));
  if (bad) throw new DsrError('not_in_result');
  const n =
    sel.contactIds.length +
    sel.conversationIds.length +
    sel.factIds.length +
    sel.stagedFactIds.length;
  if (opts.atLeastOne && n === 0) throw new DsrError('nothing_selected');
}
