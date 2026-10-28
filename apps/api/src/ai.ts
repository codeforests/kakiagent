import { textsFor } from '@kaki/agent';
import { liveChannelCount } from '@kaki/channels';
import { AiStatusResponse, type RealtimeEvent } from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { aiPauseState, setAiPaused } from '@kaki/governance';
import { can } from '@kaki/identity';
import { channels } from '@kaki/platform';
import { getAssistantSettings } from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** The pill's status (FEAT-057 §5.4): the flag, live channels and the fallback as the turn resolves it. */
async function statusOf(tx: Tx, tenantId: string): Promise<AiStatusResponse> {
  const [state, liveChannels, persona] = [
    await aiPauseState(tx, tenantId),
    await liveChannelCount(tx),
    await getAssistantSettings(tx, tenantId),
  ];
  return AiStatusResponse.parse({
    status: {
      paused: state.paused,
      pausedAt: state.pausedAt?.toISOString() ?? null,
      liveChannels,
      fallback: { en: textsFor('en', persona).fallback, zh: textsFor('zh', persona).fallback },
    },
  });
}

/**
 * Kill switch (GOV-08, UC-31; FEAT-057 §3): dashboard trust zone. Any member reads the
 * status; the Owner or an Admin pauses and resumes. The send gate reads the flag from
 * Postgres before every turn and segment (D1), so the `ai_status` event is only a nudge.
 */
export function registerAiRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
  notify: (channelNames: string[], event: RealtimeEvent) => Promise<void>,
) {
  const { dashboardDb } = deps;

  app.get('/api/v1/ai/status', async (req) => {
    const s = await sessionFrom(req);
    if (!can(s.role, 'inbox.read')) throw new ForbiddenError('inbox.read');
    return withTenant(dashboardDb, s.tenantId, (tx) => statusOf(tx, s.tenantId));
  });

  for (const [action, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const)
    app.post(`/api/v1/ai/${action}`, async (req) => {
      const s = await sessionFrom(req);
      if (!can(s.role, 'killswitch.toggle')) throw new ForbiddenError('killswitch.toggle');
      const { changed, status } = await withTenant(dashboardDb, s.tenantId, async (tx) => ({
        changed: (await setAiPaused(tx, { tenantId: s.tenantId, userId: s.userId, paused }))
          .changed,
        status: await statusOf(tx, s.tenantId),
      }));
      // After commit; a failed publish is logged by notify (dashboards refetch on a timer).
      if (changed) await notify([channels.inbox(s.tenantId)], { type: 'ai_status', paused });
      return status;
    });
}
