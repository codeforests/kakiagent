import type {
  LeadConsentRecord,
  LeadConversation,
  LeadDetail,
  LeadList,
  LeadRow,
  LeadScore,
  LeadScoring,
  LeadsQuery,
  LeadStatus,
  LeadStatusFilter,
  ScoreReason,
} from '@kaki/contracts';
import { formatSgPhone } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';

type SQL = ReturnType<typeof sql>;
import { InvalidLeadCursor, LeadNotFound } from './errors.js';

/** One lead as the list, the status route and the export read it (FEAT-050 §5.3). */
export interface LeadDbRow extends Record<string, unknown> {
  id: string;
  version: number;
  status: LeadStatus;
  name: string | null;
  email: string | null;
  phone: string | null;
  need: string | null;
  budget: string | null;
  preferred_time: string | null;
  captures: number;
  contact_id: string;
  conversation_id: string | null;
  score: LeadScore | null;
  score_points: number | null;
  score_reasons: ScoreReason[] | null;
  scored_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  /** `updated_at::text`, full precision, for the keyset cursor. */
  updated_key: string;
  enquiry_at: Date | string;
  marketing_agreed: boolean | null;
  marketing_at: Date | string | null;
}

export const iso = (d: Date | string) => new Date(d).toISOString();

/** The columns every lead query selects, with the enquiry consent and the latest marketing answer. */
export const leadSelect = (tenantId: string, where: SQL, tail: SQL = sql``) => sql`
  select l.id, l.version, l.status, k.name, k.email, k.phone, l.need, l.budget, l.preferred_time,
    l.captures, l.contact_id, l.conversation_id, l.score, l.score_points, l.score_reasons,
    l.scored_at, l.created_at, l.updated_at, l.updated_at::text as updated_key,
    e.created_at as enquiry_at,
    m.decision = 'agreed' as marketing_agreed, m.created_at as marketing_at
  from leads l
  join contacts k on k.tenant_id = l.tenant_id and k.id = l.contact_id
  join consents e on e.tenant_id = l.tenant_id and e.id = l.consent_id
  left join lateral (
    select decision, created_at from consents
    where tenant_id = l.tenant_id and contact_id = l.contact_id and purpose = 'marketing'
    order by created_at desc limit 1
  ) m on true
  where l.tenant_id = ${tenantId} and ${where} ${tail}`;

export const scoringOf = (r: {
  score: LeadScore | null;
  score_points: number | null;
  score_reasons: ScoreReason[] | null;
  scored_at: Date | string | null;
}): LeadScoring =>
  r.score !== null && r.score_points !== null && r.score_reasons && r.scored_at !== null
    ? { score: r.score, points: r.score_points, reasons: r.score_reasons, at: iso(r.scored_at) }
    : null;

export const marketingOf = (r: LeadDbRow) =>
  r.marketing_at !== null ? { agreed: !!r.marketing_agreed, at: iso(r.marketing_at) } : null;

export function toLeadRow(r: LeadDbRow, needMax: number | null = 120): LeadRow {
  return {
    id: r.id,
    version: r.version,
    name: r.name,
    email: r.email,
    phone: r.phone ? formatSgPhone(r.phone) : null,
    need: r.need !== null && needMax !== null ? r.need.slice(0, needMax) : r.need,
    status: r.status,
    scoring: scoringOf(r),
    source: r.conversation_id ? 'chat' : 'contact_form',
    marketing: marketingOf(r),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** The SQL condition of a status tab and score filter. */
export function leadFilter(f: { status: LeadStatusFilter; score?: LeadScore | undefined }): SQL {
  const status =
    f.status === 'all'
      ? sql`true`
      : f.status === 'open'
        ? sql`l.status in ('new', 'contacted')`
        : sql`l.status = ${f.status}`;
  return f.score ? sql`${status} and l.score = ${f.score}` : status;
}

const encodeCursor = (r: LeadDbRow) =>
  Buffer.from(JSON.stringify([r.updated_key, r.id])).toString('base64url');

function decodeCursor(c: string): { at: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'string' &&
      !Number.isNaN(Date.parse(v[0])) &&
      /^[0-9a-f-]{36}$/i.test(v[1])
    )
      return { at: v[0], id: v[1] };
  } catch {
    // fall through
  }
  throw new InvalidLeadCursor('bad cursor');
}

/** `GET /api/v1/leads` (SCR-APP-032): newest `updated_at` first, keyset paged, counts by status. */
export async function listLeads(tx: Tx, tenantId: string, q: LeadsQuery): Promise<LeadList> {
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const where = after
    ? sql`${leadFilter(q)} and (l.updated_at, l.id) < (${after.at}::timestamptz, ${after.id}::uuid)`
    : leadFilter(q);
  const { rows } = await tx.execute<LeadDbRow>(
    leadSelect(tenantId, where, sql`order by l.updated_at desc, l.id desc limit ${q.limit + 1}`),
  );
  const page = rows.slice(0, q.limit);
  const counts = await tx.execute<{ status: LeadStatus; n: number }>(
    sql`select status, count(*)::int as n from leads where tenant_id = ${tenantId} group by status`,
  );
  const byStatus: Record<LeadStatus, number> = { new: 0, contacted: 0, won: 0, lost: 0 };
  for (const c of counts.rows) byStatus[c.status] = c.n;
  return {
    items: page.map((r) => toLeadRow(r)),
    nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null,
    counts: byStatus,
  };
}

/** One lead's row as the list shows it, or null. */
export async function leadRowOf(tx: Tx, tenantId: string, id: string): Promise<LeadRow | null> {
  const { rows } = await tx.execute<LeadDbRow>(leadSelect(tenantId, sql`l.id = ${id}`));
  return rows[0] ? toLeadRow(rows[0]) : null;
}

type LocalText = { en?: unknown; zh?: unknown };
const textOf = (content: Record<string, unknown>, kind: string, language: 'en' | 'zh') => {
  const t = (kind === 'marketing_consent' ? content['text'] : (content['purpose'] ?? content)) as
    LocalText | undefined;
  const en = typeof t?.en === 'string' ? t.en : '';
  const zh = typeof t?.zh === 'string' && t.zh ? t.zh : null;
  return language === 'zh' && zh ? zh : en;
};

/**
 * `GET /api/v1/leads/:id` (SCR-APP-033; AC-2, AC-8): the full lead, every consent of the contact
 * with the exact wording in the language it was shown (the conversation's, the form's `en`),
 * and the contact's latest 20 conversations.
 */
export async function leadDetail(
  tx: Tx,
  tenantId: string,
  id: string,
  rights: { canManage: boolean; canExport: boolean },
): Promise<LeadDetail> {
  const { rows } = await tx.execute<LeadDbRow>(leadSelect(tenantId, sql`l.id = ${id}`));
  const r = rows[0];
  if (!r) throw new LeadNotFound('no such lead');
  const consents = await tx.execute<{
    id: string;
    purpose: 'enquiry' | 'marketing';
    decision: 'agreed' | 'declined';
    created_at: Date | string;
    channel: 'widget';
    conversation_id: string | null;
    wording_id: string;
    seq: number;
    kind: string;
    content: Record<string, unknown>;
    language: 'en' | 'zh' | null;
  }>(sql`
    select c.id, c.purpose, c.decision, c.created_at, c.channel, c.conversation_id, c.wording_id,
      w.seq, w.kind, w.content,
      (select m.language from messages m
        where m.tenant_id = c.tenant_id and m.conversation_id = c.conversation_id
          and m.author in ('agent', 'system') and m.language is not null
          and m.created_at <= c.created_at + interval '1 minute'
        order by m.seq desc limit 1) as language
    from consents c
    join wording_versions w on w.tenant_id = c.tenant_id and w.id = c.wording_id
    where c.tenant_id = ${tenantId} and c.contact_id = ${r.contact_id}
    order by c.created_at desc, c.id`);
  const convs = await tx.execute<{
    id: string;
    status: LeadConversation['status'];
    created_at: Date | string;
    last_message_at: Date | string;
  }>(sql`
    select id, status, created_at, last_message_at from conversations
    where tenant_id = ${tenantId} and contact_id = ${r.contact_id}
    order by created_at desc limit 20`);
  return {
    ...toLeadRow(r, null),
    budget: r.budget,
    preferredTime: r.preferred_time,
    captures: r.captures,
    contactId: r.contact_id,
    consents: consents.rows.map((c): LeadConsentRecord => ({
      id: c.id,
      purpose: c.purpose,
      decision: c.decision,
      at: iso(c.created_at),
      channel: c.channel,
      conversationId: c.conversation_id,
      wording: {
        id: c.wording_id,
        version: c.seq,
        text: textOf(c.content, c.kind, c.language ?? 'en'),
      },
    })),
    conversations: convs.rows.map((c) => ({
      id: c.id,
      status: c.status,
      startedAt: iso(c.created_at),
      lastMessageAt: iso(c.last_message_at),
    })),
    ...rights,
  };
}
