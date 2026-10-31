import {
  ChannelConflictError,
  ChannelNotFoundError,
  checkChannelNow,
  listChannels,
  NoHealthCheckError,
  OfflineModeError,
  OfflineTextError,
  saveOfflineSettings,
  setChannelState,
  TooSoonError,
  visitorChannel,
} from '@kaki/channels';
import {
  ChannelItem,
  ChannelOfflineBody,
  ChannelsResponse,
  ChannelStateBody,
  CHANNEL_OFFLINE_TEXT_MAX,
} from '@kaki/contracts';
import { withTenant, type Tx, type ZoneDb } from '@kaki/db';
import { can } from '@kaki/identity';
import { goLiveOne, sgDay } from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

/** 400 `invalid_body` with the fields to fix (FEAT-034 §3; the dashboard maps them to copy). */
export class ChannelBodyError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('invalid channel body');
  }
}

function fieldsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.') || 'body';
    if (out[path]) continue;
    out[path] =
      issue.code === 'too_big'
        ? `max_${CHANNEL_OFFLINE_TEXT_MAX}`
        : issue.code === 'invalid_value'
          ? 'not_allowed'
          : 'invalid';
  }
  return out;
}

const ERRORS: [new (...a: never[]) => Error, number, string, string][] = [
  [ChannelNotFoundError, 404, 'not_found', 'Not found'],
  [ChannelConflictError, 409, 'version_conflict', 'This channel was changed by someone else'],
  [NoHealthCheckError, 400, 'no_health_check', "This channel doesn't need a connection check."],
  [TooSoonError, 429, 'too_soon', 'We just checked. Try again in a few seconds.'],
];

/** The channel routes' errors, for the api's error handler. */
export function channelErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof ChannelBodyError)
    return {
      status: 400,
      body: {
        error: 'invalid_body',
        message: 'Check the values and try again.',
        fields: err.fields,
      },
    };
  if (err instanceof OfflineModeError)
    return channelErrorReply(new ChannelBodyError({ mode: 'not_allowed' }));
  if (err instanceof OfflineTextError)
    return channelErrorReply(
      new ChannelBodyError({ [`message.${err.field}`]: `max_${CHANNEL_OFFLINE_TEXT_MAX}` }),
    );
  for (const [type, status, error, message] of ERRORS)
    if (err instanceof type) return { status, body: { error, message } };
  return null;
}

/** Whether the tenant's widget is live, for coaching's and replay's explainer (§5.3). */
export function widgetLive(zdb: ZoneDb, tenantId: string): () => Promise<boolean> {
  return () => withTenant(zdb, tenantId, (tx) => visitorChannel(tx, 'widget')).then((c) => c.live);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Channels (ONB-10, CHN-12; FEAT-034 §3, §5.4): dashboard trust zone, `settings.manage`.
 * The tenant comes from the session; a connection ID from another tenant is a 404 (RLS).
 */
export function registerChannelRoutes(
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
  const inTenant = <T>(s: TenantSession, fn: (tx: Tx) => Promise<T>) =>
    withTenant(dashboardDb, s.tenantId, fn);
  function idOf(params: { id: string }) {
    if (!UUID_RE.test(params.id)) throw new ChannelNotFoundError();
    return params.id;
  }
  function bodyOf<T>(
    shape: {
      safeParse(v: unknown): { success: true; data: T } | { success: false; error: ZodError };
    },
    body: unknown,
  ): T {
    const parsed = shape.safeParse(body ?? {});
    if (!parsed.success) throw new ChannelBodyError(fieldsOf(parsed.error));
    return parsed.data;
  }

  app.get('/api/v1/channels', async (req) => {
    const s = await manager(req);
    return ChannelsResponse.parse(await inTenant(s, (tx) => listChannels(tx)));
  });

  for (const state of ['live', 'offline'] as const)
    app.post<{ Params: { id: string } }>(`/api/v1/channels/:id/${state}`, async (req) => {
      const s = await manager(req);
      const id = idOf(req.params);
      const { version } = bodyOf(ChannelStateBody, req.body);
      // Going live passes the go-live gate until the first go-live (FEAT-035 D4, D5).
      const change = { tenantId: s.tenantId, userId: s.userId, id, version };
      const item = await inTenant(s, (tx) =>
        state === 'live'
          ? goLiveOne(tx, { ...change, today: sgDay(new Date()) })
          : setChannelState(tx, { ...change, state }),
      );
      return ChannelItem.parse(item);
    });

  app.put<{ Params: { id: string } }>('/api/v1/channels/:id/offline-settings', async (req) => {
    const s = await manager(req);
    const id = idOf(req.params);
    const body = bodyOf(ChannelOfflineBody, req.body);
    const item = await inTenant(s, (tx) =>
      saveOfflineSettings(tx, { tenantId: s.tenantId, userId: s.userId, id, ...body }),
    );
    return ChannelItem.parse(item);
  });

  app.post<{ Params: { id: string } }>('/api/v1/channels/:id/check', async (req) => {
    const s = await manager(req);
    const id = idOf(req.params);
    return ChannelItem.parse(await inTenant(s, (tx) => checkChannelNow(tx, { id })));
  });
}
