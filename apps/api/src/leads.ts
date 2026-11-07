import {
  LeadConflict409,
  LeadDetail,
  LeadExportBody,
  LeadList,
  LeadRow,
  LeadSettings,
  LeadSettingsBody,
  LeadSettingsSaved,
  LeadsQuery,
  LeadStatusBody,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can, requireReauth } from '@kaki/identity';
import { NotFoundError } from '@kaki/inbox';
import {
  auditExport,
  exportFileName,
  exportLeads,
  getLeadSettings,
  InvalidLeadCursor,
  leadDetail,
  LeadNotFound,
  leadsCsv,
  LeadSettingsInvalid,
  LeadSettingsStale,
  LeadStale,
  listLeads,
  OpenLeadExists,
  saveLeadSettings,
  setLeadStatus,
  TooManyLeads,
} from '@kaki/leads';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** 400 `invalid_lead_settings` with a code (`phone_or_email`, `marketing_text`, `invalid`). */
export class LeadSettingsBodyError extends Error {
  constructor(readonly code: string) {
    super('invalid lead settings');
  }
}

/** 409 `stale` with the current settings, so the form can show what changed. */
class StaleWith extends Error {
  constructor(readonly current: LeadSettings) {
    super('stale');
  }
}

export function leadSettingsErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof LeadSettingsBodyError)
    return {
      status: 400,
      body: {
        error: 'invalid_lead_settings',
        message: 'Check the highlighted settings',
        code: err.code,
      },
    };
  if (err instanceof LeadStale)
    return {
      status: 409,
      body: LeadConflict409.parse({ error: 'stale', lead: err.lead }) as Record<string, unknown>,
    };
  if (err instanceof OpenLeadExists)
    return {
      status: 409,
      body: {
        error: 'open_lead_exists',
        message: 'This person already has an open lead. Close that one first.',
      },
    };
  if (err instanceof TooManyLeads)
    return {
      status: 413,
      body: {
        error: 'too_many',
        message: 'Too many leads to export at once. Narrow it with a status or score filter.',
      },
    };
  if (err instanceof InvalidLeadCursor)
    return { status: 400, body: { error: 'invalid_cursor', message: 'Reload the list' } };
  if (err instanceof StaleWith)
    return {
      status: 409,
      body: {
        error: 'stale',
        message: 'These settings were changed by someone else',
        current: err.current,
      },
    };
  return null;
}

/**
 * Leads and consent settings (SCR-APP-043; FEAT-049 §3, D3, D6): the lead form's fields and the
 * marketing opt-in. Owner and Admin (`settings.manage`); not a sensitive action (AUTH-03 list).
 */
export function registerLeadSettingsRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb } = deps;

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'settings.manage')) throw new ForbiddenError('settings.manage');
    return s;
  }

  app.get('/api/v1/settings/leads', async (req) => {
    const s = await manager(req);
    return LeadSettings.parse(
      await withTenant(dashboardDb, s.tenantId, (tx) => getLeadSettings(tx, s.tenantId)),
    );
  });

  app.put('/api/v1/settings/leads', async (req) => {
    const s = await manager(req);
    const parsed = LeadSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      const phoneOrEmail = parsed.error.issues.some((i) => i.message === 'phone_or_email');
      throw new LeadSettingsBodyError(phoneOrEmail ? 'phone_or_email' : 'invalid');
    }
    const body = parsed.data;
    try {
      return LeadSettingsSaved.parse(
        await withTenant(dashboardDb, s.tenantId, (tx) =>
          saveLeadSettings(tx, {
            tenantId: s.tenantId,
            userId: s.userId,
            version: body.version,
            fields: body.fields,
            marketing: body.marketing,
            qualification: body.qualification,
          }),
        ),
      );
    } catch (err) {
      if (err instanceof LeadSettingsInvalid) throw new LeadSettingsBodyError(err.code);
      if (err instanceof LeadSettingsStale)
        throw new StaleWith(
          LeadSettings.parse(
            await withTenant(dashboardDb, s.tenantId, (tx) => getLeadSettings(tx, s.tenantId)),
          ),
        );
      throw err;
    }
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The leads list, lead page, pipeline and CSV export (SCR-APP-032, SCR-APP-033; FEAT-050 §3,
 * §5.5). Everyone with `inbox.read` sees leads; Owner and Admin move them (`leads.manage`) and
 * export them after re-auth (`leads.export`, AUTH-03). The tenant comes from the session only.
 */
export function registerLeadRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb } = deps;

  async function member(
    req: FastifyRequest,
    capability: 'inbox.read' | 'leads.manage' | 'leads.export',
  ) {
    const s = await sessionFrom(req);
    if (!can(s.role, capability)) throw new ForbiddenError(capability);
    return s;
  }
  const idOf = (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('lead not found');
    return id;
  };
  const notFound = (err: unknown) => {
    if (err instanceof LeadNotFound) throw new NotFoundError('lead not found');
    throw err;
  };

  app.get('/api/v1/leads', async (req) => {
    const s = await member(req, 'inbox.read');
    const q = LeadsQuery.parse(req.query);
    return LeadList.parse(
      await withTenant(dashboardDb, s.tenantId, (tx) => listLeads(tx, s.tenantId, q)),
    );
  });

  app.get('/api/v1/leads/:id', async (req) => {
    const s = await member(req, 'inbox.read');
    const id = idOf(req);
    const rights = {
      canManage: can(s.role, 'leads.manage'),
      canExport: can(s.role, 'leads.export'),
    };
    return LeadDetail.parse(
      await withTenant(dashboardDb, s.tenantId, (tx) =>
        leadDetail(tx, s.tenantId, id, rights),
      ).catch(notFound),
    );
  });

  app.post('/api/v1/leads/:id/status', async (req) => {
    const s = await member(req, 'leads.manage');
    const id = idOf(req);
    const body = LeadStatusBody.parse(req.body);
    return LeadRow.parse(
      await withTenant(dashboardDb, s.tenantId, (tx) =>
        setLeadStatus(tx, { tenantId: s.tenantId, leadId: id, userId: s.userId, ...body }),
      ).catch(notFound),
    );
  });

  app.post('/api/v1/leads/export', async (req, reply) => {
    const s = await member(req, 'leads.export');
    requireReauth(s);
    const filters = LeadExportBody.parse(req.body ?? {});
    const csv = await withTenant(dashboardDb, s.tenantId, async (tx) => {
      const { rows, excluded } = await exportLeads(tx, s.tenantId, filters);
      await auditExport(tx, {
        tenantId: s.tenantId,
        userId: s.userId,
        count: rows.length,
        excluded,
        filters,
      });
      return leadsCsv(rows);
    });
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${exportFileName(new Date())}"`)
      .header('Cache-Control', 'no-store')
      .send(csv);
  });
}
