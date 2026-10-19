import { DEV_SESSION_COOKIE, issueDevSession } from '@kaki/identity';
import { z } from 'zod';
import type { App, Deps } from './server.js';

/** The seeded dev tenants (packages/db/src/setup.ts). */
const DEV_TENANTS: Record<string, string> = {
  'kaki-bakery': '11111111-1111-4111-8111-111111111111',
  'second-tenant': '22222222-2222-4222-8222-222222222222',
};

/**
 * DEV-ONLY sign-in as the seeded owner of a dev tenant (plan §2). Never present in a
 * production bundle. FEAT-005 deletes this file.
 */
export function registerDevAuth(app: App, deps: Deps) {
  deps.logger.warn('DEV-ONLY sign-in is enabled (KAKI_DEV_AUTH=true)');
  const body = z.object({
    tenant: z.enum(['kaki-bakery', 'second-tenant']).default('kaki-bakery'),
  });

  app.post('/api/dev/sign-in', async (req, reply) => {
    const { tenant } = body.parse(req.body ?? {});
    const token = issueDevSession(DEV_TENANTS[tenant]!, deps.config.SESSION_SECRET);
    return reply
      .setCookie(DEV_SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      })
      .code(204)
      .send();
  });

  app.post('/api/dev/sign-out', async (_req, reply) =>
    reply.clearCookie(DEV_SESSION_COOKIE, { path: '/' }).code(204).send(),
  );
}
