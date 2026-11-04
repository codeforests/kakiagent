import { LeadSettings, LeadSettingsBody } from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import {
  getLeadSettings,
  LeadSettingsInvalid,
  LeadSettingsStale,
  saveLeadSettings,
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
      return LeadSettings.parse(
        await withTenant(dashboardDb, s.tenantId, (tx) =>
          saveLeadSettings(tx, {
            tenantId: s.tenantId,
            userId: s.userId,
            version: body.version,
            fields: body.fields,
            marketing: body.marketing,
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
