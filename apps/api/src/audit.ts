import {
  AuditBreakReason,
  AuditExportBody,
  AuditFilters,
  AuditLastVerified,
  AuditPage,
  AuditQuery,
  AuditRow,
  AuditTooMany,
  AuditVerifyResult,
  type AuditFilter,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import {
  actorIdsOf,
  auditCsv,
  auditEntry,
  auditExported,
  auditExportFileName,
  auditJson,
  exportAudit,
  lastVerification,
  listAudit,
  toAuditRow,
  TooManyAuditEntries,
  VerifyCooldown,
  verifyForDashboard,
  VerifyRunning,
  type AuditRecord,
  type BreakReason,
} from '@kaki/governance';
import { can, inboxMembers, memberNames, requireReauth } from '@kaki/identity';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

// The contract's break reasons are governance's, both ways (FEAT-060 §3).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameReasons: Same<BreakReason, AuditBreakReason> = true;
void sameReasons;

/** 409 `verify_running`, 429 `verify_cooldown`, 413 `too_many` (FEAT-060 §3, D4). */
export function auditErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown>; retryAfterS?: number } | null {
  if (err instanceof VerifyRunning)
    return {
      status: 409,
      body: { error: 'verify_running', message: 'A check of the audit log is already running' },
    };
  if (err instanceof VerifyCooldown)
    return {
      status: 429,
      body: {
        error: 'verify_cooldown',
        message: 'The audit log was just checked. Try again shortly.',
        retryAfterS: err.retryAfterS,
      },
      retryAfterS: err.retryAfterS,
    };
  if (err instanceof TooManyAuditEntries)
    return {
      status: 413,
      body: AuditTooMany.parse({ error: 'too_many', count: err.count, max: err.max }),
    };
  return null;
}

/**
 * The audit log (SCR-APP-050; GOV-01, GOV-02, UC-32; FEAT-060 §5.4): list, entry, filter
 * options, last verification, verify and export. Owner and Admin (`audit.read`); export is a
 * sensitive action (AUTH-03). Tenant from the session only.
 */
export function registerAuditRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, identityDb } = deps;
  const namesOf = (tenantId: string, records: readonly AuditRecord[]) =>
    withTenant(identityDb, tenantId, (itx) => memberNames(itx, actorIdsOf(records)));

  async function reader(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'audit.read')) throw new ForbiddenError('audit.read');
    return s;
  }

  app.get('/api/v1/audit/entries', async (req) => {
    const s = await reader(req);
    const q = AuditQuery.parse(req.query ?? {});
    const { records, next } = await withTenant(dashboardDb, s.tenantId, (tx) =>
      listAudit(tx, s.tenantId, q),
    );
    const names = await namesOf(s.tenantId, records);
    return AuditPage.parse({ entries: records.map((r) => toAuditRow(r, names)), next });
  });

  app.get('/api/v1/audit/entries/:seq', async (req, reply) => {
    const s = await reader(req);
    const raw = (req.params as { seq: string }).seq;
    const seq = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
    const record =
      seq === null
        ? null
        : await withTenant(dashboardDb, s.tenantId, (tx) => auditEntry(tx, s.tenantId, seq));
    if (!record)
      return reply.code(404).send({ error: 'not_found', message: 'No such audit entry' });
    return AuditRow.parse(toAuditRow(record, await namesOf(s.tenantId, [record])));
  });

  app.get('/api/v1/audit/filters', async (req) => {
    const s = await reader(req);
    const members = await withTenant(identityDb, s.tenantId, (itx) => inboxMembers(itx));
    return AuditFilters.parse({ members: members.map((m) => ({ id: m.userId, name: m.name })) });
  });

  app.get('/api/v1/audit/verification', async (req) => {
    const s = await reader(req);
    const last = await lastVerification(dashboardDb, s.tenantId);
    if (!last) return AuditLastVerified.parse({ last: null });
    const names = last.byUserId
      ? await withTenant(identityDb, s.tenantId, (itx) => memberNames(itx, [last.byUserId!]))
      : new Map<string, string>();
    return AuditLastVerified.parse({
      last: {
        ok: last.ok,
        headSeq: last.headSeq,
        verifiedAt: last.verifiedAt,
        by: last.byUserId ? (names.get(last.byUserId) ?? null) : null,
      },
    });
  });

  app.post('/api/v1/audit/verify', async (req) => {
    const s = await reader(req);
    return AuditVerifyResult.parse(
      await verifyForDashboard(dashboardDb, s.tenantId, {
        anchors: deps.auditAnchors,
        userId: s.userId,
        log: deps.logger,
      }),
    );
  });

  app.post('/api/v1/audit/export', async (req, reply) => {
    const s = await reader(req);
    requireReauth(s);
    const { format, ...filter } = AuditExportBody.parse(req.body ?? {});
    const now = new Date();
    const records = await withTenant(dashboardDb, s.tenantId, async (tx) => {
      const out = await exportAudit(
        tx,
        s.tenantId,
        filter,
        deps.auditExportMax === undefined ? {} : { max: deps.auditExportMax },
      );
      await auditExported(tx, s.tenantId, { userId: s.userId, format, count: out.count, filter });
      return out.records;
    });
    const names = await namesOf(s.tenantId, records);
    const body =
      format === 'csv'
        ? auditCsv(records, names)
        : auditJson(
            records,
            { tenantId: s.tenantId, exportedAt: now.toISOString(), filters: filter as AuditFilter },
            names,
          );
    return reply
      .header(
        'Content-Type',
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      )
      .header('Content-Disposition', `attachment; filename="${auditExportFileName(now, format)}"`)
      .header('Cache-Control', 'no-store')
      .send(body);
  });
}
