import type { LeadScore, Qualification } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import { audit, auditCode, auditId, visitorPrivacy } from '@kaki/governance';
import { notify } from '@kaki/platform/notifications';
import { INDUSTRY_TEMPLATES } from '@kaki/tenancy';
import { foldKeyword, scoreLead, type Scored } from './score.js';

/** The industry's default criteria (D2): F&B gets its template's keywords, others none. */
export function defaultQualification(industry: string | null | undefined): Qualification {
  const t = industry ? INDUSTRY_TEMPLATES[industry as keyof typeof INDUSTRY_TEMPLATES] : undefined;
  return { keywords: [...(t?.leadKeywords ?? [])], minBudget: null };
}

/** Keywords trimmed, NFKC, case-folded, unique, in order. */
export function normaliseQualification(q: Qualification): Qualification {
  const keywords = [...new Set(q.keywords.map(foldKeyword).filter((k) => k.length > 0))];
  return { keywords, minBudget: q.minBudget };
}

const asQualification = (raw: unknown): Qualification | null => {
  const v = raw as { keywords?: unknown; minBudget?: unknown } | null;
  if (!v || !Array.isArray(v.keywords)) return null;
  return {
    keywords: v.keywords.filter((k): k is string => typeof k === 'string'),
    minBudget: typeof v.minBudget === 'number' ? v.minBudget : null,
  };
};

/**
 * The criteria in force: the saved ones, else the industry default. Works in both zones: the
 * visitor zone learns the industry through `visitor_privacy()`, the dashboard passes it.
 */
export async function qualificationInForce(
  tx: Tx,
  tenantId: string,
  industry?: string | null,
): Promise<{ saved: boolean; qualification: Qualification }> {
  const { rows } = await tx.execute<{ qualification: unknown }>(
    sql`select qualification from lead_settings where tenant_id = ${tenantId}`,
  );
  const saved = rows[0] ? asQualification(rows[0].qualification) : null;
  if (saved) return { saved: true, qualification: saved };
  const ind = industry !== undefined ? industry : ((await visitorPrivacy(tx))?.industry ?? null);
  return { saved: false, qualification: defaultQualification(ind) };
}

interface Facts extends Record<string, unknown> {
  id: string;
  status: string;
  need: string | null;
  budget: string | null;
  preferred_time: string | null;
  captures: number;
  score: LeadScore | null;
  hot_alerted_at: Date | string | null;
  has_phone: boolean;
  has_email: boolean;
  wants_to_order: boolean;
  conversations: number;
}

/** What the score needs about one lead or every open lead of the tenant, in one query. */
const factsSql = (tenantId: string, where: ReturnType<typeof sql>) => sql`
  select l.id, l.status, l.need, l.budget, l.preferred_time, l.captures, l.score, l.hot_alerted_at,
    k.phone is not null as has_phone, k.email is not null as has_email,
    exists (
      select 1 from messages m
      join conversations c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
      where m.tenant_id = l.tenant_id and m.author = 'agent'
        and (c.contact_id = l.contact_id or c.id = l.conversation_id)
        and 'request_commitment' = any(m.task_kinds)
    ) as wants_to_order,
    (select count(*)::int from conversations c
      where c.tenant_id = l.tenant_id and c.contact_id = l.contact_id) as conversations
  from leads l
  join contacts k on k.tenant_id = l.tenant_id and k.id = l.contact_id
  where l.tenant_id = ${tenantId} and ${where}`;

const scoreOf = (f: Facts, q: Qualification): Scored =>
  scoreLead(
    {
      need: f.need,
      budget: f.budget,
      preferredTime: f.preferred_time,
      hasPhone: f.has_phone,
      hasEmail: f.has_email,
      wantsToOrder: f.wants_to_order,
      returning: f.captures > 1 || f.conversations > 1,
    },
    q,
  );

async function write(tx: Tx, tenantId: string, id: string, s: Scored) {
  await tx.execute(sql`
    update leads set score = ${s.score}, score_points = ${s.points},
      score_reasons = ${JSON.stringify(s.reasons)}::jsonb, scored_at = now()
    where tenant_id = ${tenantId} and id = ${id}`);
}

export interface Rescored extends Scored {
  previous: LeadScore | null;
  /** True when this call wrote the hot-lead alert. */
  alerted: boolean;
}

/**
 * Scores the lead just captured (visitor zone; FEAT-050 §5.2, D3). A lead that is now hot and
 * never alerted gets one `hot_lead` alert per active member, in this transaction, deduped on
 * the lead. A band change is audited with codes only (ADR-014).
 */
export async function rescoreOnCapture(
  tx: Tx,
  tenantId: string,
  leadId: string,
): Promise<Rescored> {
  const { rows } = await tx.execute<Facts>(factsSql(tenantId, sql`l.id = ${leadId}`));
  const f = rows[0];
  if (!f) throw new Error('leads: lead not found');
  const { qualification } = await qualificationInForce(tx, tenantId);
  const s = scoreOf(f, qualification);
  await write(tx, tenantId, leadId, s);
  let alerted = false;
  if (s.score === 'hot' && f.hot_alerted_at === null) {
    const members = await tx.execute<{ user_id: string }>(
      sql`select user_id from escalation_candidates()`,
    );
    await notify(tx, {
      tenantId,
      kind: 'hot_lead',
      recipients: members.rows.map((m) => m.user_id),
      urgent: false,
      subject: { type: 'lead', id: leadId },
      dedupeKey: `hot_lead:${leadId}`,
    });
    await tx.execute(
      sql`update leads set hot_alerted_at = now() where tenant_id = ${tenantId} and id = ${leadId}`,
    );
    alerted = true;
  }
  if (s.score !== f.score)
    await audit.append(tx, tenantId, {
      action: 'lead.scored',
      actorType: 'system',
      subjectType: 'lead',
      subjectId: leadId,
      payload: {
        leadId: auditId(leadId),
        score: auditCode(s.score),
        points: s.points,
        reasons: s.reasons.map((r) => auditCode(r.code)),
        alerted,
      },
    });
  return { ...s, previous: f.score, alerted };
}

/** Open leads rescored per criteria save at most (§8); the rest keep their score. */
export const RESCORE_CAP = 5_000;

/**
 * Rescores every open lead with the given criteria (dashboard zone, on a criteria save). Never
 * alerts (D3): an owner tuning criteria would otherwise flood the team. Returns the count.
 */
export async function rescoreOpenLeads(
  tx: Tx,
  tenantId: string,
  qualification: Qualification,
): Promise<number> {
  const { rows } = await tx.execute<Facts>(
    factsSql(
      tenantId,
      sql`l.status in ('new', 'contacted') and l.superseded_by is null
        order by l.updated_at desc limit ${RESCORE_CAP}`,
    ),
  );
  for (const f of rows) await write(tx, tenantId, f.id, scoreOf(f, qualification));
  return rows.length;
}
