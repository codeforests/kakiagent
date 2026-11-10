/**
 * A fake Telegram Bot API as a `fetch` (test-only; `@kaki/channels/telegram-fake`, FEAT-037
 * §5.6). Tokens `<id>:fixture…` are valid, any token containing `revoked` (or revoked with
 * `revoke`) answers 401. It records webhooks, sends and leaves.
 */
export interface FakeSent {
  botId: number;
  method: 'sendMessage' | 'leaveChat';
  chatId: number;
  text?: string;
}

export interface FakeBotApi {
  base: string;
  fetch: typeof fetch;
  sent: FakeSent[];
  webhooks: Map<number, { url: string; secret: string }>;
  /** Chats that blocked the bot: sends there answer 403. */
  blocked: Set<number>;
  revoke(token: string): void;
  /** The next call of `method` answers this status (once). */
  failNext(method: string, status: number, description?: string, retryAfter?: number): void;
  /** Point a bot's webhook somewhere else (someone else's server). */
  setForeignWebhook(botId: number, url: string): void;
  calls: string[];
}

export function fakeBotApi(base = 'http://telegram-fake.test'): FakeBotApi {
  const revoked = new Set<string>();
  const failures = new Map<string, { status: number; description: string; retryAfter?: number }>();
  let nextId = 1;
  const state: FakeBotApi = {
    base,
    sent: [],
    webhooks: new Map(),
    blocked: new Set(),
    calls: [],
    revoke: (token) => void revoked.add(token),
    failNext(method, status, description = 'Error', retryAfter) {
      failures.set(method, { status, description, ...(retryAfter ? { retryAfter } : {}) });
    },
    setForeignWebhook(botId, url) {
      state.webhooks.set(botId, { url, secret: 'foreign' });
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const m = url.pathname.match(/^\/bot(\d+):([^/]+)\/(\w+)$/);
      const error = (status: number, description: string, retryAfter?: number) =>
        Response.json(
          {
            ok: false,
            error_code: status,
            description,
            ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
          },
          { status },
        );
      if (!m) return error(404, 'Not Found');
      const [, id, secret, method] = m as unknown as [string, string, string, string];
      const token = `${id}:${secret}`;
      const botId = Number(id);
      state.calls.push(method);
      if (revoked.has(token) || secret.includes('revoked') || !secret.startsWith('fixture'))
        return error(401, 'Unauthorized');
      const fail = failures.get(method);
      if (fail) {
        failures.delete(method);
        return error(fail.status, fail.description, fail.retryAfter);
      }
      const p = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const ok = (result: unknown) => Response.json({ ok: true, result });
      switch (method) {
        case 'getMe':
          return ok({
            id: botId,
            is_bot: true,
            first_name: 'Kaki Bot',
            username: `kaki_${id}_bot`,
          });
        case 'setWebhook':
          state.webhooks.set(botId, { url: String(p.url), secret: String(p.secret_token) });
          return ok(true);
        case 'deleteWebhook':
          state.webhooks.delete(botId);
          return ok(true);
        case 'getWebhookInfo':
          return ok({ url: state.webhooks.get(botId)?.url ?? '', pending_update_count: 0 });
        case 'sendMessage': {
          const chatId = Number(p.chat_id);
          if (state.blocked.has(chatId))
            return error(403, 'Forbidden: bot was blocked by the user');
          state.sent.push({ botId, method, chatId, text: String(p.text) });
          return ok({ message_id: nextId++, chat: { id: chatId }, date: 0, text: p.text });
        }
        case 'leaveChat':
          state.sent.push({ botId, method, chatId: Number(p.chat_id) });
          return ok(true);
        default:
          return error(404, 'Not Found: method not found');
      }
    },
  };
  return state;
}

/** A token the fake accepts for bot `id`. */
export const fixtureToken = (id: number, suffix = 'a') => `${id}:fixture${suffix.padEnd(30, 'x')}`;
