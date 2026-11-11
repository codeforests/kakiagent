import type {
  ContactConversation,
  ContactDetail,
  ContactDuplicate,
  ContactIdentity,
  ContactMergeEntry,
  ContactSearchResponse,
} from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import type { IdentityKind } from './identity.js';

/**
 * The Contact page's reads (SCR-APP-016; FEAT-039 §5.2, §5.4), dashboard zone. Leads and
 * consent records come from `@kaki/leads` (`contactLeads`); the api composes the two.
 */
export type ChannelContactDetail = Omit<ContactDetail, 'leads' | 'consents' | 'canMerge'>;
export type MemberNames = (ids: string[]) => Promise<Map<string, string>>;

const iso = (d: Date | string) => new Date(d).toISOString();
const phone = (p: string) => `+65 ${p.slice(3, 7)} ${p.slice(7)}`;

interface ContactRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  telegram_username: string | null;
  telegram_id: string | null;
  merged_into: string | null;
  created_at: Date | string;
}

/** The name staff know a contact by: name, email, phone, Telegram username, else the channel. */
export function contactLabel(k: {
  name: string | null;
  email: string | null;
  phone: string | null;
  telegram_username: string | null;
  telegram_id?: string | null;
}): string {
  return (
    k.name ??
    k.email ??
    (k.phone ? phone(k.phone) : null) ??
    (k.telegram_username ? `@${k.telegram_username}` : null) ??
    (k.telegram_id ? 'Telegram account' : 'Website visitor')
  );
}

/** An identifier as staff read it: phones spaced, Telegram as `@user` or "Telegram account". */
export function shownValue(
  kind: IdentityKind,
  value: string,
  telegramUsername: string | null,
): string {
  if (kind === 'phone') return phone(value);
  if (kind === 'telegram') return telegramUsername ? `@${telegramUsername}` : 'Telegram account';
  return value;
}

const contactSelect = sql`k.id, k.name, k.email, k.phone, k.telegram_username,
  k.telegram_id::text as telegram_id, k.merged_into, k.created_at`;

async function contactRow(tx: Tx, tenantId: string, id: string): Promise<ContactRow | null> {
  const { rows } = await tx.execute<ContactRow>(
    sql`select ${contactSelect} from contacts k where k.tenant_id = ${tenantId} and k.id = ${id}`,
  );
  return rows[0] ?? null;
}

/** A contact's identifiers, oldest first; one row per (kind, value), verified if any is. */
export async function identitiesOf(
  tx: Tx,
  tenantId: string,
  contactId: string,
): Promise<ContactIdentity[]> {
  const { rows } = await tx.execute<{
    id: string;
    kind: IdentityKind;
    value: string;
    source: ContactIdentity['source'];
    verified: boolean;
    created_at: Date | string;
    telegram_username: string | null;
  }>(sql`
    select distinct on (i.kind, i.value) i.id, i.kind, i.value, i.source,
      i.verified_at is not null as verified, i.created_at, k.telegram_username
    from contact_identities i
    join contacts k on k.tenant_id = i.tenant_id and k.id = i.contact_id
    where i.tenant_id = ${tenantId} and i.contact_id = ${contactId}
    order by i.kind, i.value, (i.verified_at is not null) desc, i.created_at`);
  return rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      value: shownValue(r.kind, r.value, r.telegram_username),
      verified: r.verified,
      source: r.source,
      firstSeenAt: iso(r.created_at),
    }))
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

const duplicatesQuery = (tenantId: string, contactId: string) => sql`
  select ${contactSelect},
    array_agg(distinct o.kind || ':' || o.value) as shared
  from contact_identities m
  join contact_identities o on o.tenant_id = m.tenant_id and o.kind = m.kind
    and o.value = m.value and o.contact_id <> m.contact_id
  join contacts k on k.tenant_id = o.tenant_id and k.id = o.contact_id and k.merged_into is null
  where m.tenant_id = ${tenantId} and m.contact_id = ${contactId}
  group by k.id, k.tenant_id
  order by k.created_at desc
  limit 5`;

/**
 * Other active contacts sharing any identifier with this one, verified or not (§5.2), newest
 * first, at most 5, with the shared values. A suggestion for staff: nothing is merged (D1).
 */
export async function duplicatesOf(
  tx: Tx,
  tenantId: string,
  contactId: string,
): Promise<ContactDuplicate[]> {
  const { rows } = await tx.execute<ContactRow & { shared: string[] }>(
    duplicatesQuery(tenantId, contactId),
  );
  return rows.map((r) => ({
    contactId: r.id,
    label: contactLabel(r),
    shared: r.shared.slice(0, 5).map((s) => {
      const at = s.indexOf(':');
      const kind = s.slice(0, at) as IdentityKind;
      return { kind, value: shownValue(kind, s.slice(at + 1), r.telegram_username) };
    }),
  }));
}

/** The sidebar's duplicate hint (§5.4): the same query's count, capped at 5. */
export async function duplicateCount(tx: Tx, tenantId: string, contactId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from (${duplicatesQuery(tenantId, contactId)}) d`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * `GET /api/v1/contacts/:id`'s channel half (§5.4): identifiers, conversations with their
 * channel, duplicates and the merges into this contact. A merged-away contact answers only
 * `mergedInto`, with empty lists. Null for an unknown (or another tenant's) contact.
 */
export async function contactDetail(
  tx: Tx,
  tenantId: string,
  contactId: string,
  names?: MemberNames,
): Promise<ChannelContactDetail | null> {
  const k = await contactRow(tx, tenantId, contactId);
  if (!k) return null;
  const base = { id: k.id, label: contactLabel(k), name: k.name, firstSeenAt: iso(k.created_at) };
  if (k.merged_into) {
    const survivor = (await contactRow(tx, tenantId, k.merged_into))!;
    const { rows } = await tx.execute<{ id: string }>(sql`
      select id from contact_merges
      where tenant_id = ${tenantId} and merged_id = ${contactId} and undone_at is null
      order by created_at desc limit 1`);
    return {
      ...base,
      mergedInto: { contactId: survivor.id, label: contactLabel(survivor), mergeId: rows[0]!.id },
      identities: [],
      conversations: [],
      conversationCount: 0,
      duplicates: [],
      merges: [],
    };
  }
  const convs = await tx.execute<{
    id: string;
    status: ContactConversation['status'];
    channel: ContactConversation['channel'];
    created_at: Date | string;
    last_message_at: Date | string;
    total: number;
  }>(sql`
    select id, status, channel, created_at, last_message_at, count(*) over ()::int as total
    from conversations where tenant_id = ${tenantId} and contact_id = ${contactId}
    order by created_at desc limit 20`);
  const merges = await tx.execute<
    ContactRow & {
      merge_id: string;
      at: Date | string;
      automatic: boolean;
      by_user_id: string | null;
      undone_at: Date | string | null;
    }
  >(sql`
    select m.id as merge_id, m.created_at as at, m.automatic, m.by_user_id, m.undone_at,
      ${contactSelect}
    from contact_merges m
    join contacts k on k.tenant_id = m.tenant_id and k.id = m.merged_id
    where m.tenant_id = ${tenantId} and m.survivor_id = ${contactId}
    order by m.created_at desc`);
  const userIds = [...new Set(merges.rows.flatMap((m) => (m.by_user_id ? [m.by_user_id] : [])))];
  const named = userIds.length && names ? await names(userIds) : new Map<string, string>();
  return {
    ...base,
    mergedInto: null,
    identities: await identitiesOf(tx, tenantId, contactId),
    conversations: convs.rows.map((c) => ({
      id: c.id,
      status: c.status,
      channel: c.channel,
      startedAt: iso(c.created_at),
      lastMessageAt: iso(c.last_message_at),
    })),
    conversationCount: convs.rows[0]?.total ?? 0,
    duplicates: await duplicatesOf(tx, tenantId, contactId),
    merges: merges.rows.map((m): ContactMergeEntry => ({
      mergeId: m.merge_id,
      otherContactId: m.id,
      otherLabel: contactLabel(m),
      at: iso(m.at),
      automatic: m.automatic,
      by: m.by_user_id ? (named.get(m.by_user_id) ?? 'A team member') : null,
      undoneAt: m.undone_at ? iso(m.undone_at) : null,
      // This contact is active here, so the survivor-merged block can't apply.
      canUndo: m.undone_at === null,
      undoBlocked: null,
    })),
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * `POST /api/v1/contacts/search` (§5.4, D9): active contacts whose name, email, phone or
 * Telegram username contains `q`, newest activity first, at most 10. A plain RLS `ILIKE`.
 */
export async function searchContacts(
  tx: Tx,
  tenantId: string,
  q: string,
  exclude?: string,
): Promise<ContactSearchResponse['contacts']> {
  const like = `%${escapeLike(q.trim())}%`;
  const digits = q.replace(/[\s()+-]/g, '');
  const phoneLike = /^[0-9]{2,}$/.test(digits) ? `%${digits}%` : null;
  const { rows } = await tx.execute<ContactRow & { last_seen_at: Date | string | null }>(sql`
    select ${contactSelect},
      (select max(c.last_message_at) from conversations c
        where c.tenant_id = k.tenant_id and c.contact_id = k.id) as last_seen_at
    from contacts k
    where k.tenant_id = ${tenantId} and k.merged_into is null
      ${exclude ? sql`and k.id <> ${exclude}` : sql``}
      and (k.name ilike ${like} or k.email ilike ${like} or k.telegram_username ilike ${like}
        or k.phone ilike ${like} ${phoneLike ? sql`or k.phone like ${phoneLike}` : sql``})
    order by last_seen_at desc nulls last, k.created_at desc
    limit 10`);
  return rows.map((r) => ({
    contactId: r.id,
    label: contactLabel(r),
    email: r.email,
    phone: r.phone ? phone(r.phone) : null,
    telegramUsername: r.telegram_username,
    lastSeenAt: r.last_seen_at ? iso(r.last_seen_at) : null,
  }));
}
