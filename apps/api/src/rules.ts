import {
  currentRules,
  RulesStale,
  SAFE_DEFAULTS,
  saveRules,
  type BoundaryRules as DomainRules,
} from '@kaki/approvals';
import {
  BoundaryRulesResponse,
  SaveBoundaryRulesRequest,
  type BoundaryRules,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can, requireReauth } from '@kaki/identity';
import { getBusinessProfile, INDUSTRY_TEMPLATES, sgDay } from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** 400 `invalid_rules` with a code per field path (FEAT-054 §3, as channels' `fields`). */
export class RulesBodyError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('invalid rules');
  }
}

function fieldsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.') || 'body';
    if (out[path]) continue;
    out[path] =
      issue.code === 'custom'
        ? issue.message
        : issue.code === 'too_big'
          ? 'too_big'
          : issue.code === 'too_small'
            ? 'too_small'
            : 'invalid';
  }
  return out;
}

export function rulesErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof RulesBodyError)
    return {
      status: 400,
      body: { error: 'invalid_rules', message: 'Check the highlighted rules', fields: err.fields },
    };
  if (err instanceof RulesStale)
    return {
      status: 409,
      body: { error: 'rules_stale', message: 'These rules were changed by someone else' },
    };
  return null;
}

/** The contract and the approvals interface have the same fields (contracts' rules.test). */
const toDomain = (r: BoundaryRules): DomainRules => ({ ...r });

/**
 * Boundary rules (APR-01, UC-29; FEAT-054 §5.4): Owner and Admin (`settings.manage`).
 * Saving is a sensitive action (AUTH-03): session → capability → parse → re-auth → save,
 * so a typo never costs a re-auth and nothing is written before it passes (D7).
 */
export function registerRuleRoutes(
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

  /** The saved rules; else the industry template's topics over the safe defaults (ONB-06). */
  async function response(tx: Tx, tenantId: string) {
    const saved = await currentRules(tx, tenantId);
    if (saved)
      return BoundaryRulesResponse.parse({
        rules: saved.rules,
        version: saved.version,
        savedAt: saved.savedAt.toISOString(),
        source: 'saved',
      });
    const { industry } = await getBusinessProfile(tx, tenantId, sgDay(new Date()));
    const template = industry ? INDUSTRY_TEMPLATES[industry]?.suggestedRules : undefined;
    return BoundaryRulesResponse.parse({
      rules: template
        ? {
            ...SAFE_DEFAULTS,
            allowedTopics: [...template.allowedTopics],
            blockedTopics: [...template.blockedTopics],
          }
        : SAFE_DEFAULTS,
      version: null,
      savedAt: null,
      source: template ? 'template' : 'default',
    });
  }

  app.get('/api/v1/settings/rules', async (req) => {
    const s = await manager(req);
    return withTenant(dashboardDb, s.tenantId, (tx) => response(tx, s.tenantId));
  });

  app.put('/api/v1/settings/rules', async (req) => {
    const s = await manager(req);
    const body = SaveBoundaryRulesRequest.safeParse(req.body);
    if (!body.success) throw new RulesBodyError(fieldsOf(body.error));
    requireReauth(s);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      await saveRules(tx, s.tenantId, {
        expectedVersion: body.data.version,
        rules: toDomain(body.data.rules),
        userId: s.userId,
      });
      return response(tx, s.tenantId);
    });
  });
}
