import type { LeadExportBody, ScoreReason, ScoreReasonCode } from '@kaki/contracts';
import { LEAD_EXPORT_MAX } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import { audit, auditCode } from '@kaki/governance';
import { TooManyLeads } from './errors.js';
import { leadFilter, leadSelect, scoringOf, type LeadDbRow } from './list.js';

/**
 * Whether a lead may leave the platform (LED-05, LED-06; FEAT-051 §5.2): not while the contact's
 * latest enquiry row is a withdrawal. The one seam for exports and, from FEAT-053, webhooks,
 * which must call it when they send, not when they enqueue.
 */
export function exportable(row: Pick<LeadDbRow, 'consent_withdrawn_at'>): boolean {
  return row.consent_withdrawn_at === null;
}

/** An export's rows and how many withdrawn leads it left out (for the audit). */
export interface LeadExport {
  rows: LeadDbRow[];
  excluded: number;
}

/** The rows of a leads export with the list's filters, newest first; above the cap → `TooManyLeads`. */
export async function exportLeads(
  tx: Tx,
  tenantId: string,
  filters: LeadExportBody,
): Promise<LeadExport> {
  const { rows } = await tx.execute<LeadDbRow>(
    leadSelect(
      tenantId,
      leadFilter(filters),
      sql`order by l.updated_at desc, l.id desc limit ${LEAD_EXPORT_MAX + 1}`,
    ),
  );
  const out = rows.filter(exportable);
  if (out.length > LEAD_EXPORT_MAX) throw new TooManyLeads(out.length);
  return { rows: out, excluded: rows.length - out.length };
}

/** The dashboard's words for each reason (ui-design, "Shared words"). */
export const REASON_TEXT: Record<ScoreReasonCode, (detail: string | null) => string> = {
  keyword: (d) => `Mentions "${d ?? ''}"`,
  budget_met: (d) => `Budget meets your S$${d ?? ''} minimum`,
  budget_below: (d) => `Budget below your S$${d ?? ''} minimum`,
  wants_to_order: () => 'Asked for a quote or to order',
  both_contacts: () => 'Left phone and email',
  need_given: () => 'Said what they need',
  timing_given: () => 'Said when they need it',
  returning: () => 'Came back',
};
export const reasonText = (r: ScoreReason) => REASON_TEXT[r.code](r.detail);

const SGT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Singapore',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** `18 Nov 2026 14:05` in Singapore time. */
export function sgtDateTime(d: Date | string): string {
  const p = Object.fromEntries(SGT.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p['day']} ${p['month']} ${p['year']} ${p['hour']}:${p['minute']}`;
}

export const CSV_REMINDER =
  'Reminder: the Do Not Call Registry applies before you call or text anyone for marketing. Marketing consent is in the "Marketing consent" columns.';

export const CSV_HEADER = [
  'Created (SGT)',
  'Updated (SGT)',
  'Status',
  'Score',
  'Score reasons',
  'Name',
  'Email',
  'Phone',
  'What they need',
  'Budget',
  'Preferred date or time',
  'Enquiry consent at (SGT)',
  'Marketing consent',
  'Marketing consent at (SGT)',
  'Source',
] as const;

const STATUS_TEXT = { new: 'New', contacted: 'Contacted', won: 'Won', lost: 'Lost' } as const;
const SCORE_TEXT = { hot: 'Hot', warm: 'Warm', cold: 'Cold' } as const;

/**
 * One CSV cell (RFC 4180): a cell a spreadsheet would read as a formula (starting `=`, `+`,
 * `-`, `@`, tab or CR) is prefixed with `'`; quoted when it holds a quote, comma or line break.
 */
export function csvCell(v: string | null): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The leads CSV (LED-05, LED-08; AC-6, AC-7): UTF-8 with a BOM so Excel shows Chinese, CRLF,
 * the Do Not Call reminder on line 1, the header on line 2, then one row per lead.
 */
export function leadsCsv(rows: readonly LeadDbRow[]): string {
  const lines: string[][] = [[CSV_REMINDER], [...CSV_HEADER]];
  for (const r of rows) {
    const scoring = scoringOf(r);
    lines.push([
      sgtDateTime(r.created_at),
      sgtDateTime(r.updated_at),
      STATUS_TEXT[r.status],
      scoring ? SCORE_TEXT[scoring.score] : 'Not scored',
      scoring ? scoring.reasons.map(reasonText).join('; ') : '',
      r.name ?? '',
      r.email ?? '',
      r.phone ?? '',
      r.need ?? '',
      r.budget ?? '',
      r.preferred_time ?? '',
      sgtDateTime(r.enquiry_at),
      r.marketing_at === null ? 'Not asked' : r.marketing_agreed ? 'Yes' : 'No',
      r.marketing_at === null ? '' : sgtDateTime(r.marketing_at),
      r.conversation_id ? 'Chat' : 'Contact form',
    ]);
  }
  return `\uFEFF${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** `leads-YYYY-MM-DD.csv`, the date in Singapore. */
export function exportFileName(now: Date): string {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(now);
  return `leads-${d}.csv`;
}

/** Audits a leads export (LED-05; AC-5): the count and filters, never personal data (ADR-014). */
export async function auditExport(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    count: number;
    /** Leads left out because their consent was withdrawn (FEAT-051). */
    excluded?: number;
    filters: LeadExportBody;
  },
): Promise<void> {
  await audit.append(tx, input.tenantId, {
    action: 'lead.exported',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'tenant',
    subjectId: input.tenantId,
    payload: {
      count: input.count,
      excluded: input.excluded ?? 0,
      status: auditCode(input.filters.status),
      ...(input.filters.score ? { score: auditCode(input.filters.score) } : {}),
    },
  });
}
