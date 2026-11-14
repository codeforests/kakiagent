import { AUDIT_EXPORT_MAX, type AuditExportBody, type AuditFilter } from '@kaki/contracts';
import { sql, type Tx } from '@kaki/db';
import { audit } from './audit.js';
import { auditCount, auditRange, type AuditRecord } from './audit-read.js';
import { canonicalJson } from './canonical.js';
import { auditCode, auditId, type AuditPayload } from './payload.js';

/** Above the cap the export answers 413 `too_many` (D1). */
export class TooManyAuditEntries extends Error {
  override name = 'TooManyAuditEntries';
  constructor(
    readonly count: number,
    readonly max: number,
  ) {
    super(`audit export: ${count} entries, cap ${max}`);
  }
}

const PAGE = 2000;

/**
 * The entries of an export (FEAT-060 §5.3; GOV-02), oldest first, bounded by the head seq
 * read at the start so the file is one consistent snapshot while appends go on.
 */
export async function exportAudit(
  tx: Tx,
  tenantId: string,
  filter: AuditFilter,
  opts: { max?: number } = {},
): Promise<{ records: AuditRecord[]; count: number; headSeq: number }> {
  const max = opts.max ?? AUDIT_EXPORT_MAX;
  const { rows } = await tx.execute<{ seq: string | number }>(
    sql`select coalesce(max(seq), 0) as seq from audit_entries where tenant_id = ${tenantId}`,
  );
  const headSeq = Number(rows[0]!.seq);
  const count = await auditCount(tx, tenantId, filter, headSeq);
  if (count > max) throw new TooManyAuditEntries(count, max);
  const records: AuditRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await auditRange(tx, tenantId, filter, after, headSeq, PAGE);
    records.push(...page);
    if (page.length < PAGE) break;
    after = page.at(-1)!.seq;
  }
  return { records, count: records.length, headSeq };
}

/**
 * One CSV cell (RFC 4180), the same rule as the leads export (governance may not import
 * leads): a cell a spreadsheet would read as a formula (starting `=`, `+`, `-`, `@`, tab or
 * CR) is prefixed with `'`; quoted when it holds a quote, comma or line break.
 */
export function csvCell(v: string | number | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const SGT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
/** `2026-11-14 13:05:09` in Singapore time. */
export function sgtTimestamp(iso: string): string {
  const p = Object.fromEntries(SGT.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p['year']}-${p['month']}-${p['day']} ${p['hour']}:${p['minute']}:${p['second']}`;
}

export const AUDIT_CSV_HEADER = [
  'seq',
  'time_sgt',
  'time_utc',
  'actor_type',
  'actor_id',
  'actor_name',
  'event_type',
  'subjects',
  'payload',
  'personal_data',
  'prev_hash',
  'hash',
] as const;

const nameOf = (r: AuditRecord, names: ReadonlyMap<string, string>) =>
  r.actorType === 'user' && r.actorRef ? (names.get(r.actorRef) ?? null) : null;

/** The CSV (§5.3): UTF-8 with a BOM, CRLF, one row per entry; payload as canonical JSON. */
export function auditCsv(
  records: readonly AuditRecord[],
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const lines: (string | number | null)[][] = [[...AUDIT_CSV_HEADER]];
  for (const r of records)
    lines.push([
      r.seq,
      sgtTimestamp(r.ts),
      r.ts,
      r.actorType,
      r.actorRef,
      nameOf(r, names),
      r.eventType,
      r.subjectRefs.join(' '),
      canonicalJson(r.payload),
      r.pii,
      r.prevHash,
      r.hash,
    ]);
  return `\uFEFF${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * The JSON (§5.3): every hashed field verbatim, so an auditor can recompute each `hash`
 * with the documented algorithm (`chain.ts` `hashInput`). Personal data is never included.
 */
export function auditJson(
  records: readonly AuditRecord[],
  meta: { tenantId: string; exportedAt: string; filters: AuditFilter },
  names: ReadonlyMap<string, string> = new Map(),
): string {
  return JSON.stringify({
    tenant_id: meta.tenantId,
    exported_at: meta.exportedAt,
    filters: meta.filters,
    count: records.length,
    entries: records.map((r) => ({
      tenant_id: r.tenantId,
      seq: r.seq,
      ts: r.ts,
      actor_type: r.actorType,
      actor_ref: r.actorRef,
      actor_name: nameOf(r, names),
      event_type: r.eventType,
      subject_refs: r.subjectRefs,
      payload: r.payload,
      pii_ref: r.piiRef,
      pii_commitment: r.piiCommitment,
      personal_data: r.pii,
      prev_hash: r.prevHash,
      hash: r.hash,
    })),
  });
}

/** `audit-log-YYYY-MM-DD.csv|json`, the date in Singapore. */
export function auditExportFileName(now: Date, format: AuditExportBody['format']): string {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(now);
  return `audit-log-${d}.${format}`;
}

/**
 * Records an export (AC-4): IDs, codes and the count only. Called in the export's
 * transaction after the snapshot bound, so the entry isn't in its own file.
 */
export async function auditExported(
  tx: Tx,
  tenantId: string,
  input: { userId: string; format: AuditExportBody['format']; count: number; filter: AuditFilter },
): Promise<void> {
  const f = input.filter;
  const payload: Record<string, AuditPayload[string]> = {
    format: auditCode(input.format),
    count: input.count,
  };
  if (f.from) payload.from = auditCode(f.from);
  if (f.to) payload.to = auditCode(f.to);
  if (f.group) payload.group = auditCode(f.group);
  if (f.actorType) payload.actor_type = auditCode(f.actorType);
  if (f.conversation) payload.conversation_id = auditId(f.conversation);
  if (f.actor) payload.actor_id = auditId(f.actor);
  await audit.append(tx, tenantId, {
    action: 'audit.exported',
    actorType: 'user',
    actorId: input.userId,
    subjectType: 'tenant',
    subjectId: tenantId,
    payload,
  });
}
