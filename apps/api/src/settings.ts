import { assistantDefaults } from '@kaki/agent';
import {
  AssistantSettingsBody,
  AssistantSettingsResponse,
  BusinessProfileBody,
  BusinessProfileResponse,
  exceptionIssues,
  type AssistantSettings,
} from '@kaki/contracts';
import { schema, sql, withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import { dashboardKb, listFacts } from '@kaki/kb';
import {
  getAssistantSettings,
  getBusinessProfile,
  INDUSTRY_TEMPLATES,
  InvalidProfileError,
  isSgPublicHoliday,
  questionKey,
  saveAssistantSettings,
  saveBusinessProfile,
  SG_HOLIDAYS_COVER_THROUGH,
  sgDay,
  sgHolidaysBetween,
  type AssistantPersona,
  type BusinessProfile,
} from '@kaki/tenancy';
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

/** The questions of the tenant's FAQ facts, except rejected ones (FEAT-009 §3.2). */
async function faqQuestions(tx: Tx, tenantId: string, userId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const kb = dashboardKb(tx, tenantId, userId);
  let cursor: string | undefined;
  do {
    const page = await listFacts(kb, { type: 'faq', cursor, limit: 200 });
    for (const f of page.facts)
      if (f.status !== 'rejected' && f.type === 'faq') keys.add(questionKey(f.value.question));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return keys;
}

const DAY_MS = 86_400_000;

/** The response for SCR-APP-044: profile, the coming SG holidays and the template (§3.1). */
async function profileResponse(
  tx: Tx,
  s: { tenantId: string; userId: string },
  profile: BusinessProfile,
  now: Date,
) {
  const today = sgDay(now);
  const yearOn = sgDay(new Date(now.getTime() + 365 * DAY_MS));
  const template = profile.industry ? INDUSTRY_TEMPLATES[profile.industry] : undefined;
  const added = template ? await faqQuestions(tx, s.tenantId, s.userId) : new Set<string>();
  const { updatedAt, ...rest } = profile;
  return BusinessProfileResponse.parse({
    profile: { ...rest, updatedAt: updatedAt.toISOString() },
    calendar: {
      holidays: sgHolidaysBetween(today, yearOn),
      coverThrough: SG_HOLIDAYS_COVER_THROUGH,
    },
    template:
      template && profile.industry
        ? {
            industry: profile.industry,
            suggestedFaqs: template.suggestedFaqs.map((f) => ({
              ...f,
              added: added.has(questionKey(f.question)),
            })),
          }
        : null,
  });
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

  // Business profile (ONB-03, ONB-06; FEAT-009 §3).
  app.get('/api/v1/settings/business-profile', async (req) => {
    const s = await manager(req);
    const now = new Date();
    return withTenant(dashboardDb, s.tenantId, async (tx) =>
      profileResponse(tx, s, await getBusinessProfile(tx, s.tenantId, sgDay(now)), now),
    );
  });

  app.put('/api/v1/settings/business-profile', async (req) => {
    const s = await manager(req);
    const { version, ...profile } = BusinessProfileBody.parse(req.body);
    const now = new Date();
    const today = sgDay(now);
    const issues = exceptionIssues(profile, { isHoliday: isSgPublicHoliday, today });
    if (issues.length) throw new InvalidProfileError(issues[0]!.message);
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const saved = await saveBusinessProfile(tx, {
        tenantId: s.tenantId,
        userId: s.userId,
        version,
        profile,
        today,
      });
      return profileResponse(tx, s, saved, now);
    });
  });

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
