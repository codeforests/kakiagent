import {
  Account,
  DeviceSessionList,
  EmailChangeBody,
  EmailChangeConfirmed,
  MagicLinkVerifyBody,
  ProfilePatch,
} from '@kaki/contracts';
import {
  AccountError,
  cancelEmailChange,
  confirmEmailChange,
  getAccount,
  listSessions,
  requestEmailChange,
  requireReauth,
  revokeOwnSession,
  sendEmailChange,
  updateProfile,
  type AccountErrorCode,
  type MagicLinkConfig,
} from '@kaki/identity';
import { publishSessionsEnded, UnavailableError, type AuthFrom } from './auth.js';
import type { App, Deps } from './server.js';

/** 5 email-change requests per user per hour (§3). */
const CHANGES_PER_HOUR = 5;
/** Confirmations per IP per 15 minutes, as generous as sign-in links. */
const CONFIRMS_PER_IP = 20;
const HOUR_MS = 3_600_000;
const QUARTER_MS = 15 * 60_000;

/** Too many email-change requests or confirmations (429 `rate_limited`). */
export class AccountRateLimitedError extends Error {}

const ACCOUNT_ERRORS: Record<AccountErrorCode, { status: number; message: string }> = {
  same_email: { status: 409, message: 'That’s already your sign-in email.' },
  email_taken: {
    status: 409,
    message: 'This email is now used by another account, so your email wasn’t changed.',
  },
  current_session: { status: 409, message: 'To sign out of this device, use Sign out.' },
  not_found: { status: 404, message: 'Not found' },
};

/** The account errors as replies (FEAT-008 §3); null for anything else. */
export function accountErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof AccountError) {
    const e = ACCOUNT_ERRORS[err.code];
    return { status: e.status, body: { error: err.code, message: e.message } };
  }
  if (err instanceof AccountRateLimitedError)
    return {
      status: 429,
      body: { error: 'rate_limited', message: 'Too many tries. Try again in an hour.' },
    };
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * My account (AUTH-05, AUTH-02; FEAT-008 §3, §5.2). Identity zone only; the user comes
 * from the session, never the body. `authFrom`, not `sessionFrom`: a user with no
 * workspace can still manage their account. Only the email change needs a fresh
 * re-authentication (D3).
 */
export function registerAccountRoutes(app: App, deps: Deps, { authFrom }: { authFrom: AuthFrom }) {
  const { config, identityDb, mailer, rateLimiter, publisher } = deps;
  const links: MagicLinkConfig = {
    secret: config.MAGIC_LINK_SECRET,
    appUrl: config.PUBLIC_APP_URL,
  };

  async function limit(key: string, max: number, windowMs: number) {
    let allowed: boolean;
    try {
      allowed = (await rateLimiter.hit(key, max, windowMs)).allowed;
    } catch {
      throw new UnavailableError('rate limiter');
    }
    if (!allowed) throw new AccountRateLimitedError();
  }

  app.get('/api/v1/me/account', async (req) => {
    const a = await authFrom(req);
    return Account.parse(await getAccount(identityDb, a.userId));
  });

  app.patch('/api/v1/me/profile', async (req) => {
    const a = await authFrom(req);
    const { displayName } = ProfilePatch.parse(req.body);
    return Account.parse(await updateProfile(identityDb, a.userId, displayName));
  });

  app.post('/api/v1/me/email-change', async (req, reply) => {
    const a = await authFrom(req);
    const { email } = EmailChangeBody.parse(req.body);
    await limit(`rl:email-change:u:${a.userId}`, CHANGES_PER_HOUR, HOUR_MS);
    requireReauth(a);
    const { id } = await requestEmailChange(identityDb, links, a.userId, email);
    // Sent at once; a failure stays queued for the scheduler's sweep (§5.3).
    const sent = await sendEmailChange(identityDb, mailer, links, id);
    if (!sent) req.log.warn({ changeId: id }, 'email change send failed; queued for retry');
    return reply.code(202).send(Account.parse(await getAccount(identityDb, a.userId)));
  });

  app.delete('/api/v1/me/email-change', async (req, reply) => {
    const a = await authFrom(req);
    await cancelEmailChange(identityDb, a.userId);
    return reply.code(204).send();
  });

  // Public (D4): the link proves control of the new address; no cookie is read.
  app.post('/api/v1/email-change/confirm', async (req) => {
    const { token } = MagicLinkVerifyBody.parse(req.body);
    await limit(`rl:ec:ip:${req.ip}`, CONFIRMS_PER_IP, QUARTER_MS);
    return EmailChangeConfirmed.parse(await confirmEmailChange(identityDb, token));
  });

  app.get('/api/v1/me/sessions', async (req) => {
    const a = await authFrom(req);
    return DeviceSessionList.parse({
      sessions: await listSessions(identityDb, a.userId, a.sessionId),
    });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/me/sessions/:id', async (req, reply) => {
    const a = await authFrom(req);
    if (!UUID_RE.test(req.params.id)) throw new AccountError('not_found');
    await revokeOwnSession(identityDb, a.userId, req.params.id, a.sessionId);
    await publishSessionsEnded(publisher, req.log, [req.params.id]);
    return reply.code(204).send();
  });
}
