import cookie from '@fastify/cookie';
import {
  isAllowedOrigin,
  recordInstallSeen,
  recordRejectedOrigin,
  visitorChannel,
  visitorWidgetTheme,
} from '@kaki/channels';
import {
  CreateConversationResponse,
  EndConversationResponse,
  EscalateResponse,
  SendMessageBody,
  SendMessageResponse,
  WidgetConfigQuery,
  WidgetConfigResponse,
  type RealtimeEvent,
} from '@kaki/contracts';
import { ping, withTenant } from '@kaki/db';
import {
  LinkError,
  MfaChallengeError,
  MfaCodeError,
  MfaEnrolmentError,
  MfaLockedError,
  MfaRateLimitError,
  MfaStateError,
  ReauthRequiredError,
  SESSION_COOKIE,
  memberNames,
  TermsOutdatedError,
  type MfaStateCode,
} from '@kaki/identity';
import {
  appendVisitorMessage,
  ConversationClosedError,
  conversationSummary,
  createConversation,
  endVisitorConversation,
  getConversation,
  NotFoundError,
  recentMessages,
  requestEscalation,
  toMessage,
  toSummary,
} from '@kaki/inbox';
import {
  BadMappingError,
  EmbeddingUnavailableError,
  FactNotFoundError,
  FileLimitError,
  GstRequiredError,
  InvalidCursorError,
  InvalidFactError,
  InvalidStateError,
  InvalidWebsiteError,
  NonPublicHostError,
  NotRetryableError,
  PreviewStaleError,
  ConflictChangedError,
  CorrectionClosedError,
  CorrectionNotFoundError,
  NotEditableError,
  CorrectionStaleError,
  InvalidCorrectionError,
  SourceExistsError,
  SourceNotFoundError,
  VersionConflictError,
} from '@kaki/kb';
import { leadCaptureConfig } from '@kaki/leads';
import { channels, signToken, TokenError, verifyToken } from '@kaki/platform';
import {
  CoachingSessionNotFoundError,
  ConversationGoneError,
  DEFAULT_BOT_NAME,
  DEFAULT_GREETING,
  escalationNotice,
  InvalidReplayCursorError,
  InvalidSessionCursorError,
  NothingToReplayError,
  CorrectionReplayNotFoundError,
  ReplayCompleteError,
  ReplayConversationNotFoundError,
  textsFor,
} from '@kaki/agent';
import {
  InvalidProfileError,
  resolveWidgetKey,
  SettingsConflictError,
  UnknownTopicError,
  visitorTenantState,
} from '@kaki/tenancy';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { PrivacyConflictError, privacyNoticeUrl, visitorPrivacy } from '@kaki/governance';
import {
  NoWorkspaceError,
  RateLimitedError,
  registerAuth,
  UnauthenticatedError,
  UnavailableError,
} from './auth.js';
import { accountErrorReply, registerAccountRoutes } from './account.js';
import { registerMfaRoutes } from './mfa.js';
import {
  CoachRateLimitedError,
  InvalidCoachBodyError,
  registerCoachRoutes,
  ReplayRateLimitedError,
} from './coach.js';
import { FactNotFound, ForbiddenError, registerFactRoutes } from './facts.js';
import { registerPrivacyRoutes } from './privacy.js';
import { registerRuleRoutes, rulesErrorReply } from './rules.js';
import { createServer, type Deps } from './server.js';
import { registerUploadRoutes } from './uploads.js';
import { registerConflictRoutes, toConflict } from './conflicts.js';
import { registerReviewRoutes, toPreview } from './review.js';
import { InvalidBodyError, InvalidQueryError, registerCorrectionRoutes } from './corrections.js';
import { registerCoverageRoutes } from './coverage.js';
import { registerSettingsRoutes } from './settings.js';
import { registerWidgetRoutes, widgetErrorReply } from './widget.js';
import { channelErrorReply, registerChannelRoutes } from './channels.js';
import { emailErrorReply, registerEmailChannelRoutes } from './email-channel.js';
import {
  registerHookRoutes,
  registerTelegramChannelRoutes,
  telegramErrorReply,
} from './telegram-channel.js';
import { onboardingErrorReply, registerOnboardingRoutes } from './onboarding.js';
import { registerApprovalRoutes } from './approvals.js';
import { registerApprovalLinkRoutes } from './approval-links.js';
import { registerInboxRoutes } from './inbox.js';
import { registerAiRoutes } from './ai.js';
import { registerTeamRoutes, teamErrorReply } from './team.js';
import { notificationsErrorReply, registerNotificationRoutes } from './notifications.js';
import { escalationErrorReply, registerEscalationRoutes } from './escalation.js';
import { leadsErrorReply, registerLeadWidgetRoutes } from './leads-widget.js';
import { leadSettingsErrorReply, registerLeadRoutes, registerLeadSettingsRoutes } from './leads.js';
import {
  AttestationRequiredError,
  FileTooLargeError,
  registerSourceRoutes,
  UnsupportedFileError,
} from './sources.js';

export type { App, Deps } from './server.js';

/** Signed widget visitor token claims (ADR-016 decision 6): tenant, origin and visitor are bound. */
interface VisitorClaims {
  t: string;
  o: string;
  v: string;
  exp: number;
}

const VISITOR_TOKEN_TTL_S = 3600;

const LINK_MESSAGES: Record<LinkError['code'], string> = {
  link_expired: 'This link has expired.',
  link_used: 'This link has already been used.',
  link_invalid: "This link isn't valid.",
  link_other_session: 'Open this link in the browser where you asked for it.',
};

const MFA_STATE_MESSAGES: Record<MfaStateCode, string> = {
  mfa_already_enrolled: 'Two-step verification is already on.',
  mfa_not_enrolled: 'Two-step verification is off.',
  no_enrolment: 'Start setting up two-step verification again.',
  mfa_required_by_workspace: 'A workspace you belong to requires two-step verification.',
  use_authenticator: 'Use your authenticator app to confirm it’s you.',
};

export async function buildApp(deps: Deps) {
  const { config, dashboardDb, visitorDb, publisher } = deps;
  const app = createServer(deps.logger);
  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid request' });
    if (
      err instanceof InvalidFactError ||
      err instanceof InvalidCursorError ||
      err instanceof InvalidSessionCursorError ||
      err instanceof InvalidReplayCursorError ||
      err instanceof InvalidProfileError
    )
      return reply.code(400).send({ error: 'bad_request', message: err.message });
    if (err instanceof AttestationRequiredError)
      return reply.code(400).send({
        error: 'attestation_required',
        message: 'Confirm you own or manage this website first.',
      });
    if (err instanceof InvalidWebsiteError)
      return reply.code(400).send({ error: 'bad_request', message: err.message });
    if (err instanceof NonPublicHostError)
      return reply.code(400).send({
        error: 'url_not_public',
        message: "We can't crawl this address. Use your website's public address.",
      });
    if (err instanceof SourceExistsError)
      return reply.code(409).send({
        error: 'source_exists',
        message: 'This is already a source.',
        sourceId: err.sourceId,
      });
    if (err instanceof UnsupportedFileError)
      return reply.code(400).send({
        error: 'unsupported_type',
        message:
          'Upload a PDF, Word, PowerPoint, text, JPG, PNG, Excel (.xlsx) or CSV file, or a WhatsApp (.txt, .zip) or Telegram (.json) chat export.',
      });
    if (err instanceof BadMappingError)
      return reply.code(400).send({ error: 'bad_mapping', message: err.message });
    if (err instanceof FileTooLargeError)
      return reply
        .code(400)
        .send({ error: 'file_too_large', message: 'Files can be up to 25 MB.' });
    if (err instanceof FileLimitError)
      return reply.code(409).send({
        error: 'file_limit_reached',
        message: "Your plan's file limit is reached.",
      });
    if (err instanceof ConversationClosedError)
      return reply.code(409).send({ error: 'chat_ended', message: 'This chat has ended.' });
    if (err instanceof NotRetryableError)
      return reply.code(409).send({
        error: 'not_retryable',
        message: 'Upload the file again instead.',
      });
    if (
      err instanceof NotFoundError ||
      err instanceof FactNotFoundError ||
      err instanceof FactNotFound ||
      err instanceof SourceNotFoundError ||
      err instanceof CoachingSessionNotFoundError ||
      err instanceof ReplayConversationNotFoundError ||
      err instanceof CorrectionNotFoundError ||
      err instanceof CorrectionReplayNotFoundError ||
      err instanceof UnknownTopicError
    )
      return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    if (err instanceof TokenError)
      return reply.code(401).send({ error: 'unauthorized', message: 'Sign in again' });
    if (err instanceof UnauthenticatedError) {
      if (!err.expired)
        return reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue' });
      return reply
        .clearCookie(SESSION_COOKIE, { path: '/' })
        .code(401)
        .send({ error: 'session_expired', message: 'Your session has ended. Sign in again.' });
    }
    if (err instanceof MfaChallengeError)
      return reply
        .code(401)
        .send({ error: 'mfa_required', message: 'Enter the code from your authenticator app.' });
    if (err instanceof MfaEnrolmentError)
      return reply.code(403).send({
        error: 'mfa_enrolment_required',
        message: 'Your workspace requires two-step verification. Set it up to continue.',
      });
    if (err instanceof ReauthRequiredError)
      return reply.code(403).send({
        error: 'reauth_required',
        message: 'Confirm it’s you to continue.',
        methods: err.methods,
      });
    if (err instanceof MfaCodeError)
      return reply.code(400).send({
        error: 'code_invalid',
        message: "That code didn't work. Check it and try again.",
        ...(err.attemptsLeft !== undefined ? { attemptsLeft: err.attemptsLeft } : {}),
      });
    if (err instanceof MfaLockedError)
      return reply.code(429).send({
        error: 'mfa_locked',
        message: 'Too many wrong codes. Try again later, or use a recovery code.',
        until: err.until.toISOString(),
      });
    if (err instanceof MfaRateLimitError)
      return reply
        .code(429)
        .send({ error: 'too_many_attempts', message: 'Too many tries. Wait 15 minutes.' });
    if (err instanceof MfaStateError)
      return reply.code(err.code === 'no_enrolment' ? 404 : 409).send({
        error: err.code,
        message: MFA_STATE_MESSAGES[err.code],
        ...(err.workspaces ? { workspaces: err.workspaces } : {}),
      });
    if (err instanceof NoWorkspaceError)
      return reply
        .code(403)
        .send({ error: 'no_workspace', message: 'Create your workspace first.' });
    if (err instanceof LinkError)
      return reply.code(400).send({ error: err.code, message: LINK_MESSAGES[err.code] });
    if (err instanceof TermsOutdatedError)
      return reply.code(409).send({
        error: 'terms_outdated',
        message: 'The terms have been updated. Please review them again.',
      });
    if (err instanceof RateLimitedError)
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many sign-in links. Try again in a few minutes.',
      });
    if (err instanceof CoachRateLimitedError)
      return reply.code(429).send({
        error: 'rate_limited',
        message: "You're sending messages quickly. Wait a minute and try again.",
      });
    if (err instanceof ReplayRateLimitedError)
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Replay is going quickly. Wait a minute and it will continue.',
      });
    if (err instanceof ConversationGoneError)
      return reply
        .code(404)
        .send({ error: 'conversation_gone', message: 'This conversation has been deleted.' });
    if (err instanceof ReplayCompleteError)
      return reply
        .code(409)
        .send({ error: 'replay_complete', message: 'Every question has been replayed.' });
    if (err instanceof NothingToReplayError)
      return reply.code(422).send({
        error: 'nothing_to_replay',
        message: 'This conversation has no customer questions to replay.',
      });
    if (err instanceof InvalidCoachBodyError)
      return reply
        .code(422)
        .send({ error: 'invalid_body', message: 'Check the message and try again.' });
    if (err instanceof CorrectionClosedError)
      return reply
        .code(409)
        .send({ error: 'correction_closed', message: 'This change was already decided.' });
    if (err instanceof CorrectionStaleError)
      return reply.code(409).send({
        error: 'correction_stale',
        message: 'This changed since the proposal. Ask again to get a new one.',
      });
    if (err instanceof NotEditableError)
      return reply
        .code(422)
        .send({ error: 'not_editable', message: "This fix can't be edited here." });
    if (err instanceof InvalidQueryError)
      return reply.code(422).send({ error: 'invalid_query', message: 'Check the filters.' });
    if (err instanceof InvalidBodyError)
      return reply
        .code(422)
        .send({ error: 'invalid_body', message: 'Check the values and try again.' });
    if (err instanceof InvalidCorrectionError)
      return reply
        .code(422)
        .send({ error: 'invalid_correction', message: "This change can't be saved as it is." });
    if (err instanceof UnavailableError)
      return reply.code(503).send({ error: 'unavailable', message: 'Try again shortly' });
    if (err instanceof ForbiddenError)
      return reply.code(403).send({ error: 'forbidden', message: 'Not allowed' });
    if (err instanceof VersionConflictError)
      return reply.code(409).send({
        error: 'version_conflict',
        message: req.url.startsWith('/api/v1/kb/sources')
          ? 'This source was changed by someone else'
          : 'This fact was changed by someone else',
      });
    if (err instanceof SettingsConflictError || err instanceof PrivacyConflictError)
      return reply.code(409).send({
        error: 'version_conflict',
        message: 'These settings were changed by someone else',
      });
    if (err instanceof InvalidStateError)
      return reply.code(409).send({ error: 'invalid_state', message: err.message });
    if (err instanceof GstRequiredError)
      return reply
        .code(400)
        .send({ error: 'gst_required', message: 'Choose whether the price includes GST' });
    if (err instanceof PreviewStaleError)
      return reply.code(409).send({
        error: 'preview_stale',
        message: 'Some facts changed since you checked; check the new count',
        preview: toPreview(err.preview),
      });
    if (err instanceof ConflictChangedError)
      return reply.code(409).send({
        error: 'conflict_changed',
        message: 'This conflict changed since you loaded it',
        conflict: err.conflict ? toConflict(err.conflict) : null,
      });
    if (err instanceof EmbeddingUnavailableError)
      return reply
        .code(503)
        .send({ error: 'unavailable', message: 'Saving is unavailable; try again shortly' });
    const rules = rulesErrorReply(err);
    if (rules) return reply.code(rules.status).send(rules.body);
    const team = teamErrorReply(err);
    if (team) return reply.code(team.status).send(team.body);
    const account = accountErrorReply(err);
    if (account) return reply.code(account.status).send(account.body);
    const escalation = escalationErrorReply(err);
    if (escalation) return reply.code(escalation.status).send(escalation.body);
    const notifications = notificationsErrorReply(err);
    if (notifications) return reply.code(notifications.status).send(notifications.body);
    const onboarding = onboardingErrorReply(err);
    if (onboarding) return reply.code(onboarding.status).send(onboarding.body);
    const channel = channelErrorReply(err) ?? emailErrorReply(err) ?? telegramErrorReply(err);
    if (channel) return reply.code(channel.status).send(channel.body);
    const leads = leadsErrorReply(err) ?? leadSettingsErrorReply(err);
    if (leads) return reply.code(leads.status).send(leads.body);
    const widget = widgetErrorReply(err, req.url);
    if (widget) return reply.code(widget.status).send(widget.body);
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  /** Post-commit notification only: the event is already in Postgres (ADR-017). */
  async function notify(channelNames: string[], event: RealtimeEvent) {
    try {
      await Promise.all(channelNames.map((c) => publisher.publish(c, event)));
    } catch (err) {
      deps.logger.warn({ err }, 'publish failed; clients will resume from Postgres');
    }
  }

  // ---- Health (ADR-021) -------------------------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ok = await Promise.all([ping(dashboardDb), ping(visitorDb)]).then(
      (r) => r.every(Boolean),
      () => false,
    );
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
  });

  // ---- Widget API (visitor trust zone) ------------------------------------------------
  // CORS: preflights are answered for any origin (they grant nothing); every real
  // request re-checks the Origin against the tenant's allowed origins (CHN-11).
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/widget/')) return;
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS') {
      reply
        .header('access-control-allow-origin', origin ?? '*')
        .header('access-control-allow-methods', 'GET, POST')
        .header('access-control-allow-headers', 'authorization, content-type, x-kaki-visitor')
        .header('access-control-max-age', '600')
        .header('vary', 'origin')
        .code(204)
        .send();
    }
  });
  app.options('/widget/*', async () => undefined);

  function visitorFrom(req: FastifyRequest, reply: FastifyReply): VisitorClaims {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!token) throw new TokenError('missing token');
    const claims = verifyToken<VisitorClaims>(token, config.VISITOR_TOKEN_SECRET);
    if (req.headers.origin !== claims.o) throw new TokenError('origin mismatch');
    reply.header('access-control-allow-origin', claims.o).header('vary', 'origin');
    return claims;
  }

  app.get('/widget/v1/config', async (req, reply) => {
    const { key } = WidgetConfigQuery.parse(req.query);
    const origin = req.headers.origin;
    const install = await resolveWidgetKey(visitorDb, key);
    // "Not here": the loader stays silent (ADR-016 decision 6). Same response for an
    // unknown key, a wrong origin and a suspended tenant.
    if (!install || install.status !== 'active' || !origin) {
      return reply.code(404).send({ error: 'not_here', message: 'Widget not available here' });
    }
    if (!isAllowedOrigin(origin, install.allowedOrigins)) {
      // UC-05 5a: the install check names the domain that tried (throttled, FEAT-032 D8);
      // the answer is the same silent 404, with no token and no conversation (CHN-11).
      await withTenant(visitorDb, install.tenantId, (tx) =>
        recordRejectedOrigin(tx, install.tenantId, origin),
      );
      return reply.code(404).send({ error: 'not_here', message: 'Widget not available here' });
    }
    const asked = req.headers['x-kaki-visitor'];
    const visitorId =
      typeof asked === 'string' && /^[0-9a-f-]{36}$/i.test(asked) ? asked : randomUUID();
    const token = signToken(
      {
        t: install.tenantId,
        o: origin,
        v: visitorId,
        exp: Math.floor(Date.now() / 1000) + VISITOR_TOKEN_TTL_S,
      },
      config.VISITOR_TOKEN_SECRET,
    );
    // FEAT-024: the tenant's name and greeting, through the visitor zone's function only.
    const { tenantState, theme, privacy, channel, leadCapture } = await withTenant(
      visitorDb,
      install.tenantId,
      async (tx) => {
        // The first load on an allowed origin is the install (ADR-016 decision 6, D8).
        await recordInstallSeen(
          tx,
          install.tenantId,
          new URL(origin).origin,
          install.allowedOrigins,
        );
        return {
          tenantState: await visitorTenantState(tx),
          theme: await visitorWidgetTheme(tx, install.tenantId, key, config.PUBLIC_API_URL),
          privacy: await visitorPrivacy(tx),
          // ONB-10 (FEAT-034): an offline widget still loads, so the install check works.
          channel: await visitorChannel(tx, 'widget'),
          // LED-01, LED-02 (FEAT-049): sent while not live and while paused too (the contact form).
          leadCapture: await leadCaptureConfig(tx),
        };
      },
    );
    const persona = tenantState?.persona;
    reply.header('access-control-allow-origin', origin).header('vary', 'origin');
    return WidgetConfigResponse.parse({
      token,
      visitorId,
      realtimeUrl: config.PUBLIC_REALTIME_URL,
      panelUrl: config.PUBLIC_WIDGET_PANEL_URL,
      botName: persona?.botName ?? DEFAULT_BOT_NAME,
      greeting: {
        en: persona?.greeting.en ?? DEFAULT_GREETING.en,
        zh: persona?.greeting.zh ?? DEFAULT_GREETING.zh,
      },
      theme,
      // GOV-14 (FEAT-058): the tenant's link or the hosted template page.
      privacyNoticeUrl: privacyNoticeUrl(privacy?.notice ?? null, key, config.PUBLIC_API_URL),
      // CHN-13 (FEAT-044 §3): Talk to a person whenever the widget is live and the AI isn't paused.
      controls: { talkToPerson: channel.live && !tenantState?.aiPaused },
      availability: channel.live
        ? { live: true }
        : { live: false, mode: channel.mode, message: channel.message, contact: channel.contact },
      // GOV-08 (FEAT-057 §3): the fallback the turn sends while paused, and the contacts.
      aiPaused: tenantState?.aiPaused
        ? {
            message: {
              en: textsFor('en', persona).fallback,
              zh: textsFor('zh', persona).fallback,
            },
            contact: channel.contact,
          }
        : null,
      leadCapture,
    });
  });

  /** An inbox summary with staff-facing names (owner, escalation assignee) via the identity zone. */
  const summaryFor = (t: string, conversationId: string) =>
    withTenant(visitorDb, t, (tx) =>
      conversationSummary(tx, t, conversationId, (ids) =>
        ids.length
          ? withTenant(deps.identityDb, t, (itx) => memberNames(itx, ids))
          : Promise.resolve(new Map()),
      ),
    );

  app.post('/widget/v1/conversations', async (req, reply) => {
    const v = visitorFrom(req, reply);
    // ONB-10: a channel that isn't live starts no conversation (FEAT-034 §3).
    const conv = await withTenant(visitorDb, v.t, async (tx) =>
      (await visitorChannel(tx, 'widget')).live ? createConversation(tx, v.t, v.v) : null,
    );
    if (!conv)
      return reply.code(409).send({ error: 'not_live', message: "This chat isn't open yet." });
    await notify([channels.inbox(v.t)], {
      type: 'conversation',
      conversation: toSummary(conv, null),
    });
    return reply.code(201).send(CreateConversationResponse.parse({ conversationId: conv.id }));
  });

  app.post<{ Params: { id: string } }>(
    '/widget/v1/conversations/:id/messages',
    async (req, reply) => {
      const v = visitorFrom(req, reply);
      const body = SendMessageBody.parse(req.body);
      const conversationId = req.params.id;
      if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new NotFoundError();
      const result = await withTenant(visitorDb, v.t, (tx) =>
        appendVisitorMessage(tx, {
          tenantId: v.t,
          conversationId,
          visitorId: v.v,
          text: body.text,
          clientMessageId: body.clientMessageId,
        }),
      );
      const message = toMessage(result.message);
      if (result.created) {
        await notify([channels.conversation(v.t, conversationId), channels.inbox(v.t)], {
          type: 'message',
          message,
        });
        // The inbox row keeps its owner (FEAT-043 §5.3) and open escalation (FEAT-044).
        const summary =
          (await summaryFor(v.t, conversationId)) ?? toSummary(result.conversation, message.body);
        await notify([channels.inbox(v.t)], { type: 'conversation', conversation: summary });
      }
      return reply.code(result.created ? 201 : 200).send(SendMessageResponse.parse({ message }));
    },
  );

  // CHN-13 (FEAT-033 §3): the visitor ends their chat; idempotent, so a retry is 200 too.
  app.post<{ Params: { id: string } }>('/widget/v1/conversations/:id/end', async (req, reply) => {
    const v = visitorFrom(req, reply);
    const conversationId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new NotFoundError();
    const result = await withTenant(visitorDb, v.t, async (tx) => {
      const ended = await endVisitorConversation(tx, {
        tenantId: v.t,
        conversationId,
        visitorId: v.v,
      });
      if (!ended.ended) return null;
      const [last] = await recentMessages(tx, {
        tenantId: v.t,
        conversationId,
        upToSeq: Number.MAX_SAFE_INTEGER,
        limit: 1,
      });
      return toSummary(ended.conversation, last?.body ?? null);
    });
    if (result) await notify([channels.inbox(v.t)], { type: 'conversation', conversation: result });
    return EndConversationResponse.parse({ status: 'closed' });
  });

  // CHN-13, INB-05 (FEAT-044 §5.6, D8): Talk to a person. No model: the button is a
  // deterministic intent; routing, the alert and the notice come from inbox.
  app.post<{ Params: { id: string } }>(
    '/widget/v1/conversations/:id/escalate',
    async (req, reply) => {
      const v = visitorFrom(req, reply);
      const conversationId = req.params.id;
      if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new NotFoundError();
      const result = await withTenant(visitorDb, v.t, async (tx) => {
        const conv = await getConversation(tx, v.t, conversationId);
        if (!conv || conv.visitorId !== v.v) throw new NotFoundError('conversation not found');
        const tenant = await visitorTenantState(tx);
        return requestEscalation(tx, {
          tenantId: v.t,
          conversationId,
          source: 'visitor_button',
          hours: tenant
            ? {
                hours: tenant.hours,
                openOnPublicHolidays: tenant.openOnPublicHolidays,
                holidays: tenant.holidays,
              }
            : null,
          noticeText: (n) => escalationNotice(n.language, n.afterHours, n.nextOpen, n.now),
          log: req.log,
        });
      });
      const notice = result.notice ? toMessage(result.notice) : null;
      if (notice)
        await notify([channels.conversation(v.t, conversationId), channels.inbox(v.t)], {
          type: 'message',
          message: notice,
        });
      if (result.status !== 'with_person') {
        const summary = await summaryFor(v.t, conversationId);
        if (summary)
          await notify([channels.inbox(v.t)], { type: 'conversation', conversation: summary });
      }
      return EscalateResponse.parse({ status: result.status, notice });
    },
  );

  // LED-01, LED-02 (FEAT-049 §5.4): the consent card, the lead form and the contact form.
  registerLeadWidgetRoutes(app, deps, visitorFrom, notify, summaryFor);

  // ---- Dashboard API (dashboard trust zone) -------------------------------------------
  const { authFrom, sessionFrom, meOf } = registerAuth(app, deps);
  registerMfaRoutes(app, deps, { authFrom, sessionFrom });

  registerInboxRoutes(app, deps, sessionFrom, notify);
  registerApprovalRoutes(app, deps, sessionFrom, notify);
  registerApprovalLinkRoutes(app, deps);
  registerFactRoutes(app, deps, sessionFrom);
  registerReviewRoutes(app, deps, sessionFrom);
  registerConflictRoutes(app, deps, sessionFrom);
  registerSourceRoutes(app, deps, sessionFrom, { resolve: deps.resolve });
  registerUploadRoutes(app, deps, sessionFrom);
  registerSettingsRoutes(app, deps, sessionFrom);
  registerCoachRoutes(app, deps, sessionFrom);
  registerCorrectionRoutes(app, deps, sessionFrom);
  registerCoverageRoutes(app, deps, sessionFrom);
  registerWidgetRoutes(app, deps, sessionFrom);
  registerPrivacyRoutes(app, deps, sessionFrom);
  registerChannelRoutes(app, deps, sessionFrom);
  registerEmailChannelRoutes(app, deps, sessionFrom);
  registerTelegramChannelRoutes(app, deps, sessionFrom);
  registerHookRoutes(app, deps);
  registerAiRoutes(app, deps, sessionFrom, notify);
  registerRuleRoutes(app, deps, sessionFrom);
  registerOnboardingRoutes(app, deps, sessionFrom);
  registerTeamRoutes(app, deps, { authFrom, sessionFrom, meOf });
  registerAccountRoutes(app, deps, { authFrom });
  registerNotificationRoutes(app, deps, sessionFrom);
  registerEscalationRoutes(app, deps, sessionFrom);
  registerLeadSettingsRoutes(app, deps, sessionFrom);
  registerLeadRoutes(app, deps, sessionFrom);

  return app;
}
