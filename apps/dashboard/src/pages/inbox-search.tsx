import type { SearchMatch } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api } from '../lib/api.ts';
import {
  authorLabel,
  commitSearch,
  highlightParts,
  markOpened,
  onFocusInboxSearch,
  resetInboxSearch,
  resultsStatus,
  searchKey,
  setSearchText,
  useInboxSearch,
} from '../lib/search.ts';
import { Icon } from '../shell/icon.tsx';
import { Row } from './inbox-row.tsx';

/**
 * The inbox's search field (FEAT-046, ui-design SCR-APP-014 "Search field"): searches 300 ms
 * after typing stops, at once on Enter; Escape or Clear ends the search, focus staying here.
 */
export function SearchField() {
  const { text } = useInboxSearch();
  const ref = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => onFocusInboxSearch(() => ref.current?.focus()), []);
  // The top bar's button from another page: focus once, then drop the flag from history.
  const focusSearch = (location.state as { focusSearch?: boolean } | null)?.focusSearch;
  useEffect(() => {
    if (!focusSearch) return;
    ref.current?.focus();
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [focusSearch, location.pathname, location.search, navigate]);

  const clear = () => {
    resetInboxSearch();
    ref.current?.focus();
  };

  return (
    <div className="search-field">
      <label className="sr-only" htmlFor="inbox-search">
        Search conversations
      </label>
      <span className="search-field__icon">
        <Icon name="search" size={16} />
      </span>
      <input
        ref={ref}
        id="inbox-search"
        type="search"
        className="input search-field__input"
        aria-describedby="inbox-search-help"
        placeholder="e.g. Mei Ling, 9123 4567"
        autoComplete="off"
        maxLength={100}
        value={text}
        onChange={(e) => setSearchText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitSearch();
          } else if (e.key === 'Escape' && text) {
            e.preventDefault();
            clear();
          }
        }}
      />
      {text && (
        <button
          type="button"
          className="icon-button search-field__clear"
          aria-label="Clear search"
          onClick={clear}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
      <span id="inbox-search-help" className="sr-only">
        Search by name, email, phone or anything said in a chat.
      </span>
    </div>
  );
}

function Excerpt({ match }: { match: SearchMatch }) {
  return (
    <span className="conversation-row__preview search-excerpt" data-testid="search-excerpt">
      <span className="search-excerpt__author">{authorLabel(match.author)}:</span>{' '}
      {highlightParts(match.excerpt, match.ranges).map((p, i) =>
        p.hit ? (
          <mark key={i} className="search-hit">
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </span>
  );
}

/** The results region that replaces the tabs, filters and list while a search is active. */
export function SearchResults({
  qs,
  selected,
  meId,
  now,
}: {
  qs: string;
  selected: string | null;
  meId: string | null;
  now: Date;
}) {
  const { query, opened } = useInboxSearch();
  const results = useInfiniteQuery({
    queryKey: searchKey(query),
    queryFn: ({ pageParam }) => api.searchConversations({ q: query, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: query !== '',
    staleTime: 30_000,
  });
  const rows = results.data?.pages.flatMap((p) => p.results) ?? [];
  const searching = query === '' || (results.isPending && results.fetchStatus !== 'idle');
  const failed = query !== '' && results.isError && !results.data;
  const listRef = useRef<HTMLUListElement>(null);

  // Back from a result (one pane): bring its row into view once.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !opened || selected || rows.length === 0) return;
    scrolled.current = true;
    listRef.current
      ?.querySelector(`[data-id="${CSS.escape(opened)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [opened, selected, rows.length]);

  const status = searching
    ? 'Searching…'
    : failed
      ? ''
      : rows.length === 0
        ? 'No conversations match'
        : resultsStatus(rows.length, Boolean(results.hasNextPage));

  return (
    <div
      className="inbox__rows search-results"
      role="region"
      aria-label="Search results"
      aria-busy={searching || results.isFetchingNextPage}
      data-testid="search-results"
    >
      <p className="search-results__status" role="status">
        {status}
      </p>
      {searching && (
        <ul className="conversation-list" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="conversation-row conversation-row--skeleton">
              <span className="skeleton-line" />
            </li>
          ))}
        </ul>
      )}
      {failed && (
        <ErrorState
          title="Couldn't search conversations"
          action={
            <Button variant="secondary" onClick={() => void results.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {!searching && results.isSuccess && rows.length === 0 && (
        <EmptyState
          title={`No conversations match “${query}”`}
          action={
            <Button variant="secondary" onClick={() => resetInboxSearch()}>
              Clear search
            </Button>
          }
        >
          Check the spelling, or search part of a name, email or phone number.
        </EmptyState>
      )}
      {!searching && rows.length > 0 && (
        <ul
          ref={listRef}
          className="conversation-list"
          aria-label="Matching conversations"
          data-testid="search-list"
        >
          {rows.map(({ conversation: c, match }) => (
            <Row
              key={c.id}
              c={c}
              qs={qs}
              selected={c.id === selected}
              meId={meId}
              now={now}
              preview={<Excerpt match={match} />}
              linkState={{ matchId: match.messageId }}
              onOpen={() => markOpened(c.id)}
            />
          ))}
        </ul>
      )}
      {!searching && results.hasNextPage && (
        <div className="load-more">
          <Button
            variant="secondary"
            className="load-more__button"
            onClick={() => void results.fetchNextPage()}
            disabled={results.isFetchingNextPage}
          >
            {results.isFetchingNextPage && <span className="spinner" aria-hidden="true" />}
            {results.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      {results.isFetchNextPageError && (
        <div className="alert alert--danger" role="alert">
          Couldn't load more.{' '}
          <Button variant="ghost" onClick={() => void results.fetchNextPage()}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
