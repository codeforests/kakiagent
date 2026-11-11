/**
 * Channel handoff (CHN-07, UC-26; FEAT-038 §3, §5.2, §5.4): the widget's handoff route and the
 * email confirm page. The page's GET never consumes the link (mail scanners prefetch links,
 * D3); its POST is a same-origin form post that proves the address.
 */
import { DEFAULT_BOT_NAME } from '@kaki/agent';
import { confirmCodeTenant, confirmEmailHandoff, viewEmailHandoff } from '@kaki/channels/handoff';
import { withTenant, type Tx } from '@kaki/db';
import * as inbox from '@kaki/inbox';
import { channels } from '@kaki/platform';
import { visitorTenantState } from '@kaki/tenancy';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NOTICE_HEADERS, noticeCss } from './privacy.js';
import type { App, Deps } from './server.js';

const CODE = /^e-[A-Za-z0-9_-]{43}$/;

const PAGE_HEADERS = {
  ...NOTICE_HEADERS,
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

const PAGE_CSS = `
form { margin-top: var(--space-6); }
button { font: inherit; padding: var(--space-2) var(--space-4); border: 0; border-radius: var(--radius-md); background: var(--color-accent-default); color: var(--color-text-on-accent); cursor: pointer; min-height: 44px; }
button:hover { background: var(--color-accent-hover); }
button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
`;

const COPY = {
  en: {
    title: 'Continue by email',
    ask: (b: string, to: string) => `Continue your chat with ${b} by email at ${to}?`,
    why: "We'll use this email only to continue this chat.",
    button: 'Continue by email',
    doneTitle: "You're all set",
    done: (to: string) =>
      `Your chat continues by email. We've sent the conversation so far to ${to}.`,
    expiredTitle: 'This link has expired',
    expired: 'Go back to the chat on the website and ask again.',
  },
  zh: {
    title: '通过电子邮件继续',
    ask: (b: string, to: string) => `通过 ${to} 继续与${b}的聊天？`,
    why: '我们只会用这个电子邮件地址继续本次聊天。',
    button: '通过电子邮件继续',
    doneTitle: '已完成',
    done: (to: string) => `您的聊天将通过电子邮件继续。我们已将目前的对话发送到 ${to}。`,
    expiredTitle: '此链接已过期',
    expired: '请返回网站上的聊天窗口重新提出请求。',
  },
} as const;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let css: string | null = null;
function page(lang: 'en' | 'zh', title: string, body: string): string {
  css ??= `${noticeCss()}\n${PAGE_CSS}`;
  return `<!doctype html><html lang="${lang === 'zh' ? 'zh-Hans' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
const expiredPage = (lang: 'en' | 'zh' = 'en') =>
  page(lang, COPY[lang].expiredTitle, `<p>${esc(COPY[lang].expired)}</p>`);

async function businessTexts(tx: Tx) {
  const tenant = await visitorTenantState(tx);
  return {
    businessName: tenant?.businessName ?? 'Our team',
    assistantName: tenant?.persona?.botName ?? DEFAULT_BOT_NAME,
  };
}

export function registerHandoffRoutes(app: App, deps: Deps): void {
  const { config, visitorDb, publisher } = deps;
  const ownOrigin = new URL(config.PUBLIC_API_URL).origin;
  const html = (reply: FastifyReply, status: number, body: string) =>
    reply.code(status).headers(PAGE_HEADERS).send(body);

  // The confirm form posts urlencoded; its fields are ignored (the code is in the path).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_req, _body, done) => done(null, {}),
  );

  const tenantOf = async (code: string) =>
    CODE.test(code) ? confirmCodeTenant(visitorDb, code) : null;

  app.get<{ Params: { code: string } }>('/continue/:code', async (req, reply) => {
    const code = req.params.code;
    const tenantId = await tenantOf(code);
    if (!tenantId) return html(reply, 410, expiredPage());
    const view = await withTenant(visitorDb, tenantId, async (tx) => {
      const v = await viewEmailHandoff(tx, {
        tenantId,
        code,
        secret: config.HANDOFF_LINK_SECRET,
        now: new Date(),
      });
      return v ? { ...v, ...(await businessTexts(tx)) } : null;
    });
    if (!view) return html(reply, 410, expiredPage());
    const c = COPY[view.language];
    return html(
      reply,
      200,
      page(
        view.language,
        c.title,
        `<p>${esc(c.ask(view.businessName, view.sentTo))}</p><p class="subtitle">${esc(c.why)}</p>` +
          `<form method="post" action="/continue/${esc(code)}"><button type="submit">${esc(c.button)}</button></form>`,
      ),
    );
  });

  const sameOrigin = (req: FastifyRequest) => {
    const origin = req.headers.origin ?? req.headers.referer;
    if (typeof origin !== 'string') return false;
    try {
      return new URL(origin).origin === ownOrigin;
    } catch {
      return false;
    }
  };

  app.post<{ Params: { code: string } }>('/continue/:code', async (req, reply) => {
    if (!sameOrigin(req))
      return reply.code(403).send({ error: 'forbidden', message: 'Wrong origin.' });
    const code = req.params.code;
    const tenantId = await tenantOf(code);
    if (!tenantId) return html(reply, 410, expiredPage());
    const done = await withTenant(visitorDb, tenantId, async (tx) =>
      confirmEmailHandoff(tx, {
        tenantId,
        code,
        secret: config.HANDOFF_LINK_SECRET,
        inbox,
        texts: await businessTexts(tx),
        now: new Date(),
      }),
    );
    if (!done) return html(reply, 410, expiredPage());
    const moved = inbox.toMessage(done.moved);
    const recap = inbox.toMessage(done.recap);
    await Promise.allSettled([
      publisher.publish(channels.conversation(tenantId, done.conversation.id), {
        type: 'message',
        message: moved,
      }),
      publisher.publish(channels.conversation(tenantId, done.conversation.id), {
        type: 'message',
        message: recap,
      }),
      publisher.publish(channels.inbox(tenantId), {
        type: 'conversation',
        conversation: inbox.toSummary(done.conversation, recap.notice),
      }),
    ]);
    const c = COPY[done.language];
    const to = (moved.card && 'sentTo' in moved.card && moved.card.sentTo) || '';
    return html(reply, 200, page(done.language, c.doneTitle, `<p>${esc(c.done(to))}</p>`));
  });
}
