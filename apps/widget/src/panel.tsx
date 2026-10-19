/**
 * The lazy chat panel (ADR-016 `panel.js`, ≤ 35 KB gz): SCR-WGT-002 in its simplest
 * form. Replies arrive over SSE (ADR-017). Verified sentence-by-sentence release
 * (ADR-008), disclosure, consent and the other widget components arrive with their
 * features.
 */
import type { Message } from '@kaki/contracts';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createApi, mergeMessages } from './api.js';
import { PANEL_CSS } from './panel.css.js';
import { pickLocale, strings, type Strings } from './strings.js';
import type { PanelContext } from './types.js';

const CLOSE_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function Panel({
  ctx,
  t,
  inputRef,
}: {
  ctx: PanelContext;
  t: Strings;
  inputRef: { current: HTMLTextAreaElement | null };
}) {
  const api = useRef(createApi(ctx.apiUrl, ctx.config.token)).current;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!conversationId) return;
    const url = `${ctx.config.realtimeUrl}/widget/v1/conversations/${conversationId}/stream?token=${encodeURIComponent(ctx.config.token)}`;
    const source = new EventSource(url);
    source.addEventListener('message', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent<string>).data) as {
          type: string;
          message: Message;
        };
        if (data.type === 'message') setMessages((list) => mergeMessages(list, data.message));
      } catch {
        /* ignore malformed frames */
      }
    });
    return () => source.close();
  }, [conversationId]);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  async function submit(e: Event) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(false);
    try {
      const id = conversationId ?? (await api.createConversation());
      if (!conversationId) setConversationId(id);
      const sent = await api.send(id, body, newId());
      setMessages((list) => mergeMessages(list, sent));
      setText('');
    } catch {
      setError(true);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  return (
    <section class="panel" role="dialog" aria-label={ctx.config.botName}>
      <header class="header">
        <h2 class="title">{ctx.config.botName}</h2>
        <span class="ai">{t.aiLabel}</span>
        <button type="button" class="icon-btn" aria-label={t.close} onClick={ctx.close}>
          {CLOSE_ICON}
        </button>
      </header>
      <ol class="log" ref={logRef} aria-live="polite" aria-relevant="additions">
        {messages.length === 0 && <li class="empty">{t.empty}</li>}
        {messages.map((m) => (
          <li key={m.id} class={`msg ${m.author}`} data-author={m.author}>
            {m.author === 'visitor' && <span class="sr-only">{t.you}: </span>}
            {m.body}
          </li>
        ))}
      </ol>
      {error && (
        <p class="error" role="alert">
          {t.failed}
        </p>
      )}
      <form class="composer" onSubmit={submit}>
        <label class="sr-only" for="kaki-input">
          {t.messageLabel}
        </label>
        <textarea
          id="kaki-input"
          ref={inputRef}
          rows={1}
          placeholder={t.placeholder}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) void submit(e);
          }}
        />
        <button class="send" type="submit" disabled={sending || !text.trim()}>
          {t.send}
        </button>
      </form>
    </section>
  );
}

export function mountPanel(ctx: PanelContext) {
  ctx.adopt(PANEL_CSS);
  const locale = pickLocale(navigator.language);
  ctx.mount.setAttribute('lang', locale);
  const inputRef: { current: HTMLTextAreaElement | null } = { current: null };
  ctx.mount.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') ctx.close();
  });
  render(<Panel ctx={ctx} t={strings(locale)} inputRef={inputRef} />, ctx.mount);
  return { focus: () => inputRef.current?.focus() };
}
