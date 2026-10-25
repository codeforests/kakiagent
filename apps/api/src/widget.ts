import {
  addOrigin,
  clearLogo,
  DetectRunningError,
  getWidgetSettings,
  InvalidOriginError,
  LogoTooLargeError,
  LogoTypeError,
  NoSiteError,
  OriginExistsError,
  OriginNotAllowedError,
  OriginNotFoundError,
  removeOrigin,
  requestDetection,
  setAppearance,
  setLogo,
  TooManyOriginsError,
  visitorLogo,
  type WidgetContext,
  type WidgetUrls,
} from '@kaki/channels';
import {
  WIDGET_LOGO_MAX_BYTES,
  WidgetAppearanceBody,
  WidgetDetectBody,
  WidgetDetectResponse,
  WidgetOriginBody,
  WidgetSettings,
} from '@kaki/contracts';
import { withTenant } from '@kaki/db';
import { can } from '@kaki/identity';
import { resolveWidgetKey } from '@kaki/tenancy';
import type { FastifyRequest } from 'fastify';
import type { TenantSession } from './auth.js';
import { bodyOf } from './corrections.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

const ERRORS: [new (...a: never[]) => Error, number, string, string][] = [
  [InvalidOriginError, 422, 'invalid_origin', 'Enter a website address such as bakery.sg.'],
  [OriginExistsError, 409, 'origin_exists', 'This website is already on the list.'],
  [TooManyOriginsError, 422, 'too_many_origins', 'You can add up to 20 websites.'],
  [OriginNotFoundError, 404, 'not_found', 'This website is not on the list.'],
  [NoSiteError, 422, 'no_site', 'Add your website first, then we can match its look.'],
  [OriginNotAllowedError, 422, 'origin_not_allowed', 'Add this website to the list first.'],
  [DetectRunningError, 409, 'detect_running', "We're already reading your site's look."],
  [LogoTooLargeError, 413, 'logo_too_large', 'Use a logo of 100 KB or less.'],
  [LogoTypeError, 415, 'logo_type', 'Use a PNG, JPEG or WebP image.'],
];

/** The website widget's errors (FEAT-032 §3), for the api's error handler. */
export function widgetErrorReply(
  err: unknown,
  url: string,
): { status: number; body: { error: string; message: string } } | null {
  for (const [type, status, error, message] of ERRORS)
    if (err instanceof type) return { status, body: { error, message } };
  // Fastify's own body checks on the logo route.
  const code = (err as { code?: string } | null)?.code;
  if (url.startsWith('/api/v1/widget/logo')) {
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return widgetErrorReply(new LogoTooLargeError(), url);
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || code === 'FST_ERR_CTP_EMPTY_TYPE')
      return widgetErrorReply(new LogoTypeError(), url);
  }
  return null;
}

/**
 * The website widget (ONB-07, CHN-11, CHN-14; FEAT-032 §3, §5.6): dashboard trust zone,
 * `settings.manage`; plus the public logo route on the visitor zone.
 */
export function registerWidgetRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, visitorDb, config } = deps;
  const urls: WidgetUrls = {
    loaderUrl: config.PUBLIC_WIDGET_LOADER_URL,
    previewUrl: config.PUBLIC_WIDGET_PREVIEW_URL,
    apiUrl: config.PUBLIC_API_URL,
  };

  async function manager(req: FastifyRequest) {
    const s = await sessionFrom(req);
    if (!can(s.role, 'settings.manage')) throw new ForbiddenError('settings.manage');
    return s;
  }
  const inTenant = <T>(s: TenantSession, fn: (ctx: WidgetContext) => Promise<T>) =>
    withTenant(dashboardDb, s.tenantId, (tx) => fn({ tx, tenantId: s.tenantId, userId: s.userId }));
  const settings = (ctx: WidgetContext) =>
    getWidgetSettings(ctx, urls).then((r) => WidgetSettings.parse(r));

  app.get('/api/v1/widget', async (req) => inTenant(await manager(req), settings));

  app.put('/api/v1/widget/appearance', async (req) => {
    const s = await manager(req);
    const body = bodyOf(WidgetAppearanceBody, req.body);
    return inTenant(s, async (ctx) => {
      await setAppearance(ctx, body);
      return settings(ctx);
    });
  });

  app.post('/api/v1/widget/theme/detect', async (req, reply) => {
    const s = await manager(req);
    const body = bodyOf(WidgetDetectBody, req.body);
    const detection = await inTenant(s, async (ctx) => {
      await requestDetection(ctx, body);
      return (await getWidgetSettings(ctx, urls)).detection;
    });
    return reply.code(202).send(WidgetDetectResponse.parse({ detection }));
  });

  // The logo is the raw image body (D7); other routes never see image bodies.
  app.addContentTypeParser(
    /^image\/(png|jpeg|webp)$/,
    { parseAs: 'buffer', bodyLimit: WIDGET_LOGO_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );
  app.put('/api/v1/widget/logo', { bodyLimit: WIDGET_LOGO_MAX_BYTES }, async (req) => {
    const s = await manager(req);
    if (!Buffer.isBuffer(req.body)) throw new LogoTypeError();
    const bytes = req.body;
    const type = req.headers['content-type'] ?? '';
    return inTenant(s, async (ctx) => {
      await setLogo(ctx, { bytes, type });
      return settings(ctx);
    });
  });

  app.delete('/api/v1/widget/logo', async (req) => {
    const s = await manager(req);
    return inTenant(s, async (ctx) => {
      await clearLogo(ctx);
      return settings(ctx);
    });
  });

  app.post('/api/v1/widget/origins', async (req, reply) => {
    const s = await manager(req);
    const { origin } = bodyOf(WidgetOriginBody, req.body);
    const out = await inTenant(s, async (ctx) => {
      await addOrigin(ctx, origin);
      return settings(ctx);
    });
    return reply.code(201).send(out);
  });

  app.delete<{ Params: { origin: string } }>('/api/v1/widget/origins/:origin', async (req) => {
    const s = await manager(req);
    return inTenant(s, async (ctx) => {
      await removeOrigin(ctx, req.params.origin);
      return settings(ctx);
    });
  });

  // Public: the launcher's logo, cached for good per version (D7).
  app.get<{ Params: { key: string } }>('/widget/v1/logo/:key', async (req, reply) => {
    const key = req.params.key;
    const install = key.length <= 100 ? await resolveWidgetKey(visitorDb, key) : null;
    const logo =
      install && install.status === 'active'
        ? await withTenant(visitorDb, install.tenantId, (tx) => visitorLogo(tx, install.tenantId))
        : null;
    if (!logo) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    return reply
      .header('content-type', logo.type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(logo.bytes);
  });
}
