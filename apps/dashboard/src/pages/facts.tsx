import type { Fact, FactStatus, FactType } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import {
  factTitle,
  factValue,
  needsGst,
  promotionWindow,
  STATUS_LABEL,
  STATUS_TONE,
  TYPE_LABEL,
  updatedLabel,
} from '../lib/facts.ts';
import { DeleteFactDialog, type DeleteOutcome } from './delete-fact.tsx';
import { KnowledgeTabs } from './knowledge-tabs.tsx';

/** "GST to check" filters on `gst=unknown` rather than a status (FEAT-011 ui-design). */
type StatusFilter = FactStatus | 'gst' | '';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'conflicted', label: 'Conflicted' },
  { value: 'gst', label: 'GST to check' },
];

const TYPE_FILTERS: { value: FactType | ''; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'product', label: 'Products and services' },
  { value: 'faq', label: 'FAQs' },
  { value: 'policy', label: 'Policies' },
  { value: 'promotion', label: 'Promotions' },
];

export function StatusBadge({ status, busy }: { status: FactStatus; busy?: boolean }) {
  return (
    <span className={`status-badge status-badge--${STATUS_TONE[status]}`} aria-busy={busy}>
      {busy ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <span className="status-badge__dot" aria-hidden="true" />
      )}
      {busy ? 'Updating…' : STATUS_LABEL[status]}
    </span>
  );
}

const DELETE_TOAST: Record<DeleteOutcome, string> = {
  deleted: 'Fact deleted.',
  'already-deleted': 'This fact was already deleted.',
};

/** SCR-APP-027 Facts (KB-07, KB-15; FEAT-022 and FEAT-011 ui-design). */
export function FactsPage() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [type, setType] = useState<FactType | ''>('');
  const [deleting, setDeleting] = useState<Fact | null>(null);
  // "Facts found" on SCR-APP-024 links here with the source (FEAT-012).
  const [params, setParams] = useSearchParams();
  const sourceId = params.get('sourceId') ?? undefined;
  // Search runs a moment after typing stops, not on each keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const filtered = Boolean(search || status || type || sourceId);
  const list = useInfiniteQuery({
    queryKey: ['facts', type, status, search, sourceId],
    queryFn: ({ pageParam }) =>
      api.facts({
        sourceId,
        type: type || undefined,
        status: status && status !== 'gst' ? status : undefined,
        gst: status === 'gst' ? 'unknown' : undefined,
        q: search || undefined,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const facts = list.data?.pages.flatMap((p) => p.facts) ?? [];
  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  const loadFailed = list.isError && !forbidden && facts.length === 0;
  const empty = list.isSuccess && facts.length === 0;

  const toggle = useMutation({
    mutationFn: (f: Fact) =>
      api.updateFact(f.id, {
        version: f.version,
        status: f.status === 'disabled' ? 'approved' : 'disabled',
      }),
    onSuccess: async ({ fact }) => {
      await queryClient.invalidateQueries({ queryKey: ['facts'] });
      setToast(
        fact.status === 'disabled'
          ? 'Fact disabled. Your assistant no longer uses it.'
          : 'Fact enabled. Your assistant uses it from now on.',
      );
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['facts'] });
      setToast(null);
    },
  });

  const clear = () => {
    setQ('');
    setSearch('');
    setStatus('');
    setType('');
    if (sourceId) setParams({});
  };

  const addButton = (
    <Button asChild>
      <Link to="/knowledge/facts/new">Add a fact</Link>
    </Button>
  );

  return (
    <div className="facts">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title" ref={headingRef} tabIndex={-1}>
            Facts
          </h1>
          <p className="page-lede">
            What your assistant knows. Facts you add here are used in answers right away.
          </p>
        </div>
        {!forbidden && addButton}
      </div>
      {!forbidden && <KnowledgeTabs />}
      {sourceId && (
        <p className="facts__source-filter">
          Showing the facts from one source.{' '}
          <Button variant="ghost" className="kaki-btn--sm" onClick={() => setParams({})}>
            Show all facts
          </Button>
        </p>
      )}

      {forbidden && (
        <EmptyState title="You can't manage facts">
          Only the Owner or an Admin can manage facts.
        </EmptyState>
      )}

      {!forbidden && (!empty || filtered) && (
        <div className="filters" role="search">
          <label className="field field--inline">
            <span className="sr-only">Search facts</span>
            <input
              className="input"
              type="search"
              placeholder="Search facts, e.g. cake or refund"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <label className="field field--inline">
            <span className="sr-only">Type</span>
            <select
              className="input"
              value={type}
              onChange={(e) => setType(e.target.value as FactType | '')}
            >
              {TYPE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--inline">
            <span className="sr-only">Status</span>
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {list.isPending && (
        <div className="fact-table" aria-busy="true" aria-label="Loading facts">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      )}

      {loadFailed && (
        <ErrorState
          title="We couldn't load your facts"
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        >
          Nothing you saved is lost.
        </ErrorState>
      )}

      {empty && !filtered && (
        <EmptyState title="No facts yet" action={addButton}>
          Add your prices and common questions, and your assistant will answer with them.
        </EmptyState>
      )}
      {empty && filtered && (
        <EmptyState
          title="No facts match your search"
          action={
            <Button variant="secondary" onClick={clear}>
              Clear filters
            </Button>
          }
        />
      )}

      {facts.length > 0 && (
        <table className="fact-table" data-testid="fact-table">
          <thead>
            <tr>
              <th scope="col">Fact</th>
              <th scope="col">Type</th>
              <th scope="col">Value</th>
              <th scope="col">Status</th>
              <th scope="col">Updated</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => {
              const busy = toggle.isPending && toggle.variables?.id === f.id;
              const window = f.type === 'promotion' ? promotionWindow(f) : null;
              return (
                <tr key={f.id} className="fact-row" data-testid="fact-row">
                  <td className="fact-row__title">
                    <Link to={`/knowledge/facts/${f.id}`}>{factTitle(f)}</Link>
                  </td>
                  <td className="fact-row__meta">{TYPE_LABEL[f.type]}</td>
                  <td className="fact-row__meta fact-row__value">
                    {factValue(f)}
                    {needsGst(f) && <span className="chip chip--warning">GST to check</span>}
                    {window && window.state !== 'running' && (
                      <span className="chip chip--neutral">{window.label}</span>
                    )}
                  </td>
                  <td className="fact-row__status">
                    <StatusBadge status={f.status} busy={busy} />
                  </td>
                  <td className="fact-row__meta fact-row__updated">
                    <time dateTime={f.updatedAt}>{updatedLabel(f.updatedAt)}</time>
                  </td>
                  <td className="fact-row__actions">
                    <RowMenu
                      fact={f}
                      disabled={busy}
                      onToggle={() => toggle.mutate(f)}
                      onDelete={() => setDeleting(f)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {list.hasNextPage && !list.isFetchNextPageError && (
        <div className="load-more">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            aria-busy={list.isFetchingNextPage || undefined}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more facts'}
          </Button>
        </div>
      )}
      {list.isFetchNextPageError && (
        <div className="alert alert--danger" role="alert">
          <p>We couldn't load more facts.</p>
          <Button variant="secondary" onClick={() => void list.fetchNextPage()}>
            Try again
          </Button>
        </div>
      )}

      <DeleteFactDialog
        fact={deleting}
        onClose={() => setDeleting(null)}
        onConflict={() => void queryClient.invalidateQueries({ queryKey: ['facts'] })}
        onDone={async (outcome) => {
          setDeleting(null);
          await queryClient.invalidateQueries({ queryKey: ['facts'] });
          setToast(DELETE_TOAST[outcome]);
          headingRef.current?.focus();
        }}
      />

      <div className="sr-only" aria-live="polite">
        {list.data ? `${facts.length} facts shown` : ''}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/** The row's ⋯ menu: use or stop using in answers, then Delete… (FEAT-011 ui-design). */
function RowMenu({
  fact,
  disabled,
  onToggle,
  onDelete,
}: {
  fact: Fact;
  disabled: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const togglable = fact.status === 'approved' || fact.status === 'disabled';
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className="icon-button"
        aria-label={`Actions for ${factTitle(fact)}`}
        disabled={disabled}
      >
        <span aria-hidden="true">⋯</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
          {togglable && (
            <>
              <DropdownMenu.Item className="menu__item" onSelect={onToggle}>
                {fact.status === 'disabled' ? 'Use in answers' : 'Stop using in answers'}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="menu__divider" />
            </>
          )}
          <DropdownMenu.Item className="menu__item menu__item--danger" onSelect={onDelete}>
            Delete…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
