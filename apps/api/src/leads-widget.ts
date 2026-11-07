import { visitorChannel } from '@kaki/channels';
import {
  ConsentBody,
  ConsentResponse,
  ContactFormBody,
  ContactFormResponse,
  LeadSubmitBody,
  LeadSubmitResponse,
  WithdrawBody,
  WithdrawResponse,
  type ConversationSummary,
  type RealtimeEvent,
} from '@kaki/contracts';
import { withTenant, type Tx } from '@kaki/db';
import { getConversation, NotFoundError, toMessage, type MessageRow } from '@kaki/inbox';
import {
  captureLead,
  ConsentRequired,
  LeadFieldsInvalid,
  NotCapturing,
  recordConsent,
  ScopeNotOffered,
  submitContactForm,
  withdrawInChat,
  WithdrawCardNotFound,
  WordingChanged,
} from '@kaki/leads';
import { channels } from '@kaki/platform';
import { visitorTenantState } from '@kaki/tenancy';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App, Deps } from './server.js';

interface VisitorClaims {
  t: string;
  v: string;
}

/** The lead routes' errors (FEAT-049 §3): 409 with a code, 422 with per-field codes. */
export function leadsErrorReply(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof WordingChanged)
    return {
      status: 409,
      body: {
        error: 'wording_changed',
        message: 'The wording changed. Please read it again.',
        leadCapture: err.config,
      },
    };
  if (err instanceof ConsentRequired)
    return {
      status: 409,
      body: {
        error: 'consent_required',
        message: 'Please agree to how your details are used first.',
      },
    };
  if (err instanceof NotCapturing)
    return {
      status: 409,
      body: { error: 'not_capturing', message: "This business isn't taking details here." },
    };
  if (err instanceof LeadFieldsInvalid) return { status: 422, body: { ...err.body } };
  // FEAT-051 §3: "just stop offers" on a contact who never agreed to offers.
  if (err instanceof ScopeNotOffered)
    return {
      status: 422,
      body: { error: 'scope_not_offered', message: 'There are no offers to stop.' },
    };
  if (err instanceof WithdrawCardNotFound)
    return { status: 404, body: { error: 'not_found', message: 'Not found' } };
  return null;
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Consent and lead capture from the widget (LED-01, LED-02, LED-08, LED-09; FEAT-049 §3, §5.4):
 * the consent card's answer, the lead form's submit, and the fallback contact form. Each runs
 * in one visitor-zone transaction; the tenant and visitor come from the widget token. Field
 * values are never logged.
 */
export function registerLeadWidgetRoutes(
  app: App,
  deps: Deps,
  visitorFrom: (req: FastifyRequest, reply: FastifyReply) => VisitorClaims,
  notify: (channelNames: string[], event: RealtimeEvent) => Promise<void>,
  summaryFor: (tenantId: string, conversationId: string) => Promise<ConversationSummary | null>,
): void {
  const { visitorDb } = deps;

  /** 404 unless the conversation is this visitor's (the escalate route's check). */
  const ownConversation = async (tx: Tx, v: VisitorClaims, id: string) => {
    if (!UUID.test(id)) throw new NotFoundError('conversation not found');
    const conv = await getConversation(tx, v.t, id);
    if (!conv || conv.visitorId !== v.v) throw new NotFoundError('conversation not found');
    return conv;
  };

  /** The notice and the inbox row after a capture (the sidebar refetches on the event). */
  const publish = async (
    t: string,
    conversationId: string | null,
    captured: { notice: MessageRow | null },
  ) => {
    if (!conversationId || !captured.notice) return null;
    const notice = toMessage(captured.notice);
    await notify([channels.conversation(t, conversationId), channels.inbox(t)], {
      type: 'message',
      message: notice,
    });
    const summary = await summaryFor(t, conversationId);
    if (summary) await notify([channels.inbox(t)], { type: 'conversation', conversation: summary });
    return notice;
  };

  app.post<{ Params: { id: string } }>(
    '/widget/v1/conversations/:id/consent',
    async (req, reply) => {
      const v = visitorFrom(req, reply);
      const body = ConsentBody.parse(req.body);
      const out = await withTenant(visitorDb, v.t, async (tx) => {
        await ownConversation(tx, v, req.params.id);
        return recordConsent(tx, {
          tenantId: v.t,
          conversationId: req.params.id,
          purposeWordingId: body.purposeWordingId,
          agreed: body.agreed,
          marketing: body.marketing,
        });
      });
      return reply.code(201).send(ConsentResponse.parse({ consentId: out.consentId }));
    },
  );

  app.post<{ Params: { id: string } }>('/widget/v1/conversations/:id/lead', async (req, reply) => {
    const v = visitorFrom(req, reply);
    const body = LeadSubmitBody.parse(req.body);
    const conversationId = req.params.id;
    const captured = await withTenant(visitorDb, v.t, async (tx) => {
      await ownConversation(tx, v, conversationId);
      return captureLead(tx, {
        tenantId: v.t,
        conversationId,
        consentId: body.consentId,
        input: body.fields,
      });
    });
    const notice = await publish(v.t, conversationId, captured);
    return reply
      .code(captured.status === 'created' ? 201 : 200)
      .send(LeadSubmitResponse.parse({ status: captured.status, notice }));
  });

  // LED-07 (FEAT-051 §5.4; AC-3, AC-4): the withdraw card's confirm button. The contact comes from
  // the conversation (D2); a repeat writes nothing and stores no second notice.
  app.post<{ Params: { id: string } }>(
    '/widget/v1/conversations/:id/withdraw',
    async (req, reply) => {
      const v = visitorFrom(req, reply);
      const body = WithdrawBody.parse(req.body);
      const conversationId = req.params.id;
      const out = await withTenant(visitorDb, v.t, async (tx) => {
        await ownConversation(tx, v, conversationId);
        return withdrawInChat(tx, {
          tenantId: v.t,
          conversationId,
          messageId: body.messageId,
          scope: body.scope,
        });
      });
      const notice = await publish(v.t, conversationId, out);
      return reply.code(201).send(WithdrawResponse.parse({ status: out.status, notice }));
    },
  );

  // SCR-WGT-005 (GOV-08 "with lead capture"; UX-R4): while paused, or before go-live in
  // message mode, the fallback screen's contact form. A live, running widget uses the chat.
  app.post('/widget/v1/contact', async (req, reply) => {
    const v = visitorFrom(req, reply);
    const body = ContactFormBody.parse(req.body);
    const conversationId = body.conversationId ?? null;
    const captured = await withTenant(visitorDb, v.t, async (tx) => {
      if (conversationId) await ownConversation(tx, v, conversationId);
      const channel = await visitorChannel(tx, 'widget');
      const paused = (await visitorTenantState(tx))?.aiPaused ?? false;
      if (channel.live && !paused) throw new NotCapturing('the chat is open');
      return submitContactForm(tx, {
        tenantId: v.t,
        conversationId,
        purposeWordingId: body.purposeWordingId,
        marketing: body.marketing,
        input: body.fields,
      });
    });
    await publish(v.t, conversationId, captured);
    return reply
      .code(captured.status === 'created' ? 201 : 200)
      .send(ContactFormResponse.parse({ status: captured.status }));
  });
}
