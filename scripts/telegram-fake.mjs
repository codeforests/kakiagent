#!/usr/bin/env node
// A local stand-in for the Telegram Bot API (FEAT-037 T11; `pnpm fixtures:telegram`, :5177).
// The api, agent-worker and scheduler reach it through TELEGRAM_API_BASE (gen-local-env.mjs).
// Same token rules as `@kaki/channels/telegram-fake`: `<id>:fixture…` is valid; a token that
// contains `revoked`, or was revoked through `/_fake/revoke`, answers 401.
//
// Test controls (E2E only):
//   POST /_fake/update  { botId, update }  → delivers `update` to the bot's webhook with its
//                                            secret header; answers { status } from the hook
//   GET  /_fake/sent?botId=<id>            → [{ method, chatId, text }] for that bot
//   POST /_fake/revoke  { token }          → that token answers 401 from now on
//   POST /_fake/block   { chatId }         → sends to that chat answer 403
//   GET  /healthz
import { createServer } from 'node:http';

const PORT = Number(process.env.TELEGRAM_FAKE_PORT ?? 5177);
const webhooks = new Map(); // botId → { url, secret }
const sent = []; // { botId, method, chatId, text }
const revoked = new Set();
const blocked = new Set();
let nextId = 1;

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const ok = (res, result) => send(res, 200, { ok: true, result });
const fail = (res, status, description) =>
  send(res, status, { ok: false, error_code: status, description });

async function botApi(req, res, botId, secret, method) {
  const token = `${botId}:${secret}`;
  if (revoked.has(token) || secret.includes('revoked') || !secret.startsWith('fixture'))
    return fail(res, 401, 'Unauthorized');
  const p = await readBody(req);
  switch (method) {
    case 'getMe':
      return ok(res, {
        id: botId,
        is_bot: true,
        first_name: 'Kaki Bot',
        username: `kaki_${botId}_bot`,
      });
    case 'setWebhook':
      webhooks.set(botId, { url: String(p.url), secret: String(p.secret_token) });
      return ok(res, true);
    case 'deleteWebhook':
      webhooks.delete(botId);
      return ok(res, true);
    case 'getWebhookInfo':
      return ok(res, { url: webhooks.get(botId)?.url ?? '', pending_update_count: 0 });
    case 'sendMessage': {
      const chatId = Number(p.chat_id);
      if (blocked.has(chatId)) return fail(res, 403, 'Forbidden: bot was blocked by the user');
      sent.push({ botId, method, chatId, text: String(p.text) });
      return ok(res, { message_id: nextId++, chat: { id: chatId }, date: 0, text: p.text });
    }
    case 'leaveChat':
      sent.push({ botId, method, chatId: Number(p.chat_id) });
      return ok(res, true);
    default:
      return fail(res, 404, 'Not Found: method not found');
  }
}

async function control(req, res, url) {
  if (url.pathname === '/_fake/sent') {
    const botId = Number(url.searchParams.get('botId'));
    return send(
      res,
      200,
      sent.filter((s) => !botId || s.botId === botId),
    );
  }
  const p = await readBody(req);
  if (url.pathname === '/_fake/revoke') {
    revoked.add(String(p.token));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/_fake/block') {
    blocked.add(Number(p.chatId));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/_fake/update') {
    const hook = webhooks.get(Number(p.botId));
    if (!hook) return send(res, 404, { error: 'no_webhook' });
    const r = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': hook.secret,
      },
      body: JSON.stringify(p.update),
    });
    return send(res, 200, { status: r.status });
  }
  return send(res, 404, { error: 'not_found' });
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (url.pathname.startsWith('/_fake/'))
    return void control(req, res, url).catch((e) => send(res, 502, { error: String(e) }));
  const m = url.pathname.match(/^\/bot(\d+):([^/]+)\/(\w+)$/);
  if (!m) return fail(res, 404, 'Not Found');
  void botApi(req, res, Number(m[1]), m[2], m[3]).catch(() => fail(res, 500, 'Internal'));
  // Every interface: TELEGRAM_API_BASE says `localhost`, which may resolve to ::1 or 127.0.0.1.
}).listen(PORT, () => console.log(`telegram fake on http://localhost:${PORT}`));
