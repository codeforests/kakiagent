import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  checkEmailDomain,
  cleanAttachment,
  clearDomain,
  domainToAdd,
  domainToCheck,
  domainToRemove,
  EmailChannelError,
  emailChannelView,
  identityProvider,
  IdentityProviderError,
  retryDelivery,
  saveReplyCap,
  setupEmail,
  storeDomain,
  type DomainChecks,
} from '@kaki/channels';
import {
  EmailChannelResponse,
  EmailDomainBody,
  EmailDomainRemoveBody,
  EmailReplyCapBody,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { can } from '@kaki/identity';
import { getMessage, messageExtras, toMessage } from '@kaki/inbox';
import { channels } from '@kaki/platform';
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { TenantSession } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps, DownloadSigner, EmailDeps } from './server.js';

/** How long an attachment download link works (§3: 5 minutes). */
export const DOWNLOAD_TTL_S = 5 * 60;

export function s3DownloadSigner(cfg: {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
}): DownloadSigner {
  const s3 = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
  return {
    sign: (key, filename, expiresInS) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
        }),
        { expiresIn: expiresInS },
      ),
  };
}

export function emailDepsFrom(deps: Deps): EmailDeps {
  if (deps.email) return deps.email;
  const { config } = deps;
  return {
    ...identityProvider(config.EMAIL_IDENTITY_PROVIDER, {
      region: config.AWS_REGION,
      configurationSet: config.SES_CONFIGURATION_SET,
    }),
    downloads: s3DownloadSigner({
      bucket: config.ATTACHMENTS_BUCKET,
      region: config.AWS_REGION,
      endpoint: config.AWS_ENDPOINT_URL,
    }),
  };
}

/** 422 with the fields to fix (the reply-cap and domain bodies, §3). */
export class EmailBodyError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('invalid email body');
  }
}

const ERRORS: Record<EmailChannelError['code'], [number, string]> = {
  already_connected: [409, 'Email is already set up.'],
  not_connected: [409, "Email isn't set up yet."],
  stale: [409, 'These settings were changed by someone else. Reload and try again.'],
  platform_domain: [422, 'Use an address on your own domain.'],
  provider_unavailable: [502, "We couldn't reach our email provider. Try again in a minute."],
  too_soon: [429, 'We just checked. Try again in a few seconds.'],
  not_failed: [409, 'This message is not waiting for a retry.'],
  not_found: [404, 'Not found'],
};

/** The email routes' errors, for the api's error handler. */
export function emailErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof EmailBodyError)
    return {
      status: 422,
      body: {
        error: 'invalid_body',
        message: 'Check the values and try again.',
        fields: err.fields,
      },
    };
  if (err instanceof EmailChannelError) {
    const [status, message] = ERRORS[err.code];
    return { status, body: { error: err.code, message } };
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The email channel (CHN-04, CHN-10; FEAT-036 §3): `settings.manage` for the setup page,
 * `inbox.reply` for a delivery retry, `inbox.read` for an attachment. Dashboard zone; the
 * tenant comes from the session, never the body. Provider calls run between transactions.
 */
export function registerEmailChannelRoutes(
  app: App,
  deps: Deps,
  sessionFrom: (req: FastifyRequest) => Promise<TenantSession>,
) {
  const { dashboardDb, config } = deps;
  const email = emailDepsFrom(deps);
  const cfg = { inboundDomain: config.EMAIL_INBOUND_DOMAIN, region: config.AWS_REGION };

  async function allowed(req: FastifyRequest, cap: Parameters<typeof can>[1]) {
    const s = await sessionFrom(req);
    if (!can(s.role, cap)) throw new ForbiddenError(cap);
    return s;
  }
  const inTenant = <T>(s: TenantSession, fn: (tx: Tx) => Promise<T>) =>
    withTenant(dashboardDb, s.tenantId, fn);
  const view = (s: TenantSession, checks: DomainChecks | null = null) =>
    inTenant(s, (tx) => emailChannelView(tx, s.tenantId, cfg, checks)).then((r) =>
      EmailChannelResponse.parse(r),
    );
  function bodyOf<T>(shape: ZodType<T>, body: unknown): T {
    const parsed = shape.safeParse(body ?? {});
    if (parsed.success) return parsed.data;
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join('.') || 'body'] ??= 'invalid';
    throw new EmailBodyError(fields);
  }
  async function provider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof IdentityProviderError) {
        deps.logger.warn({ err }, 'email identity provider failed');
        throw new EmailChannelError('provider_unavailable');
      }
      throw err;
    }
  }

  app.get('/api/v1/channels/email', async (req) => view(await allowed(req, 'settings.manage')));

  app.post('/api/v1/channels/email', async (req, reply) => {
    const s = await allowed(req, 'settings.manage');
    await inTenant(s, (tx) => setupEmail(tx, { tenantId: s.tenantId, userId: s.userId }));
    return reply.code(201).send(await view(s));
  });

  app.put('/api/v1/channels/email/reply-cap', async (req) => {
    const s = await allowed(req, 'settings.manage');
    const body = bodyOf(EmailReplyCapBody, req.body);
    await inTenant(s, (tx) =>
      saveReplyCap(tx, { tenantId: s.tenantId, userId: s.userId, ...body }),
    );
    return view(s);
  });

  app.post('/api/v1/channels/email/domain', async (req, reply) => {
    const s = await allowed(req, 'settings.manage');
    const body = bodyOf(EmailDomainBody, req.body);
    const domain = await inTenant(s, (tx) =>
      domainToAdd(tx, { tenantId: s.tenantId, ...body }, cfg),
    );
    const created = await provider(() => email.identities.create(domain));
    await inTenant(s, (tx) =>
      storeDomain(tx, {
        tenantId: s.tenantId,
        userId: s.userId,
        address: body.address,
        domain,
        dkimTokens: created.dkimTokens,
        mailFrom: created.mailFrom,
        settingsVersion: body.settingsVersion,
      }),
    );
    return reply.code(201).send(await view(s));
  });

  app.post('/api/v1/channels/email/domain/check', async (req) => {
    const s = await allowed(req, 'settings.manage');
    await inTenant(s, (tx) => domainToCheck(tx, s.tenantId));
    const r = await provider(() =>
      checkEmailDomain(
        { zdb: dashboardDb, identities: email.identities, resolver: email.resolver },
        s.tenantId,
      ),
    );
    return view(s, r.checks);
  });

  app.delete('/api/v1/channels/email/domain', async (req) => {
    const s = await allowed(req, 'settings.manage');
    const body = bodyOf(EmailDomainRemoveBody, req.body);
    const domain = await inTenant(s, (tx) => domainToRemove(tx, { tenantId: s.tenantId, ...body }));
    if (domain) await provider(() => email.identities.remove(domain));
    await inTenant(s, (tx) => clearDomain(tx, { tenantId: s.tenantId, userId: s.userId, ...body }));
    return view(s);
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/messages/:id/delivery/retry',
    async (req, reply) => {
      const s = await allowed(req, 'inbox.reply');
      const id = req.params.id;
      if (!UUID_RE.test(id)) throw new EmailChannelError('not_found');
      const message = await inTenant(s, async (tx) => {
        await retryDelivery(tx, { tenantId: s.tenantId, userId: s.userId, messageId: id });
        const row = await getMessage(tx, s.tenantId, id);
        if (!row) return null;
        const { deliveries } = await messageExtras(tx, s.tenantId, [id]);
        return { ...toMessage(row), delivery: deliveries.get(id) ?? null };
      });
      // The open thread shows "Sending…" again (§5.5).
      if (message)
        await deps.publisher
          .publish(channels.conversation(s.tenantId, message.conversationId), {
            type: 'message',
            message,
          })
          .catch((err) => req.log.warn({ err }, 'delivery publish failed'));
      return reply.code(202).send({ ok: true });
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/attachments/:id', async (req, reply) => {
    const s = await allowed(req, 'inbox.read');
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw new EmailChannelError('not_found');
    const a = await inTenant(s, (tx) => cleanAttachment(tx, s.tenantId, id));
    if (!a) throw new EmailChannelError('not_found');
    const url = await email.downloads.sign(a.key, a.name, DOWNLOAD_TTL_S);
    return reply.redirect(url, 302);
  });
}
