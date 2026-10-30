import {
  MagicLinkResponse,
  MfaCode,
  MfaEnrolmentConfirm,
  MfaEnrolmentStart,
  MfaStatus,
  RecoveryCodes,
  ReauthStatus,
  TeamMfa,
  TeamMfaBody,
} from '@kaki/contracts';
import { and, eq, schema, sql, withTenant, type Tx } from '@kaki/db';
import { audit } from '@kaki/governance';
import {
  can,
  confirmEnrolment,
  mfaStatus,
  passChallenge,
  reauthenticate,
  reauthStatus,
  regenerateRecoveryCodes,
  removeFactor,
  requestReauthLink,
  requireReauth,
  sendMagicLink,
  startEnrolment,
  MfaStateError,
  type MfaDeps,
} from '@kaki/identity';
import { localSealer } from '@kaki/platform/secrets';
import {
  LINK_WINDOW_MS,
  LINKS_PER_EMAIL,
  RateLimitedError,
  sha256,
  UnavailableError,
} from './auth.js';
import type { AuthFrom, SessionFrom } from './auth.js';
import { ForbiddenError } from './facts.js';
import type { App, Deps } from './server.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The workspace's requirement and its active members' enrolment (FEAT-006 §3). */
async function teamMfa(tx: Tx, tenantId: string) {
  const [t] = await tx
    .select({ required: schema.tenants.mfaRequired })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  const { rows } = await tx.execute<{ members: number; enrolled: number }>(
    sql`select members, enrolled from tenant_mfa_enrolment()`,
  );
  return TeamMfa.parse({ required: t?.required ?? false, ...rows[0] });
}

/**
 * Two-step verification and re-authentication (AUTH-03; FEAT-006 §3, §5.3). Routes that a
 * pending session may use say so with `allow`; every other route refuses it in `authFrom`.
 */
export function registerMfaRoutes(
  app: App,
  deps: Deps,
  auth: { authFrom: AuthFrom; sessionFrom: SessionFrom },
) {
  const { config, identityDb, mailer, rateLimiter } = deps;
  const { authFrom, sessionFrom } = auth;
  const { dashboardDb } = deps;
  const mfa: MfaDeps = {
    idDb: identityDb,
    sealer: localSealer(Buffer.from(config.MFA_SECRET_KEY, 'base64url')),
    limiter: rateLimiter,
    issuer: config.APP_NAME,
  };
  const links = { secret: config.MAGIC_LINK_SECRET, appUrl: config.PUBLIC_APP_URL };
  const pending = { allow: ['challenge', 'enrol'] } as const;
  const enrolling = { allow: ['enrol'] } as const;

  app.get('/api/v1/auth/mfa', async (req) => {
    const s = await mfaStatus(mfa, await authFrom(req, pending));
    return MfaStatus.parse({
      ...s,
      enrolledAt: iso(s.enrolledAt),
      lockedUntil: iso(s.lockedUntil),
    });
  });

  app.post('/api/v1/auth/mfa/challenge', async (req, reply) => {
    const a = await authFrom(req, { allow: ['challenge'] });
    await passChallenge(mfa, a, MfaCode.parse(req.body));
    return reply.code(204).send();
  });

  app.post('/api/v1/auth/mfa/enrolment', async (req, reply) => {
    const start = await startEnrolment(mfa, await authFrom(req, enrolling));
    return reply.code(201).send(MfaEnrolmentStart.parse(start));
  });

  app.post('/api/v1/auth/mfa/enrolment/confirm', async (req) => {
    const a = await authFrom(req, enrolling);
    const { code } = MfaEnrolmentConfirm.parse(req.body);
    return RecoveryCodes.parse({ codes: await confirmEnrolment(mfa, a, code) });
  });

  app.post('/api/v1/auth/mfa/recovery-codes', async (req) =>
    RecoveryCodes.parse({ codes: await regenerateRecoveryCodes(mfa, await authFrom(req)) }),
  );

  app.delete('/api/v1/auth/mfa', async (req, reply) => {
    await removeFactor(mfa, await authFrom(req));
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/reauth', async (req) => {
    const s = await reauthStatus(identityDb, await authFrom(req, enrolling));
    return ReauthStatus.parse({ ...s, until: iso(s.until) });
  });

  app.post('/api/v1/auth/reauth', async (req, reply) => {
    const a = await authFrom(req, enrolling);
    await reauthenticate(mfa, a, MfaCode.parse(req.body));
    return reply.code(204).send();
  });

  app.post('/api/v1/auth/reauth/email', async (req, reply) => {
    const a = await authFrom(req, enrolling);
    // The sign-in link limits, per email (AC-5).
    let allowed: boolean;
    try {
      ({ allowed } = await rateLimiter.hit(
        `rl:ml:e:${sha256(a.email)}`,
        LINKS_PER_EMAIL,
        LINK_WINDOW_MS,
      ));
    } catch (err) {
      req.log.error({ err }, 'rate limiter unavailable');
      throw new UnavailableError('rate limiter');
    }
    if (!allowed) throw new RateLimitedError();
    const link = await requestReauthLink(identityDb, links, a);
    const sent = await sendMagicLink(identityDb, mailer, links, link.id);
    if (!sent) req.log.warn({ linkId: link.id }, 're-auth link send failed; queued for retry');
    return reply.code(202).send(MagicLinkResponse.parse({ delayed: !sent }));
  });

  // ---- The workspace's requirement (AUTH-03 "the Owner can require MFA"; D8) -------------
  app.get('/api/v1/team/mfa', async (req) => {
    const s = await sessionFrom(req);
    return withTenant(dashboardDb, s.tenantId, (tx) => teamMfa(tx, s.tenantId));
  });

  app.put('/api/v1/team/mfa', async (req) => {
    const s = await sessionFrom(req);
    if (!can(s.role, 'security.manage')) throw new ForbiddenError('security.manage');
    const { required } = TeamMfaBody.parse(req.body);
    requireReauth(s);
    // The Owner can't require what they haven't set up themselves.
    if (required && !s.mfaEnrolled) throw new MfaStateError('mfa_not_enrolled');
    return withTenant(dashboardDb, s.tenantId, async (tx) => {
      const changed = await tx
        .update(schema.tenants)
        .set({ mfaRequired: required })
        .where(and(eq(schema.tenants.id, s.tenantId), eq(schema.tenants.mfaRequired, !required)))
        .returning({ id: schema.tenants.id });
      if (changed.length)
        await audit.append(tx, s.tenantId, {
          action: 'tenant.mfa_policy_changed',
          actorType: 'user',
          actorId: s.userId,
          subjectType: 'tenant',
          subjectId: s.tenantId,
          payload: { required },
        });
      return teamMfa(tx, s.tenantId);
    });
  });
}
