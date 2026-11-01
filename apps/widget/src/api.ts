import type { EscalateResponse, Message } from '@kaki/contracts';

/** The conversation is closed (409 `chat_ended`, FEAT-033 D5): the panel shows it ended. */
export class ChatEndedError extends Error {
  constructor() {
    super('chat_ended');
  }
}

/** Widget → api calls. Plain fetch, no credentials: the visitor token is the only auth. */
export function createApi(apiUrl: string, token: string) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
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
    async send(conversationId: string, text: string, clientMessageId: string): Promise<Message> {
      const r = await fetch(`${apiUrl}/widget/v1/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, clientMessageId }),
        credentials: 'omit',
      });
      if (r.status === 409) throw new ChatEndedError();
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
      if (r.status === 409) throw new ChatEndedError();
      if (!r.ok) throw new Error(`escalate: ${r.status}`);
      return (await r.json()) as EscalateResponse;
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
