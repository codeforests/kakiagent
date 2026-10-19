import type { Message } from '@kaki/contracts';

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
      if (!r.ok) throw new Error(`send: ${r.status}`);
      return ((await r.json()) as { message: Message }).message;
    },
  };
}

/** Merge by id and keep `seq` order; SSE replays and POST responses can overlap. */
export function mergeMessages(list: Message[], incoming: Message): Message[] {
  if (list.some((m) => m.id === incoming.id)) return list;
  return [...list, incoming].sort((a, b) => a.seq - b.seq);
}
