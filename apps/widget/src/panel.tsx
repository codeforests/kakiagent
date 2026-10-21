/**
 * The lazy chat panel (ADR-016 `panel.js`, ≤ 35 KB gz): SCR-WGT-002. Replies arrive
 * over SSE (ADR-017) one verified sentence at a time (ADR-008), then as the stored
 * message. Consent, feedback and the other widget components arrive with their
 * features.
 */
import type { Message } from '@kaki/contracts';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createApi } from './api.js';
import {
  awaitingTurn,
  emptyChat,
  greetingFor,
  langOf,
  pendingText,
  rowsOf,
  withMessage,
  withSegment,
  type Chat,
  type Segment,
} from './chat.js';
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

const INFO_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

/** No reply within this long after sending: say so (ui-design SCR-WGT-002 error). */
const SLOW_REPLY_MS = 30_000;

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function Panel({
  ctx,
  t,
  greeting,
  inputRef,
}: {
  ctx: PanelContext;
  t: Strings;
  greeting: string;
  inputRef: { current: HTMLTextAreaElement | null };
}) {
  const api = useRef(createApi(ctx.apiUrl, ctx.config.token)).current;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chat, setChat] = useState<Chat>(emptyChat);
  const [slow, setSlow] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!conversationId) return;
    const url = `${ctx.config.realtimeUrl}/widget/v1/conversations/${conversationId}/stream?token=${encodeURIComponent(ctx.config.token)}`;
    const source = new EventSource(url);
    const parse = (e: Event) => {
      try {
        return JSON.parse((e as MessageEvent<string>).data) as { type: string };
      } catch {
        return null; // ignore malformed frames
      }
    };
    source.addEventListener('message', (e) => {
      const data = parse(e) as { type: string; message: Message } | null;
      if (data?.type === 'message') setChat((c) => withMessage(c, data.message));
    });
    source.addEventListener('segment', (e) => {
      const data = parse(e) as ({ type: string } & Segment) | null;
      if (data?.type === 'segment') setChat((c) => withSegment(c, data));
    });
    return () => source.close();
  }, [conversationId]);

  const waitingFor = awaitingTurn(chat);
  const growing = waitingFor ? pendingText(chat, waitingFor) : null;

  // Typing until the first segment; the slow notice if nothing came within 30 s.
  useEffect(() => {
    setSlow(false);
    if (!waitingFor || growing) return;
    const timer = setTimeout(() => setSlow(true), SLOW_REPLY_MS);
    return () => clearTimeout(timer);
  }, [waitingFor, growing !== null]);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [chat, slow]);

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
      setChat((c) => withMessage(c, sent));
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
        {chat.messages.length === 0 && (
          <li class="empty" lang={langOf(greeting)}>
            {greeting}
          </li>
        )}
        {chat.messages.map((m) => [
          ...rowsOf(m).map((r) =>
            r.kind === 'disclosure' ? (
              <li key={r.key} class="disc" lang={langOf(r.text)}>
                {INFO_ICON} {r.text}
              </li>
            ) : r.kind === 'notice' ? (
              <li key={r.key} class="notice" lang={langOf(r.text)}>
                {r.text}
              </li>
            ) : (
              <li
                key={r.key}
                class={`msg ${m.author}`}
                data-author={m.author}
                lang={langOf(r.text)}
              >
                {m.author === 'visitor' && <span class="sr-only">{t.you}: </span>}
                {r.text}
              </li>
            ),
          ),
          m.id === waitingFor && growing && (
            <li
              key={`${m.id}-reply`}
              class="msg agent"
              data-author="agent"
              data-pending="true"
              lang={langOf(growing)}
            >
              {growing}
            </li>
          ),
        ])}
        {waitingFor && !slow && (
          <li class="typing" role="status" aria-label={t.typing(ctx.config.botName)}>
            <i />
            <i />
            <i />
          </li>
        )}
        {waitingFor && slow && (
          <li class="notice" role="status">
            {t.slow}
          </li>
        )}
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
  render(
    <Panel
      ctx={ctx}
      t={strings(locale)}
      greeting={greetingFor(ctx.config.greeting, locale)}
      inputRef={inputRef}
    />,
    ctx.mount,
  );
  return { focus: () => inputRef.current?.focus() };
}
