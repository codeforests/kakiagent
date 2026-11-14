import type { ConversationList, InboxCounts, InboxView } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../lib/api.ts';
import { useMedia } from '../lib/media.ts';
import {
  CHANNEL_LABEL,
  CHANNELS,
  channelOf,
  COUNTS_KEY,
  flattenPages,
  inView,
  listKey,
  MEMBERS_KEY,
  searchFromView,
  threadKey,
  VIEW_LABEL,
  VIEW_SHORT_LABEL,
  VIEWS,
  viewFromSearch,
  type InboxFilter,
} from '../lib/inbox.ts';
import { inboxEvents, useLiveState, type LiveState } from '../lib/realtime.ts';
import { useInboxSearch } from '../lib/search.ts';
import { ConversationPane } from './conversation.tsx';
import { Glyph } from './conversation-parts.tsx';
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
  const counts = useCounts();

  return (
    <div className={`inbox ${conversationId ? 'inbox--thread' : 'inbox--list'}`}>
      <section className="inbox__list" aria-labelledby="inbox-title">
        <InboxList filter={filter} qs={qs} live={live} selected={conversationId ?? null} />
      </section>
      <section className="inbox__thread" aria-label="Conversation">
        {conversationId ? (
          <ConversationPane key={conversationId} id={conversationId} backTo={`/inbox${qs}`} />
        ) : (
          <NothingSelected filter={filter} escalated={counts.data?.escalated ?? 0} />
        )}
      </section>
    </div>
  );
}

/** The tab counts, shared by the views and the empty state (one cached query). */
function useCounts() {
  return useQuery({
    queryKey: COUNTS_KEY,
    queryFn: async () =>
      (await api.conversations({ view: 'open', channel: null, limit: 1 })).counts,
  });
}

/** The thread pane with nothing selected (FEAT-075 ui-design Empty state; D6). */
function NothingSelected({ filter, escalated }: { filter: InboxFilter; escalated: number }) {
  return (
    <div className="inbox-empty">
      <span className="inbox-empty__icon" aria-hidden="true">
        <Glyph name="message-square-text" size={24} />
      </span>
      <h2 className="inbox-empty__title">Pick a conversation</h2>
      <p className="inbox-empty__text">
        Choose a conversation from the list to read it. The visitor's details open beside it.
      </p>
      {escalated > 0 && filter.view !== 'escalated' && (
        <div className="inbox-empty__card" data-testid="escalated-shortcut">
          <span className="inbox-empty__warn" aria-hidden="true">
            <Glyph name="alert-triangle" size={16} />
          </span>
          <span>
            {escalated} escalated conversation{escalated === 1 ? '' : 's'} waiting.
          </span>
          <Button variant="ghost" asChild>
            <Link to={`/inbox${searchFromView({ ...filter, view: 'escalated' })}`}>
              Show escalated
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function LiveBadge({ live }: { live: LiveState }) {
  return (
    <span className={`live live--${live}`} data-testid="live-state">
      <span className="live__dot" aria-hidden="true" />
      {live === 'live' ? 'Connected' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
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
  const queryClient = useQueryClient();
  const announcement = useAnnouncement();
  const search = useInboxSearch();
  const counts = useCounts();
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const active = (filter.channel ? 1 : 0) + (filter.assignee ? 1 : 0);
  // FEAT-075 D2: a view or filter change keeps the open conversation only when it belongs in
  // the result (`inView`, from the summary the client already has); otherwise the empty state.
  // A live change never deselects: only these links and selects go through `to`.
  const thread = useQuery({
    queryKey: threadKey(selected ?? ''),
    queryFn: () => api.conversation(selected ?? ''),
    enabled: false,
  });
  // Lists are patched synchronously by live events while the thread is only refetched, so
  // a cached row is the freshest copy; the thread covers a conversation in no loaded page.
  const summary = selected
    ? (rowsOf(queryClient, selected) ?? thread.data?.conversation)
    : undefined;
  const to = (f: InboxFilter) =>
    `/inbox${selected && inView(summary, f, meId) ? `/${selected}` : ''}${searchFromView(f)}`;

  return (
    <>
      <div className="inbox__top">
        <div className="inbox__header">
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
        <div className="inbox__toolbar">
          <SearchField />
          {!search.active && (
            <button
              type="button"
              className={`kaki-btn kaki-btn--secondary filters-button${active > 0 ? ' filters-button--active' : ''}`}
              aria-expanded={filtersOpen}
              aria-controls="inbox-filters"
              aria-label={active > 0 ? `Filters, ${active} active` : 'Filters'}
              ref={filtersButton}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <Glyph name="sliders" size={16} />
              <span className="filters-button__label">Filters</span>
              {active > 0 && (
                <span className="filters-button__count" aria-hidden="true">
                  {active}
                </span>
              )}
            </button>
          )}
        </div>
        {!search.active && (
          <>
            <div
              className="filters-panel"
              id="inbox-filters"
              hidden={!filtersOpen}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setFiltersOpen(false);
                  filtersButton.current?.focus();
                }
              }}
            >
              <label className="field">
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
              <label className="field">
                <span className="field__label">Assigned to</span>
                <select
                  className="input"
                  data-testid="assignee-filter"
                  aria-describedby="assignee-help"
                  value={filter.assignee ?? ''}
                  onChange={(e) =>
                    void navigate(to({ ...filter, assignee: e.target.value || null }))
                  }
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
            {active > 0 && (
              <ul className="filter-chips" aria-label="Active filters">
                {filter.channel && (
                  <FilterChip
                    text={`Channel: ${CHANNEL_LABEL[filter.channel]}`}
                    to={to({ ...filter, channel: null })}
                  />
                )}
                {filter.assignee && (
                  <FilterChip
                    text={`Assigned: ${assigneeLabel(filter.assignee, members.data?.members)}`}
                    to={to({ ...filter, assignee: null })}
                  />
                )}
                <li>
                  <Link
                    className="filter-chips__clear"
                    to={to({ ...filter, channel: null, assignee: null })}
                  >
                    Clear all
                  </Link>
                </li>
              </ul>
            )}
            <ViewTabs filter={filter} counts={counts.data} to={to} />
          </>
        )}
      </div>
      {search.active ? (
        <SearchResults qs={qs} selected={selected} meId={meId} now={now} />
      ) : (
        <>
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

const PHONE_MORE: InboxView[] = ['flagged', 'closed'];
const WARN_PILL: Partial<Record<InboxView, true>> = { escalated: true, flagged: true };

/**
 * The views (FEAT-075 ui-design Views; D5): short labels with the full name as `title`.
 * Below 640 px Flagged and Closed move into a More menu whose trigger shows Flagged's count.
 */
function ViewTabs({
  filter,
  counts,
  to,
}: {
  filter: InboxFilter;
  counts: InboxCounts | undefined;
  to: (f: InboxFilter) => string;
}) {
  const phone = useMedia('(max-width: 639px)');
  const count = (v: InboxView) => {
    const key = COUNT_OF[v];
    return key && counts ? counts[key] : 0;
  };
  const pill = (v: InboxView) => {
    const n = count(v);
    return n > 0 ? (
      <span
        className={`count-pill${WARN_PILL[v] ? ' count-pill--warning' : ''}`}
        data-testid={`count-${v}`}
      >
        {n}
      </span>
    ) : null;
  };
  const shown = phone ? VIEWS.filter((v) => !PHONE_MORE.includes(v)) : VIEWS;
  const inMore = phone && PHONE_MORE.includes(filter.view);
  return (
    <nav className="tabs inbox__views" aria-label="Views">
      {shown.map((v) => {
        const current = v === filter.view;
        return (
          <Link
            key={v}
            to={to({ ...filter, view: v })}
            className="tabs__tab"
            title={VIEW_SHORT_LABEL[v] === VIEW_LABEL[v] ? undefined : VIEW_LABEL[v]}
            data-state={current ? 'active' : 'inactive'}
            aria-current={current ? 'page' : undefined}
          >
            {VIEW_SHORT_LABEL[v]}
            {pill(v)}
          </Link>
        );
      })}
      {phone && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger
            className="tabs__tab inbox__more"
            data-state={inMore ? 'active' : 'inactive'}
            aria-label={inMore ? `More views, ${VIEW_LABEL[filter.view]} selected` : 'More views'}
          >
            {inMore ? VIEW_SHORT_LABEL[filter.view] : 'More'}
            {pill('flagged')}
            <Glyph name="chevron-down" size={14} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
              {PHONE_MORE.map((v) => (
                <DropdownMenu.Item key={v} className="menu__item" asChild>
                  <Link
                    to={to({ ...filter, view: v })}
                    aria-current={v === filter.view ? 'page' : undefined}
                  >
                    {VIEW_LABEL[v]}
                    {count(v) > 0 && ` (${count(v)})`}
                  </Link>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </nav>
  );
}

/** A removable active-filter chip (FEAT-075 ui-design Filters panel). */
function FilterChip({ text, to }: { text: string; to: string }) {
  return (
    <li className="filter-chip">
      {text}
      <Link className="filter-chip__remove" to={to} aria-label={`Remove filter ${text}`}>
        <Glyph name="x" size={12} />
      </Link>
    </li>
  );
}

const assigneeLabel = (a: string, members: { userId: string; name: string }[] | undefined) =>
  a === 'me'
    ? 'Mine'
    : a === 'none'
      ? 'Unassigned'
      : (members?.find((m) => m.userId === a)?.name ?? 'A team member');

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

/** The open conversation's summary from any cached list page, when the thread isn't loaded. */
function rowsOf(queryClient: QueryClient, id: string) {
  for (const [, data] of queryClient.getQueriesData<InfiniteData<ConversationList, unknown>>({
    queryKey: ['conversations'],
  })) {
    const hit = flattenPages(data).find((c) => c.id === id);
    if (hit) return hit;
  }
  return undefined;
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
