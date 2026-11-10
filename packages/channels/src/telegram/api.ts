/**
 * A minimal Telegram Bot API client over `fetch` (FEAT-037 §5.1; no SDK). Plain text only
 * (no `parse_mode`, so nothing needs escaping) and no link previews. The token appears only
 * in the request path built here and never in an error, a log line or a result
 * (`redactBotToken` is the logger's backstop).
 */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_TIMEOUT_MS = 10_000;

export interface TelegramApiOptions {
  base?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** How a failed call counts for retries and health (FEAT-037 §5.1). */
export interface TelegramFailure {
  failed: 'auth' | 'transient' | 'permanent';
  status?: number | undefined;
  /** The customer (or the member) blocked the bot: `permanent`, never `auth`. */
  blocked?: boolean | undefined;
  /** Seconds Telegram asked us to wait (429). */
  retryAfter?: number | undefined;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly failure: TelegramFailure,
  ) {
    super(`telegram ${method}: ${failure.status ?? 'network'} ${failure.failed}`);
  }
}

const BLOCKED = /blocked by the user|user is deactivated|bot was kicked|bot can't initiate/i;

/** Telegram's error → retry class. 401/404 on the token are `auth` (revoked or wrong). */
export function classifyTelegram(
  status: number,
  description = '',
  retryAfter?: number,
): TelegramFailure {
  if (status === 401 || status === 404) return { failed: 'auth', status };
  if (status === 403)
    return BLOCKED.test(description)
      ? { failed: 'permanent', status, blocked: true }
      : { failed: 'permanent', status };
  if (status === 429) return { failed: 'transient', status, retryAfter };
  if (status >= 500) return { failed: 'transient', status };
  return { failed: 'permanent', status };
}

/** `/bot<id>:<secret>/` anywhere in a string (a URL in an error) → `/bot[redacted]/`. */
export function redactBotToken(s: string): string {
  return s.replace(/bot\d{3,}:[A-Za-z0-9_-]{10,}/g, 'bot[redacted]');
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string | undefined;
}

export interface WebhookInfo {
  url: string;
  pending_update_count?: number;
  last_error_message?: string;
}

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  setWebhook(p: { url: string; secretToken: string }): Promise<void>;
  deleteWebhook(): Promise<void>;
  getWebhookInfo(): Promise<WebhookInfo>;
  /** → Telegram's message ID. */
  sendMessage(chatId: number, text: string): Promise<number>;
  leaveChat(chatId: number): Promise<void>;
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function telegramApi(token: string, opts: TelegramApiOptions = {}): TelegramApi {
  const base = (opts.base ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TELEGRAM_TIMEOUT_MS;

  async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TelegramApiError(method, { failed: 'transient' });
    }
    let env: Envelope;
    try {
      env = (await res.json()) as Envelope;
    } catch {
      throw new TelegramApiError(method, classifyTelegram(res.ok ? 502 : res.status));
    }
    if (!res.ok || !env.ok)
      throw new TelegramApiError(
        method,
        classifyTelegram(
          env.error_code ?? res.status,
          env.description,
          env.parameters?.retry_after,
        ),
      );
    return env.result as T;
  }

  return {
    getMe: () => call<TelegramUser>('getMe'),
    async setWebhook({ url, secretToken }) {
      await call('setWebhook', {
        url,
        secret_token: secretToken,
        allowed_updates: ['message', 'my_chat_member'],
        max_connections: 10,
      });
    },
    async deleteWebhook() {
      await call('deleteWebhook', { drop_pending_updates: false });
    },
    getWebhookInfo: () => call<WebhookInfo>('getWebhookInfo'),
    async sendMessage(chatId, text) {
      const m = await call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
      });
      return m.message_id;
    },
    async leaveChat(chatId) {
      await call('leaveChat', { chat_id: chatId });
    },
  };
}
