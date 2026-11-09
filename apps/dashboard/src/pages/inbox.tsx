import type { InboxCounts, InboxView } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../lib/api.ts';
import {
  CHANNEL_LABEL,
  CHANNELS,
  channelOf,
  COUNTS_KEY,
  flattenPages,
  listKey,
  MEMBERS_KEY,
  searchFromView,
  VIEW_LABEL,
  VIEWS,
  viewFromSearch,
  type InboxFilter,
} from '../lib/inbox.ts';
import { inboxEvents, useLiveState, type LiveState } from '../lib/realtime.ts';
import { useInboxSearch } from '../lib/search.ts';
import { ConversationPane } from './conversation.tsx';
import { Row } from './inbox-row.tsx';
import { SearchField, SearchResults } from './inbox-search.tsx';

const COUNT_OF: Partial<Record<InboxView, keyof InboxCounts>> = {
  open: 'open',
  escalated: 'escalated',
  approval: 'approval',
  flagged: 'flagged',
};
const EMPTY_VIEW: Partial<Record<InboxView, string>> = {
  escalated: 'Conversations a visitor asks to hand to a person appear here.',
  flagged: 'Conversations with abuse or a crisis message appear here.',
};
const EMPTY_TITLE: Record<Exclude<InboxView, 'open'>, string> = {
  escalated: 'Nothing escalated',
  approval: 'Nothing waiting for approval',
  flagged: 'No flagged conversations',
  closed: 'No closed conversations yet',
};

/**
 * The inbox (SCR-APP-014) with the open conversation (SCR-APP-015): list · thread ·
 * sidebar at ≥ 1280, list · thread below, one pane at a time under 1024 (ui-design Layout).
 */
export function InboxPage() {
  const { conversationId } = useParams();
  const [search] = useSearchParams();
  const filter = viewFromSearch(search);
  const qs = searchFromView(filter);
  const live = useLiveState();

  return (
    <div className={`inbox ${conversationId ? 'inbox--thread' : 'inbox--list'}`}>
      <section className="inbox__list" aria-labelledby="inbox-title">
        <InboxList filter={filter} qs={qs} live={live} selected={conversationId ?? null} />
      </section>
      <section className="inbox__thread" aria-label="Conversation">
        {conversationId ? (
          <ConversationPane key={conversationId} id={conversationId} backTo={`/inbox${qs}`} />
        ) : (
          <EmptyState title="Pick a conversation">
            Choose a conversation from the list to read it.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function LiveBadge({ live }: { live: LiveState }) {
  return (
    <span className={`live live--${live}`} data-testid="live-state">
      <span className="live__dot" aria-hidden="true" />
      {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
    </span>
  );
}

/** "New message from Website visitor", at most once every 5 s. */
function useAnnouncement() {
  const [text, setText] = useState('');
  useEffect(() => {
    let last = 0;
    let clear: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      setText('New message from Website visitor');
      clearTimeout(clear);
      clear = setTimeout(() => setText(''), 4000);
    };
    inboxEvents.addEventListener('visitor-message', on);
    return () => {
      inboxEvents.removeEventListener('visitor-message', on);
      clearTimeout(clear);
    };
  }, []);
  return text;
}

function InboxList({
  filter,
  qs,
  live,
  selected,
}: {
  filter: InboxFilter;
  qs: string;
  live: LiveState;
  selected: string | null;
}) {
  const navigate = useNavigate();
  const announcement = useAnnouncement();
  const search = useInboxSearch();
  const counts = useQuery({
    queryKey: COUNTS_KEY,
    queryFn: async () =>
      (await api.conversations({ view: 'open', channel: null, limit: 1 })).counts,
  });
  const list = useInfiniteQuery({
    queryKey: listKey(filter),
    queryFn: ({ pageParam }) => api.conversations({ ...filter, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = flattenPages(list.data);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  // The assignee filter's teammates (FEAT-043 D7), cached 5 minutes; Anyone, Mine and
  // Unassigned still work when they fail to load.
  const members = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: api.inboxMembers,
    staleTime: 5 * 60_000,
  });
  const meId = me.data?.user.id ?? null;
  const now = useMinuteNow();
  // Switching views keeps the open conversation on screen (the thread pane, ≥ 1024).
  const to = (f: InboxFilter) => `/inbox${selected ? `/${selected}` : ''}${searchFromView(f)}`;

  return (
    <>
      <div className="page-header inbox__header">
        <h1 className="page-title" id="inbox-title">
          Inbox
        </h1>
        <LiveBadge live={live} />
      </div>
      {live === 'offline' && (
        <div className="alert alert--info" role="status">
          Reconnecting. New messages will appear when the connection is back.
        </div>
      )}
      <SearchField />
      {search.active ? (
        <SearchResults qs={qs} selected={selected} meId={meId} now={now} />
      ) : (
        <>
          <nav className="tabs inbox__views" aria-label="Views">
            {VIEWS.map((v) => {
              const key = COUNT_OF[v];
              const n = key && counts.data ? counts.data[key] : 0;
              const active = v === filter.view;
              return (
                <Link
                  key={v}
                  to={to({ ...filter, view: v })}
                  className="tabs__tab"
                  data-state={active ? 'active' : 'inactive'}
                  aria-current={active ? 'page' : undefined}
                >
                  {VIEW_LABEL[v]}
                  {n > 0 && (
                    <span className="count-pill" data-testid={`count-${v}`}>
                      {n}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="inbox__filters">
            <label className="field field--inline">
              <span className="field__label">Channel</span>
              <select
                className="input"
                value={filter.channel ?? ''}
                onChange={(e) =>
                  void navigate(to({ ...filter, channel: channelOf(e.target.value) }))
                }
              >
                <option value="">All channels</option>
                {CHANNELS.map((ch) => (
                  <option value={ch} key={ch}>
                    {CHANNEL_LABEL[ch]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field--inline">
              <span className="field__label">Assigned to</span>
              <select
                className="input"
                data-testid="assignee-filter"
                aria-describedby="assignee-help"
                value={filter.assignee ?? ''}
                onChange={(e) => void navigate(to({ ...filter, assignee: e.target.value || null }))}
              >
                <option value="">Anyone</option>
                <option value="me">Mine</option>
                <option value="none">Unassigned</option>
                {members.data?.members
                  .filter((m) => m.userId !== meId)
                  .map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <span id="assignee-help" className="sr-only">
              Who has it, or who it was escalated to.
            </span>
          </div>
          <div className="inbox__rows">
            {list.isPending && (
              <ul className="conversation-list" aria-busy="true" aria-label="Loading conversations">
                {Array.from({ length: 6 }, (_, i) => (
                  <li key={i} className="conversation-row conversation-row--skeleton">
                    <span className="skeleton-line" />
                  </li>
                ))}
              </ul>
            )}
            {list.isError && !list.data && (
              <ErrorState
                title="Couldn't load conversations"
                action={
                  <Button variant="secondary" onClick={() => void list.refetch()}>
                    Try again
                  </Button>
                }
              />
            )}
            {list.isSuccess && rows.length === 0 && (
              <ListEmpty
                filter={filter}
                onClear={() => void navigate(to({ ...filter, channel: null, assignee: null }))}
              />
            )}
            {rows.length > 0 && (
              <ul
                className="conversation-list"
                aria-label="Conversations"
                data-testid="conversation-list"
              >
                {rows.map((c) => (
                  <Row
                    key={c.id}
                    c={c}
                    qs={qs}
                    selected={c.id === selected}
                    meId={meId}
                    now={now}
                  />
                ))}
              </ul>
            )}
            {list.hasNextPage && (
              <div className="load-more">
                <Button
                  variant="secondary"
                  className="load-more__button"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage && <span className="spinner" aria-hidden="true" />}
                  Load more
                </Button>
              </div>
            )}
            {list.isFetchNextPageError && (
              <div className="alert alert--danger" role="alert">
                Couldn't load more conversations.{' '}
                <Button variant="ghost" onClick={() => void list.fetchNextPage()}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}

function ListEmpty({ filter, onClear }: { filter: InboxFilter; onClear: () => void }) {
  if (filter.channel || filter.assignee)
    return (
      <EmptyState
        title="No conversations match these filters"
        action={
          <Button variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    );
  if (filter.view === 'open')
    return (
      <EmptyState
        title="No conversations yet"
        action={
          <Button variant="secondary" asChild>
            <Link to="/settings/widget">Check your widget</Link>
          </Button>
        }
      >
        New chats appear here as soon as a visitor writes.
      </EmptyState>
    );
  return <EmptyState title={EMPTY_TITLE[filter.view]}>{EMPTY_VIEW[filter.view]}</EmptyState>;
}

/** The current time, refreshed every minute (escalation wait times, FEAT-044). */
function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
