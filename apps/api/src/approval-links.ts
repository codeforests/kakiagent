import {
  ApprovalLinkError,
  approvalLinkKey,
  openApprovalLink,
  type LinkOpener,
} from '@kaki/approvals';
import { APPROVAL_LINK_ERRORS, ApprovalLinkBody, ApprovalLinkOpened } from '@kaki/contracts';
import { authenticate, SESSION_COOKIE } from '@kaki/identity';
import { RateLimitedError, UnavailableError } from './auth.js';
import type { App, Deps } from './server.js';

/** Opens per IP: enough for a team's alerts, cheap to hammer (FEAT-056 §5.3). */
const OPENS_PER_IP = 30;
const OPEN_WINDOW_MS = 10 * 60_000;

const MESSAGES: Record<keyof typeof APPROVAL_LINK_ERRORS, string> = {
  link_invalid: "This link isn't valid.",
  link_expired: 'This link has expired.',
  link_used: 'This link has already been used.',
  wrong_account: 'This link was sent to another team member.',
  not_member: "You're no longer on this business's team.",
};

/**
 * Signed approval links (APR-03; FEAT-056 §3, §5.3). Public: the route reads the session
 * cookie itself, and "not signed in" or "two-step owed" is a 200 state, never a 401 (the
 * dashboard sends any 401 to sign-in without a return path). The tenant comes only from the
 * verified token.
 */
export function registerApprovalLinkRoutes(app: App, deps: Deps) {
  const { identityDb, dashboardDb, rateLimiter, config } = deps;
  const key = approvalLinkKey(config.MAGIC_LINK_SECRET);

  app.post('/api/v1/approval-links/open', async (req, reply) => {
    const { token } = ApprovalLinkBody.parse(req.body);
    let allowed: boolean;
    try {
      allowed = (await rateLimiter.hit(`rl:al:ip:${req.ip}`, OPENS_PER_IP, OPEN_WINDOW_MS)).allowed;
    } catch (err) {
      req.log.error({ err }, 'rate limiter unavailable');
      throw new UnavailableError('rate limiter');
    }
    if (!allowed) throw new RateLimitedError();

    const auth = await authenticate(identityDb, req.cookies[SESSION_COOKIE]);
    const who: LinkOpener = !auth.ok
      ? null
      : auth.auth.mfa === 'challenge'
        ? 'two_step'
        : auth.auth.mfa === 'enrol'
          ? 'two_step_setup'
          : {
              sessionId: auth.auth.sessionId,
              userId: auth.auth.userId,
              activeTenantId: auth.auth.tenantId,
            };
    try {
      const opened = await openApprovalLink(
        { dashboardDb, idDb: identityDb, key },
        who,
        token,
        new Date(),
      );
      return ApprovalLinkOpened.parse(opened);
    } catch (err) {
      if (err instanceof ApprovalLinkError)
        return reply
          .code(APPROVAL_LINK_ERRORS[err.code])
          .send({ error: err.code, message: MESSAGES[err.code] });
      throw err;
    }
  });
}
