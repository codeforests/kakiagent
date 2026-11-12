import type {
  ConsentBody,
  ConsentResponse,
  ContactFormBody,
  ContactFormResponse,
  EscalateResponse,
  HandoffBody,
  HandoffError,
  HandoffResponse,
  LeadConflict,
  LeadFieldErrors,
  LeadSubmitBody,
  LeadSubmitResponse,
  Message,
  WithdrawBody,
  WithdrawResponse,
} from '@kaki/contracts';

/** The conversation is closed (409 `chat_ended`, FEAT-033 D5): the panel shows it ended. */
export class ChatEndedError extends Error {
  constructor() {
    super('chat_ended');
  }
}

/** The chat continues on another channel (409 `moved`, FEAT-038 AC-8). */
export class MovedError extends Error {
  constructor(readonly channel: 'telegram' | 'email') {
    super('moved');
  }
}

/** A 409 body: `moved` with its channel, else the chat ended. */
async function conflictOf(r: Response): Promise<Error> {
  const body = (await r.json().catch(() => null)) as Partial<HandoffError> | null;
  if (body?.error === 'moved' && (body.channel === 'telegram' || body.channel === 'email'))
    return new MovedError(body.channel);
  return new ChatEndedError();
}

/** The handoff route's answer (FEAT-038 §3): the link or masked address, or the error code. */
export type HandoffResult =
  | { ok: true; data: HandoffResponse }
  | { ok: false; error: HandoffError['error'] | 'failed'; channel?: 'telegram' | 'email' };

/**
 * A lead route's answer (FEAT-049 §3): the body, or a 422 with per-field codes, or a 409
 * (`wording_changed` with the current config, `consent_required`, `not_capturing`). Anything
 * else throws, and the card shows its failed state.
 */
export type LeadResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 422; body: LeadFieldErrors }
  | { ok: false; status: 409; body: LeadConflict };

/** Widget → api calls. Plain fetch, no credentials: the visitor token is the only auth. */
export function createApi(apiUrl: string, token: string) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  async function leadPost<T>(path: string, body: unknown): Promise<LeadResult<T>> {
    const r = await fetch(`${apiUrl}/widget/v1/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'omit',
    });
    if (r.ok) return { ok: true, data: (await r.json()) as T };
    if (r.status === 422)
      return { ok: false, status: 422, body: (await r.json()) as LeadFieldErrors };
    if (r.status === 409) return { ok: false, status: 409, body: (await r.json()) as LeadConflict };
    throw new Error(`${path}: ${r.status}`);
  }
  return {
    /** The consent card's answer (SCR-WGT-003); `consentId` is null when declined. */
    consent: (conversationId: string, body: ConsentBody) =>
      leadPost<ConsentResponse>(`conversations/${conversationId}/consent`, body),
    /** The lead form; the response carries the stored `lead_captured` notice. */
    submitLead: (conversationId: string, body: LeadSubmitBody) =>
      leadPost<LeadSubmitResponse>(`conversations/${conversationId}/lead`, body),
    /** The fallback contact form (SCR-WGT-005): consent and details in one request. */
    submitContact: (body: ContactFormBody) => leadPost<ContactFormResponse>('contact', body),
    /** The withdraw card's answer (SCR-WGT-003 withdrawn; FEAT-051 §3); idempotent. */
    async withdraw(conversationId: string, body: WithdrawBody): Promise<WithdrawResponse> {
      const r = await fetch(`${apiUrl}/widget/v1/conversations/${conversationId}/withdraw`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'omit',
      });
      if (!r.ok) throw new Error(`withdraw: ${r.status}`);
      return (await r.json()) as WithdrawResponse;
    },
    /** The tracking prompt's answer (SCR-WGT-007); the caller keeps the choice even on failure. */
    async trackingChoice(choice: 'accepted' | 'declined'): Promise<void> {
      const r = await fetch(`${apiUrl}/widget/v1/tracking-choice`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ choice }),
        credentials: 'omit',
      });
      if (!r.ok) throw new Error(`tracking-choice: ${r.status}`);
    },
    async createConversation(): Promise<string> {
      const r = await fetch(`${apiUrl}/widget/v1/conversations`, {
        method: 'POST',
        headers,
        body: '{}',
        credentials: 'omit',
      });
      if (!r.ok) throw new Error(`create conversation: ${r.status}`);
      return ((await r.json()) as { conversationId: string }).conversationId;
    },
    /** `page`: the path the visitor is on (FEAT-029 D2), sent in every tracking mode. */
    async send(
      conversationId: string,
      text: string,
      clientMessageId: string,
      page?: string,
    ): Promise<Message> {
      const r = await fetch(`${apiUrl}/widget/v1/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(page ? { text, clientMessageId, page } : { text, clientMessageId }),
        credentials: 'omit',
      });
      if (r.status === 409) throw await conflictOf(r);
      if (!r.ok) throw new Error(`send: ${r.status}`);
      return ((await r.json()) as { message: Message }).message;
    },
    /** Ask for a person (FEAT-044 §3); a repeat is `already_escalated` with no notice. */
    async escalate(conversationId: string): Promise<EscalateResponse> {
      const r = await fetch(`${apiUrl}/widget/v1/conversations/${conversationId}/escalate`, {
        method: 'POST',
        headers: { authorization: headers.authorization },
        credentials: 'omit',
      });
      if (r.status === 409) throw await conflictOf(r);
      if (!r.ok) throw new Error(`escalate: ${r.status}`);
      return (await r.json()) as EscalateResponse;
    },
    /** Continue elsewhere (SCR-WGT-004); errors and network failures come back as values. */
    async handoff(conversationId: string, body: HandoffBody): Promise<HandoffResult> {
      try {
        const r = await fetch(`${apiUrl}/widget/v1/conversations/${conversationId}/handoff`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          credentials: 'omit',
        });
        if (r.ok) return { ok: true, data: (await r.json()) as HandoffResponse };
        const err = (await r.json().catch(() => null)) as Partial<HandoffError> | null;
        const known = [409, 422, 429].includes(r.status) && err?.error;
        return known
          ? { ok: false, error: err.error!, ...(err.channel && { channel: err.channel }) }
          : { ok: false, error: 'failed' };
      } catch {
        return { ok: false, error: 'failed' };
      }
    },
    /** Idempotent (FEAT-033 §3): a second end is still 200. */
    async endConversation(conversationId: string): Promise<void> {
      const r = await fetch(`${apiUrl}/widget/v1/conversations/${conversationId}/end`, {
        method: 'POST',
        headers: { authorization: headers.authorization },
        credentials: 'omit',
      });
      if (!r.ok) throw new Error(`end: ${r.status}`);
    },
  };
}

/** Merge by id and keep `seq` order; SSE replays and POST responses can overlap. */
export function mergeMessages(list: Message[], incoming: Message): Message[] {
  if (list.some((m) => m.id === incoming.id)) return list;
  return [...list, incoming].sort((a, b) => a.seq - b.seq);
}
