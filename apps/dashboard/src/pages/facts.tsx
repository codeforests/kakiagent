import type { FactStatus } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { factTitle, factValue, STATUS_LABEL, STATUS_TONE, updatedLabel } from '../lib/facts.ts';

const FILTERS: { value: FactStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'needs_review', label: 'Needs review' },
];

export function StatusBadge({ status }: { status: FactStatus }) {
  return (
    <span className={`status-badge status-badge--${STATUS_TONE[status]}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

const SAVED = 'Fact saved. Your assistant uses it from now on.';

/** The saved toast (design.md §4.3): `role="status"`, gone after 5 s. */
function useSavedToast() {
  const location = useLocation();
  const navigate = useNavigate();
  const [toast, setToast] = useState(() =>
    (location.state as { saved?: boolean } | null)?.saved ? SAVED : null,
  );
  useEffect(() => {
    if (!toast) return;
    // Drop the router state so a reload doesn't show the toast again.
    void navigate(location.pathname, { replace: true, state: null });
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast, navigate, location.pathname]);
  return toast;
}

/** SCR-APP-027 Facts (KB-07). */
export function FactsPage() {
  const toast = useSavedToast();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<FactStatus | ''>('');
  // Search runs a moment after typing stops, not on each keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const filtered = Boolean(search || status);
  const list = useQuery({
    queryKey: ['facts', status, search],
    queryFn: () => api.facts({ status: status || undefined, q: search || undefined }),
  });
  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  const empty = list.data?.facts.length === 0;

  const addButton = (
    <Button asChild>
      <Link to="/knowledge/facts/new">Add a fact</Link>
    </Button>
  );

  return (
    <div className="facts">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Facts</h1>
          <p className="page-lede">
            What your assistant knows. Facts you add here are used in answers right away.
          </p>
        </div>
        {!forbidden && addButton}
      </div>

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
              placeholder="Search facts, e.g. cake"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <label className="field field--inline">
            <span className="sr-only">Status</span>
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as FactStatus | '')}
            >
              {FILTERS.map((f) => (
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

      {list.isError && !forbidden && (
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
            <Button
              variant="secondary"
              onClick={() => {
                setQ('');
                setSearch('');
                setStatus('');
              }}
            >
              Clear filters
            </Button>
          }
        />
      )}

      {list.data && list.data.facts.length > 0 && (
        <table className="fact-table" data-testid="fact-table">
          <thead>
            <tr>
              <th scope="col">Fact</th>
              <th scope="col">Type</th>
              <th scope="col">Value</th>
              <th scope="col">Status</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {list.data.facts.map((f) => (
              <tr key={f.id} className="fact-row" data-testid="fact-row">
                <td className="fact-row__title">
                  <Link to={`/knowledge/facts/${f.id}`}>{factTitle(f)}</Link>
                </td>
                <td className="fact-row__meta">{f.type === 'product' ? 'Product' : 'FAQ'}</td>
                <td className="fact-row__meta fact-row__value">{factValue(f)}</td>
                <td className="fact-row__status">
                  <StatusBadge status={f.status} />
                </td>
                <td className="fact-row__meta fact-row__updated">
                  <time dateTime={f.updatedAt}>{updatedLabel(f.updatedAt)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="sr-only" aria-live="polite">
        {list.data ? `${list.data.facts.length} facts` : ''}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
