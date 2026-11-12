/**
 * The lazy chat panel (ADR-016 `panel.js`, ≤ 35 KB gz): SCR-WGT-002. Replies arrive
 * over SSE (ADR-017) one verified sentence at a time (ADR-008), then as the stored
 * message. Consent and details cards (FEAT-049) are in `cards.tsx`; feedback and the
 * other widget components arrive with their features.
 */
import type { LeadCaptureConfig, Message } from '@kaki/contracts';
import { render, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ChatEndedError, MovedError, createApi } from './api.js';
import {
  ContactForm,
  HandoffCard,
  LeadCard,
  PrivacyLink,
  QuoteCard,
  TrackingPrompt,
  WithdrawCard,
} from './cards.js';
import { pathOf } from './track.js';
import {
  activeCard,
  awaitingTurn,
  chatEnded,
  chromeLocale,
  escalationPending,
  emptyChat,
  greetingFor,
  handoffMenuLabel,
  langOf,
  menuItems,
  trackingPromptShown,
  movedView,
  notLiveView,
  pausedNotice,
  pendingText,
  rowsOf,
  staffHandling,
  withMessage,
  withSegment,
  type Chat,
  type HandoffChannel,
  type MenuItem,
  type NotLiveView,
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

const MENU_ICON = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.75" />
    <circle cx="12" cy="12" r="1.75" />
    <circle cx="19" cy="12" r="1.75" />
  </svg>
);

/**
 * The header's menu button and menu (SCR-WGT-002, FEAT-033): the WAI-ARIA menu-button
 * pattern. Escape closes the menu only; the panel stays open.
 */
function HeaderMenu({
  items,
  t,
  privacyUrl,
  buttonRef,
  handoffLabel,
  onSelect,
}: {
  items: MenuItem[];
  t: Strings;
  privacyUrl: string | null;
  buttonRef: { current: HTMLButtonElement | null };
  handoffLabel: string;
  onSelect(item: MenuItem): void;
}) {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState<number | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const entries = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Set by hide(true); the button takes focus once the closed menu has committed, so an
  // open's item focus still pending from the render before can't land after it and be lost
  // with the unmounted menu (CI: widget-controls Escape right after a click).
  const refocus = useRef(false);
  useEffect(() => {
    if (open && first !== null) entries()[first < 0 ? entries().length - 1 : first]?.focus();
    else if (!open && refocus.current) {
      refocus.current = false;
      buttonRef.current?.focus();
    }
  }, [open, first]);

  const show = (at: number) => {
    setFirst(at);
    setOpen(true);
  };
  const hide = (refocusButton: boolean) => {
    setOpen(false);
    setFirst(null);
    if (refocusButton) {
      // Now as well, so focus doesn't wait for the effect; the effect repeats it after commit.
      buttonRef.current?.focus();
      refocus.current = true;
    }
  };

  function onMenuKey(e: KeyboardEvent) {
    const list = entries();
    const at = list.indexOf(e.target as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(-1);
    else if (e.key === 'Tab') hide(false);
    else if (e.key === ' ' && (e.target as HTMLElement).tagName === 'A') {
      e.preventDefault();
      (e.target as HTMLElement).click();
    }
  }

  const pick = (item: MenuItem) => {
    hide(false);
    onSelect(item);
  };

  return (
    <div
      class="menu-wrap"
      // Escape closes an open menu only, wherever focus is inside it: the button keeps focus
      // until the first item is focused after paint (FEAT-044 R1: Chromium closed the panel).
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        hide(true);
      }}
      onFocusOut={(e) => {
        const next = e.relatedTarget as Node | null;
        if (open && !(next && (e.currentTarget as HTMLElement).contains(next))) hide(false);
      }}
    >
      <button
        type="button"
        class="icon-btn"
        aria-label={t.menu}
        aria-haspopup="menu"
        aria-expanded={open}
        ref={buttonRef}
        onClick={() => (open ? hide(false) : show(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            show(0);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            show(-1);
          }
        }}
      >
        {MENU_ICON}
      </button>
      {open && (
        <ul
          class="menu"
          role="menu"
          aria-label={t.menu}
          ref={menuRef}
          onKeyDown={onMenuKey}
          // Keeps focus on the item through the click, so focusout doesn't close first.
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((item) => (
            <li key={item} role="none">
              {item === 'privacy' && privacyUrl ? (
                <PrivacyLink url={privacyUrl} t={t} class="mi" />
              ) : (
                <button
                  type="button"
                  class="mi"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => pick(item)}
                >
                  {item === 'end'
                    ? t.endChat
                    : item === 'continueElsewhere'
                      ? handoffLabel
                      : item === 'stopTracking'
                        ? t.trackStop
                        : item === 'shareTracking'
                          ? t.trackShare
                          : t.talkToPerson}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** No reply within this long after sending: say so (ui-design SCR-WGT-002 error). */
const MAIL_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-10 6L2 7" />
  </svg>
);

const PHONE_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
  </svg>
);

/** The business's email and phone links, each only when present (SCR-WGT-005). */
function ContactLines({ view, t }: { view: NotLiveView; t: Strings }) {
  return (
    <>
      {view.email && (
        <p class="contact">
          {MAIL_ICON}
          <span class="sr-only">{t.notLiveEmail}: </span>
          <a href={view.email.href}>{view.email.label}</a>
        </p>
      )}
      {view.phone && (
        <p class="contact">
          {PHONE_ICON}
          <span class="sr-only">{t.notLivePhone}: </span>
          <a href={view.phone.href}>{view.phone.label}</a>
        </p>
      )}
    </>
  );
}

/** SCR-WGT-005 not live: the business's message and contacts in place of the chat. */
function NotLiveCard({
  view,
  t,
  business,
  cardRef,
  contact,
  onLeave,
}: {
  view: NotLiveView;
  t: Strings;
  business: string;
  cardRef: { current: HTMLDivElement | null };
  /** The open contact form (FEAT-049 SCR-WGT-005), in place of the card. */
  contact: ComponentChildren;
  /** Null when the business doesn't capture leads. */
  onLeave: (() => void) | null;
}) {
  return (
    <div class="offline" role="region" aria-label={t.notLiveRegion(business)}>
      {contact || (
        <div class="offline-card">
          <p tabIndex={-1} ref={cardRef} lang={langOf(view.text)}>
            {view.text}
          </p>
          <ContactLines view={view} t={t} />
          {onLeave && (
            <button type="button" class="btn sec" data-leave onClick={onLeave}>
              {t.leaveDetails}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const PAUSE_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M10 15V9M14 15V9" />
  </svg>
);

/** SCR-WGT-005 paused (FEAT-057): the fallback and contacts at the top of the log; the composer stays. */
function PausedNotice({
  view,
  t,
  business,
  contact,
  onLeave,
}: {
  view: NotLiveView;
  t: Strings;
  business: string;
  contact: ComponentChildren;
  onLeave: (() => void) | null;
}) {
  return (
    <li class="paused">
      {contact || (
        <div class="offline-card" role="region" aria-label={t.notLiveRegion(business)}>
          <p class="paused-text" lang={langOf(view.text)}>
            {PAUSE_ICON}
            <span>{view.text}</span>
          </p>
          <ContactLines view={view} t={t} />
          {onLeave && (
            <button type="button" class="btn sec" data-leave onClick={onLeave}>
              {t.leaveDetails}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

const SLOW_REPLY_MS = 30_000;

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function Panel({
  ctx,
  inputRef,
  noticeRef,
}: {
  ctx: PanelContext;
  inputRef: { current: HTMLTextAreaElement | null };
  noticeRef: { current: HTMLDivElement | null };
}) {
  const api = useRef(createApi(ctx.apiUrl, ctx.config.token)).current;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const preview = ctx.preview;
  const [chat, setChat] = useState<Chat>(() =>
    preview ? preview.messages.reduce(withMessage, emptyChat) : emptyChat,
  );
  const [slow, setSlow] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  // Talk to a person (FEAT-044 SCR-WGT-002): the transient asking row, or the failed row.
  const [asking, setAsking] = useState<'idle' | 'asking' | 'failed'>('idle');
  const logRef = useRef<HTMLOListElement>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  // The visitor's end of chat (SCR-WGT-006): composer → confirm → ending → done card.
  const [endState, setEndState] = useState<'open' | 'confirm' | 'ending' | 'ended'>('open');
  const [endError, setEndError] = useState(false);
  const cardTitleRef = useRef<HTMLHeadingElement>(null);
  // Lead capture (FEAT-049): the config, replaced when a 409 brings new wording; the
  // fallback contact form's open state.
  const [lead, setLead] = useState<LeadCaptureConfig | null>(ctx.config.leadCapture ?? null);
  const [contactOpen, setContactOpen] = useState(false);
  // Continue elsewhere (FEAT-038): the menu's local card (its key) and focus requests for it;
  // the channel a 409 `moved` named, until the stored moved notice is here.
  const [localHandoff, setLocalHandoff] = useState<number | null>(null);
  const [handoffFocus, setHandoffFocus] = useState(0);
  const [movedTo, setMovedTo] = useState<HandoffChannel | null>(null);
  // Where focus goes after the next render (the target may not exist yet).
  // Page tracking (FEAT-029 §5.8): the stored choice, the prompt card (where and its state),
  // and the stopped notice.
  const tracking = preview ? undefined : ctx.tracking;
  const trackMode = tracking?.mode ?? 'off';
  const [trackChoice, setTrackChoice] = useState(() => tracking?.choice() ?? null);
  const [trackCard, setTrackCard] = useState<{
    at: 'top' | 'end';
    state: 'ask' | 'accepted' | 'declined';
  } | null>(() =>
    trackingPromptShown(trackMode, tracking?.choice() ?? null) ? { at: 'top', state: 'ask' } : null,
  );
  const [trackStopped, setTrackStopped] = useState(false);
  const allowRef = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef<
    'title' | 'menu' | 'input' | 'leave' | 'allow' | `notice:${string}` | null
  >(null);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target?.startsWith('notice:'))
      logRef.current?.querySelector<HTMLElement>(`[data-notice="${target.slice(7)}"]`)?.focus();
    else if (target === 'leave')
      (ctx.mount.querySelector('[data-leave]') as HTMLElement | null)?.focus();
    else if (target === 'title') cardTitleRef.current?.focus();
    // The menu button can be gone for a render (Talk to a person, before the chat exists).
    else if (target === 'menu') {
      if (menuRef.current) menuRef.current.focus();
      else focusNext.current = 'menu';
    } else if (target === 'input') inputRef.current?.focus();
    else if (target === 'allow') allowRef.current?.focus();
  });

  // The chrome follows the latest reply's language (FEAT-033 D3, AC-7).
  const locale = chromeLocale(chat, navigator.language);
  const t = strings(locale);
  // Offline with "Show a message" (FEAT-034, SCR-WGT-005): no chat, only the message.
  const notLive = preview ? null : notLiveView(ctx.config.availability, navigator.language);
  // AI paused (FEAT-057): a notice in place of the greeting; visitors can still write.
  const paused = preview ? null : pausedNotice(ctx.config, navigator.language);
  const greeting = greetingFor(ctx.config.greeting, locale);
  // Layout effect: the mount's lang changes in the same frame as the chrome's strings.
  useLayoutEffect(() => ctx.mount.setAttribute('lang', locale), [locale]);

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
  const ended = chatEnded(chat);
  const visitorEnded = endState === 'ended';
  const closeRef = useRef<HTMLButtonElement>(null);

  // FEAT-025: the chat ended; keyboard users aren't left on a disabled control.
  useEffect(() => {
    if (!ended) return;
    const root = inputRef.current?.getRootNode() as ShadowRoot | Document | undefined;
    if (root?.activeElement === inputRef.current) closeRef.current?.focus();
  }, [ended]);
  const growing = waitingFor ? pendingText(chat, waitingFor) : null;
  const privacyUrl = ctx.config.privacyNoticeUrl;
  const openCard = activeCard(chat);
  // The moved state (SCR-WGT-002; AC-8): the composer gives way to the moved bar.
  const moved = preview ? null : movedView(chat, movedTo);
  const movedKey = moved ? (moved.noticeId ?? 'moved') : null;
  useEffect(() => {
    if (!movedKey) return;
    setLocalHandoff(null);
    logRef.current?.querySelector<HTMLElement>(`[data-notice="${movedKey}"]`)?.focus();
  }, [movedKey]);
  const business = ctx.config.botName;
  const leadCommon = lead && {
    lead,
    onLeadCapture: setLead,
    locale,
    t,
    business,
    privacyUrl,
  };
  // SCR-WGT-005: "Leave your details" and the contact form, only when capturing (AC-9).
  const contactForm =
    leadCommon && contactOpen && !preview ? (
      <ContactForm
        {...leadCommon}
        api={api}
        conversationId={conversationId}
        onBack={() => {
          setContactOpen(false);
          focusNext.current = 'leave';
        }}
      />
    ) : null;
  const onLeave = lead && !preview ? () => setContactOpen(true) : null;
  const items = menuItems(ctx.config, {
    conversationId,
    // Not live: no chat to end or hand over, only the privacy notice.
    ended: ended || visitorEnded || !!notLive || !!moved,
    preview: !!preview,
    handover: asking === 'asking' || escalationPending(chat) || staffHandling(chat),
    tracking: { mode: trackMode, choice: trackChoice },
  });

  /** The visitor's tracking answer: kept locally even if saving fails (FEAT-029 §5.8). */
  function setTracking(c: 'accepted' | 'declined') {
    tracking?.setChoice(c);
    setTrackChoice(c);
    void api.trackingChoice(c).catch(() => {});
  }
  function chooseTracking(c: 'accepted' | 'declined') {
    setTracking(c);
    setTrackCard((card) => card && { ...card, state: c });
    focusNext.current = 'input';
  }

  /** Creates the conversation if needed, then asks for a person (FEAT-044 §5.7). */
  async function talkToPerson() {
    if (preview || asking === 'asking') return;
    setAsking('asking');
    try {
      const id = conversationId ?? (await api.createConversation());
      if (!conversationId) setConversationId(id);
      const res = await api.escalate(id);
      // The same notice may also arrive over SSE; withMessage merges by id.
      if (res.notice) setChat((c) => withMessage(c, res.notice!));
      setAsking('idle');
    } catch (err) {
      if (err instanceof MovedError) {
        setAsking('idle');
        setMovedTo(err.channel);
        return;
      }
      if (err instanceof ChatEndedError) {
        setAsking('idle');
        setEndState('ended');
        focusNext.current = 'title';
        return;
      }
      setAsking('failed');
    }
  }

  function cancelEnd() {
    setEndState('open');
    setEndError(false);
    focusNext.current = 'menu';
  }

  async function confirmEnd() {
    if (!conversationId || endState === 'ending') return;
    setEndState('ending');
    setEndError(false);
    try {
      await api.endConversation(conversationId);
      setEndState('ended');
      focusNext.current = 'title';
    } catch {
      setEndState('confirm');
      setEndError(true);
    }
  }

  /** Start a new chat: an empty log; the next message opens a new conversation. */
  function newChat() {
    setChat(emptyChat);
    setConversationId(null);
    setEndState('open');
    setText('');
    setError(false);
    setAsking('idle');
    setMovedTo(null);
    setLocalHandoff(null);
    focusNext.current = 'input';
  }

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
    if (!body || sending || ended || preview) return;
    setSending(true);
    setError(false);
    try {
      const id = conversationId ?? (await api.createConversation());
      if (!conversationId) setConversationId(id);
      const sent = await api.send(id, body, newId(), pathOf(location));
      setChat((c) => withMessage(c, sent));
      setText('');
    } catch (err) {
      if (err instanceof MovedError) {
        setMovedTo(err.channel);
        return;
      }
      if (err instanceof ChatEndedError) {
        setEndState('ended');
        focusNext.current = 'title';
        return;
      }
      setError(true);
    } finally {
      setSending(false);
    }
    inputRef.current?.focus();
  }

  return (
    <section class="panel" role="dialog" aria-label={ctx.config.botName}>
      <header class="header">
        <h2 class="title">{ctx.config.botName}</h2>
        <span class="ai">{t.aiLabel}</span>
        {items.length > 0 && (
          <HeaderMenu
            items={items}
            t={t}
            privacyUrl={privacyUrl}
            buttonRef={menuRef}
            handoffLabel={handoffMenuLabel(ctx.config.handoff, t)}
            onSelect={(item) => {
              if (item === 'continueElsewhere') {
                if (localHandoff !== null) setHandoffFocus((n) => n + 1);
                else setLocalHandoff(Date.now());
                return;
              }
              if (item === 'stopTracking') {
                setTracking('declined');
                setTrackCard(null);
                setTrackStopped(true);
                focusNext.current = 'notice:tracking-stopped';
                return;
              }
              if (item === 'shareTracking') {
                setTrackStopped(false);
                setTrackCard({ at: 'end', state: 'ask' });
                focusNext.current = 'allow';
                return;
              }
              if (item === 'talkToPerson') {
                focusNext.current = 'menu';
                void talkToPerson();
                return;
              }
              if (item !== 'end') return;
              setEndState('confirm');
              focusNext.current = 'title';
            }}
          />
        )}
        <button
          type="button"
          class="icon-btn"
          aria-label={t.close}
          onClick={ctx.close}
          ref={closeRef}
        >
          {CLOSE_ICON}
        </button>
      </header>
      {notLive ? (
        <NotLiveCard
          view={notLive}
          t={t}
          business={business}
          cardRef={noticeRef}
          contact={contactForm}
          onLeave={onLeave}
        />
      ) : (
        <>
          <ol class="log" ref={logRef} tabIndex={0} aria-live="polite" aria-relevant="additions">
            {paused && (
              <PausedNotice
                view={paused}
                t={t}
                business={business}
                contact={contactForm}
                onLeave={onLeave}
              />
            )}
            {trackCard?.at === 'top' && (
              <TrackingPrompt
                state={trackCard.state}
                t={t}
                business={business}
                privacyUrl={privacyUrl}
                onChoose={chooseTracking}
                allowRef={allowRef}
              />
            )}
            {!paused && chat.messages.length === 0 && (
              <li class="empty" lang={langOf(greeting)}>
                {greeting}
              </li>
            )}
            {chat.messages.map((m) => [
              ...rowsOf(m, t.teamMember)
                // An approved quote (FEAT-055) shows as its card, not its text body.
                .filter((r) => !(m.card?.kind === 'quote' && r.kind === 'message'))
                .map((r) =>
                  r.kind === 'disclosure' ? (
                    <li key={r.key} class="disc" lang={langOf(r.text)}>
                      {INFO_ICON} {r.text}
                    </li>
                  ) : r.kind === 'notice' ? (
                    <li
                      key={r.key}
                      class="notice"
                      lang={langOf(r.text)}
                      {...((m.noticeKind === 'lead_captured' ||
                        m.noticeKind === 'consent_withdrawn' ||
                        m.noticeKind === 'handoff_moved') && {
                        'data-notice': m.id,
                        tabIndex: -1,
                      })}
                    >
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
                      {r.name !== undefined && (
                        <span class="who" lang={langOf(r.name)}>
                          {r.name}
                          <span class="sr-only">: </span>
                        </span>
                      )}
                      {r.text}
                    </li>
                  ),
                ),
              m.card?.kind === 'quote' && (
                <QuoteCard
                  key={`${m.id}-card`}
                  m={{ ...m, card: m.card }}
                  t={strings(pickLocale(langOf(m.body)))}
                />
              ),
              m.card &&
                (m.card.kind === 'consent' || m.card.kind === 'lead_form') &&
                leadCommon && (
                  <LeadCard
                    key={`${m.id}-card`}
                    {...leadCommon}
                    m={{ ...m, card: m.card }}
                    active={m.id === openCard}
                    api={preview ? null : api}
                    conversationId={conversationId}
                    onNotice={(notice) => {
                      setChat((c) => withMessage(c, notice));
                      focusNext.current = `notice:${notice.id}`;
                    }}
                    focusComposer={() => inputRef.current?.focus()}
                  />
                ),
              m.card?.kind === 'withdraw' && (
                <WithdrawCard
                  key={`${m.id}-card`}
                  m={{ ...m, card: m.card }}
                  active={m.id === openCard}
                  api={preview ? null : api}
                  conversationId={conversationId}
                  t={t}
                  locale={locale}
                  business={business}
                  onNotice={(notice) => {
                    setChat((c) => withMessage(c, notice));
                    focusNext.current = `notice:${notice.id}`;
                  }}
                  focusComposer={() => inputRef.current?.focus()}
                />
              ),
              m.card?.kind === 'handoff' && (
                <HandoffCard
                  key={`${m.id}-card`}
                  id={m.id}
                  flags={m.card}
                  active={m.id === openCard && !moved}
                  local={false}
                  focusRequest={0}
                  api={preview ? null : api}
                  conversationId={conversationId}
                  t={t}
                  bot={business}
                  privacyUrl={privacyUrl}
                  onMoved={setMovedTo}
                  focusComposer={() => inputRef.current?.focus()}
                />
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
            {localHandoff !== null && !moved && (
              <HandoffCard
                key={`local-${localHandoff}`}
                id={`local-${localHandoff}`}
                flags={ctx.config.handoff}
                active
                local
                focusRequest={handoffFocus}
                api={preview ? null : api}
                conversationId={conversationId}
                t={t}
                bot={business}
                privacyUrl={privacyUrl}
                onMoved={setMovedTo}
                focusComposer={() => inputRef.current?.focus()}
              />
            )}
            {moved && !moved.noticeId && (
              <li class="notice" data-notice="moved" tabIndex={-1}>
                {t.movedNotice(moved.channel === 'telegram')}
              </li>
            )}
            {trackCard?.at === 'end' && (
              <TrackingPrompt
                state={trackCard.state}
                t={t}
                business={business}
                privacyUrl={privacyUrl}
                onChoose={chooseTracking}
                allowRef={allowRef}
              />
            )}
            {trackStopped && (
              <li class="notice" data-notice="tracking-stopped" tabIndex={-1}>
                {t.trackStopped}
              </li>
            )}
            {waitingFor && !visitorEnded && !slow && (
              <li class="typing" role="status" aria-label={t.typing(ctx.config.botName)}>
                <i />
                <i />
                <i />
              </li>
            )}
            {asking === 'asking' && (
              <li class="notice asking" role="status">
                <span class="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {t.askingTeam}
              </li>
            )}
            {waitingFor && !visitorEnded && slow && (
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
          {asking === 'failed' && (
            <p class="error retry" role="alert">
              {t.escalateFailed}
              <button type="button" class="btn sec" onClick={() => void talkToPerson()}>
                {t.retry}
              </button>
            </p>
          )}
          {moved ? (
            <div class="moved" data-moved={moved.channel}>
              {moved.channel === 'telegram' ? (
                moved.url && (
                  <a class="btn pri" href={moved.url} target="_blank" rel="noopener">
                    {t.openTelegram}
                    <span class="sr-only"> {t.opensTelegram}</span>
                  </a>
                )
              ) : (
                <p>{t.movedEmailCaption}</p>
              )}
              <button type="button" class="btn ghost" onClick={newChat}>
                {t.newChatHere}
              </button>
            </div>
          ) : endState !== 'open' ? (
            <div
              class="card"
              role="group"
              aria-labelledby="kaki-end-title"
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || visitorEnded) return;
                e.stopPropagation();
                if (endState === 'confirm') cancelEnd();
              }}
            >
              <h3 id="kaki-end-title" tabIndex={-1} ref={cardTitleRef}>
                {visitorEnded ? t.endedTitle : t.endConfirmTitle}
              </h3>
              {visitorEnded ? (
                <>
                  <p>{t.transcriptNotice}</p>
                  {privacyUrl && (
                    <p>
                      <PrivacyLink url={privacyUrl} t={t} />
                    </p>
                  )}
                  <button type="button" class="btn pri" onClick={newChat}>
                    {t.newChat}
                  </button>
                </>
              ) : (
                <>
                  <p>{t.endConfirmBody}</p>
                  {endError && (
                    <p class="error" role="alert">
                      {t.endFailed}
                    </p>
                  )}
                  <div class="row">
                    <button
                      type="button"
                      class="btn sec"
                      disabled={endState === 'ending'}
                      onClick={cancelEnd}
                    >
                      {t.keepChatting}
                    </button>
                    <button
                      type="button"
                      class="btn pri"
                      disabled={endState === 'ending'}
                      onClick={() => void confirmEnd()}
                    >
                      {endState === 'ending' ? t.ending : t.endChatConfirm}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <form class="composer" onSubmit={submit}>
              <label class="sr-only" for="kaki-input">
                {t.messageLabel}
              </label>
              <textarea
                id="kaki-input"
                ref={inputRef}
                rows={1}
                placeholder={preview ? t.preview : ended ? t.ended : t.placeholder}
                disabled={ended || !!preview}
                value={text}
                onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) void submit(e);
                }}
              />
              <button
                class="send"
                type="submit"
                disabled={sending || ended || !!preview || !text.trim()}
              >
                {t.send}
              </button>
            </form>
          )}
        </>
      )}
      {privacyUrl && !visitorEnded && (
        <p class="foot">
          <PrivacyLink url={privacyUrl} t={t} />
        </p>
      )}
    </section>
  );
}

export function mountPanel(ctx: PanelContext) {
  ctx.adopt(PANEL_CSS);
  const inputRef: { current: HTMLTextAreaElement | null } = { current: null };
  const noticeRef: { current: HTMLDivElement | null } = { current: null };
  ctx.mount.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') ctx.close();
  });
  render(<Panel ctx={ctx} inputRef={inputRef} noticeRef={noticeRef} />, ctx.mount);
  return { focus: () => (inputRef.current ?? noticeRef.current)?.focus() };
}
