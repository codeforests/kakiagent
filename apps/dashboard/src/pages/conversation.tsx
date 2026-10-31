import type { ConversationStatus, FactChip, ThreadEvent, ThreadMessage } from '@kaki/contracts';
import { Button, EmptyState, ErrorState, SlideOver } from '@kaki/ui';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import {
  CHANNEL_LABEL,
  clockTime,
  mergeMessages,
  STATE_LABEL,
  takeoverErrorText,
  threadKey,
} from '../lib/inbox.ts';
import { useMedia } from '../lib/media.ts';
import { onConversation } from '../lib/realtime.ts';
import {
  Bubble,
  ContextSidebar,
  Divider,
  FlaggedChip,
  Glyph,
  StateChip,
  VisitorAvatar,
} from './conversation-parts.tsx';
import { useDockActions } from '../lib/takeover.ts';
import { ThreadDock } from './takeover-dock.tsx';

type Item =
  | { kind: 'message'; key: string; at: number; rank: number; message: ThreadMessage }
  | { kind: 'event'; key: string; at: number; rank: number; event: ThreadEvent };

/** Messages and dividers by time; a reopen sits before the message that caused it. */
function timeline(messages: ThreadMessage[], events: ThreadEvent[], hasEarlier: boolean): Item[] {
  const first = messages[0] ? new Date(messages[0].createdAt).getTime() : 0;
  const items: Item[] = messages.map((m) => ({
    kind: 'message',
    key: m.id,
    at: new Date(m.createdAt).getTime(),
    rank: 0,
    message: m,
  }));
  events.forEach((e, i) => {
    const at = new Date(e.at).getTime();
    // Dividers older than the loaded messages wait for Show earlier messages.
    if (hasEarlier && at < first) return;
    items.push({
      kind: 'event',
      key: `e${i}`,
      at,
      rank: e.reason === 'reopened' ? -1 : 1,
      event: e,
    });
  });
  return items.sort((a, b) => a.at - b.at || a.rank - b.rank);
}

/** The thread pane (SCR-APP-015): header, log, dock, and the context sidebar by width. */
export function ConversationPane({ id, backTo }: { id: string; backTo: string }) {
  const queryClient = useQueryClient();
  const wide = useMedia('(min-width: 1280px)');
  const phone = useMedia('(max-width: 639px)');
  const [details, setDetails] = useState(false);
  const [toast, setToast] = useToast();
  const [changed, setChanged] = useState<ConversationStatus | null>(null);
  const [closeOwned, setCloseOwned] = useState<string | null>(null);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [earlier, setEarlier] = useState<{ messages: ThreadMessage[]; hasEarlier: boolean } | null>(
    null,
  );
  const titleRef = useRef<HTMLHeadingElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const thread = useQuery({
    queryKey: threadKey(id),
    queryFn: () => api.conversation(id),
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 1,
  });
  const dock = useDockActions(thread.data?.conversation, me.data, setToast);

  const close = useMutation({
    mutationFn: (version: number) => api.closeConversation(id, version),
    onSuccess: (res) => {
      setChanged(null);
      setCloseOwned(null);
      setToast('Conversation closed');
      onConversation(queryClient, res.conversation);
      void queryClient.invalidateQueries({ queryKey: threadKey(id) });
      titleRef.current?.focus();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else owns it (FEAT-043 D6): only the owner can close.
        setCloseOwned(err.code === 'owned' ? takeoverErrorText('owned', err.details) : null);
        const latest = (err.details.conversation as { status?: ConversationStatus } | undefined)
          ?.status;
        setChanged(latest ?? (err.code === 'already_closed' ? 'closed' : null));
        close.reset();
        void queryClient.invalidateQueries({ queryKey: threadKey(id) });
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }
    },
  });

  const loadEarlier = useMutation({
    mutationFn: (before: number) => api.conversationMessages(id, before),
    onSuccess: (page) =>
      setEarlier((old) => ({
        messages: mergeMessages(page.messages, old?.messages ?? []),
        hasEarlier: page.hasEarlier,
      })),
  });

  if (thread.isPending) return <ThreadSkeleton />;
  if (thread.error instanceof ApiError && thread.error.status === 404)
    return (
      <EmptyState
        title="This conversation isn't available"
        action={
          <Button variant="secondary" asChild>
            <Link to={backTo}>Back to inbox</Link>
          </Button>
        }
      >
        It may belong to another workspace.
      </EmptyState>
    );
  if (thread.isError)
    return (
      <ErrorState
        title="Couldn't load this conversation"
        action={
          <Button variant="secondary" onClick={() => void thread.refetch()}>
            Try again
          </Button>
        }
      />
    );

  const t = thread.data;
  const c = t.conversation;
  const messages = mergeMessages(earlier?.messages ?? [], t.messages);
  const hasEarlier = earlier ? earlier.hasEarlier : t.hasEarlier;
  // Only the owner closes a taken-over conversation (D6).
  const open = c.status !== 'closed' && dock.mode !== 'other';
  const startClose = () => close.mutate(c.version);
  const sidebar = <ContextSidebar thread={t} />;

  return (
    <div className="conversation">
      <div className="conversation__main">
        <header className="thread-header">
          <Link to={backTo} className="icon-button thread-header__back" aria-label="Back to inbox">
            <Glyph name="arrow-left" size={20} />
          </Link>
          <VisitorAvatar label="Website visitor" channel={c.channel} />
          <div className="thread-header__text">
            <div className="thread-header__title">
              <h2 ref={titleRef} tabIndex={-1}>
                Website visitor
              </h2>
              <StateChip status={c.status} />
              {c.flaggedAt && <FlaggedChip />}
            </div>
            <p className="thread-header__caption">
              {CHANNEL_LABEL[c.channel]} · started {clockTime(c.createdAt)}
            </p>
          </div>
          {open &&
            (phone ? (
              <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger className="icon-button" aria-label="More actions">
                  <Glyph name="more-horizontal" size={20} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                    {dock.mode === 'mine' && (
                      <DropdownMenu.Item
                        className="menu__item"
                        disabled={dock.handBack.isPending}
                        onSelect={() => dock.handBack.mutate()}
                      >
                        Hand back to assistant
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item className="menu__item" onSelect={startClose}>
                      Close conversation
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : (
              <Button
                variant="secondary"
                onClick={startClose}
                disabled={close.isPending}
                aria-busy={close.isPending || undefined}
              >
                {close.isPending && <span className="spinner" aria-hidden="true" />}
                Close conversation
              </Button>
            ))}
          {!wide && (
            <button
              type="button"
              className="icon-button"
              aria-label="Conversation details"
              ref={detailsButton}
              onClick={() => setDetails(true)}
            >
              <Glyph name="info" size={20} />
            </button>
          )}
        </header>
        {changed && (
          <div className="alert alert--warning" role="alert">
            This conversation changed while you were looking. It's now {STATE_LABEL[changed]}.
          </div>
        )}
        {closeOwned && (
          <div className="alert alert--warning" role="alert">
            {closeOwned}
          </div>
        )}
        {close.isError && !(close.error instanceof ApiError && close.error.status === 409) && (
          <div className="alert alert--danger" role="alert">
            Couldn't close the conversation.{' '}
            <Button variant="ghost" onClick={startClose}>
              Try again
            </Button>
          </div>
        )}
        <ThreadLog
          key={c.id}
          messages={messages}
          events={t.events}
          facts={t.sidebar.facts}
          hasEarlier={hasEarlier}
          loadingEarlier={loadEarlier.isPending}
          earlierFailed={loadEarlier.isError}
          onEarlier={() => messages[0] && loadEarlier.mutate(messages[0].seq)}
          meId={me.data?.user.id ?? null}
        />
        <ThreadDock conversation={c} me={me.data} actions={dock} phone={phone} />
      </div>
      {wide ? (
        <aside className="conversation__sidebar" aria-label="Conversation details">
          {sidebar}
        </aside>
      ) : (
        <SlideOver
          open={details}
          onOpenChange={(next) => {
            setDetails(next);
            // No Radix trigger here, so return focus to the button by hand.
            if (!next) requestAnimationFrame(() => detailsButton.current?.focus());
          }}
          title="Conversation details"
          className="details-drawer"
        >
          {sidebar}
        </SlideOver>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function ThreadLog({
  messages,
  events,
  facts,
  hasEarlier,
  loadingEarlier,
  earlierFailed,
  onEarlier,
  meId,
}: {
  messages: ThreadMessage[];
  events: ThreadEvent[];
  facts: FactChip[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  earlierFailed: boolean;
  onEarlier: () => void;
  meId: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const factMap = useMemo(() => new Map(facts.map((f) => [f.id, f])), [facts]);
  const items = useMemo(
    () => timeline(messages, events, hasEarlier),
    [messages, events, hasEarlier],
  );
  const lastSeq = messages.at(-1)?.seq ?? 0;
  const firstSeq = messages[0]?.seq ?? 0;
  const prev = useRef({ firstSeq, lastSeq, height: 0 });

  // Keep the reader's place: stick to the bottom, hold position when earlier messages load.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = prev.current;
    if (before.height === 0 || (pinned && lastSeq !== before.lastSeq))
      el.scrollTop = el.scrollHeight;
    else if (firstSeq < before.firstSeq) el.scrollTop += el.scrollHeight - before.height;
    else if (lastSeq !== before.lastSeq && !pinned) setUnseen(true);
    prev.current = { firstSeq, lastSeq, height: el.scrollHeight };
  }, [firstSeq, lastSeq, pinned]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setPinned(atEnd);
    if (atEnd) setUnseen(false);
  };

  return (
    // Focusable so keyboard users can scroll the thread (axe scrollable-region-focusable;
    // a thread with no fact chips has nothing else to focus).
    <div
      className="thread-scroll"
      ref={ref}
      onScroll={onScroll}
      tabIndex={0}
      role="region"
      aria-label="Conversation messages"
    >
      {hasEarlier && (
        <div className="load-more">
          <Button variant="secondary" onClick={onEarlier} disabled={loadingEarlier}>
            {loadingEarlier && <span className="spinner" aria-hidden="true" />}
            Show earlier messages
          </Button>
        </div>
      )}
      {earlierFailed && (
        <div className="alert alert--danger" role="alert">
          Couldn't load earlier messages.
        </div>
      )}
      <div role="log" aria-label="Conversation">
        <ol className="thread-log" data-testid="thread-log">
          {items.map((item) =>
            item.kind === 'message' ? (
              <Bubble key={item.key} message={item.message} facts={factMap} meId={meId} />
            ) : (
              <Divider key={item.key} event={item.event} />
            ),
          )}
        </ol>
      </div>
      {unseen && (
        <button
          type="button"
          className="new-message-pill"
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          New message ↓
        </button>
      )}
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="conversation" aria-busy="true" aria-label="Loading conversation">
      <div className="conversation__main">
        <div className="skeleton-line thread-skeleton__header" />
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className={`skeleton-line thread-skeleton__bubble thread-skeleton__bubble--${i % 2}`}
          />
        ))}
      </div>
    </div>
  );
}
