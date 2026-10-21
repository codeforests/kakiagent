import { assistantDefaults } from '@kaki/agent';
import {
  AssistantSettingsBody,
  AssistantSettingsResponse,
  type AssistantSettings,
} from '@kaki/contracts';
import { schema, sql, withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import { getAssistantSettings, saveAssistantSettings, type AssistantPersona } from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

function toSettings(p: AssistantPersona): AssistantSettings {
  const { updatedAt, ...rest } = p;
  return { ...rest, updatedAt: updatedAt ? updatedAt.toISOString() : null };
}

async function businessName(tx: Tx, tenantId: string): Promise<string> {
  const { rows } = await tx.execute<{ name: string }>(
    sql`select ${schema.tenants.name} as name from ${schema.tenants} where ${schema.tenants.id} = ${tenantId}`,
  );
  return rows[0]?.name ?? '';
}

/**
 * The Assistant settings routes (AGT-08, AGT-11; FEAT-024 §3), dashboard trust zone,
 * Owner and Admin only. The defaults come from the agent's own texts, so the screen's
 * preview and the stored disclosure can't drift (§5.5).
 */
export function registerSettingsRoutes(
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

  app.get('/api/v1/settings/assistant', async (req) => {
    const s = await manager(req);
    return withTenant(dashboardDb, s.tenantId, async (tx) =>
      AssistantSettingsResponse.parse({
        settings: toSettings(await getAssistantSettings(tx, s.tenantId)),
        defaults: assistantDefaults(await businessName(tx, s.tenantId)),
      }),
    );
  });

  app.put('/api/v1/settings/assistant', async (req) => {
    const s = await manager(req);
    const { version, ...persona } = AssistantSettingsBody.parse(req.body);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const saved = await saveAssistantSettings(tx, {
        tenantId: s.tenantId,
        userId: s.userId,
        version,
        persona,
      });
      return AssistantSettingsResponse.parse({
        settings: toSettings(saved),
        defaults: assistantDefaults(await businessName(tx, s.tenantId)),
      });
    });
  });
}
