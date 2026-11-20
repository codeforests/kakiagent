import type { DsrSummary } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { dsrDay, rowLabel, TYPE_LABEL, useDataRequests } from '../lib/data-requests.ts';
import { useToast } from '../lib/form.ts';
import { Breadcrumb, DueChip, RequestFormDialog, StatusChip } from './data-request-parts.tsx';

/**
 * `/settings/privacy/requests`: SCR-APP-048 Data requests (GOV-05, UC-30; FEAT-061 ui-design),
 * Owner and Admin. Open and Closed tabs (the view in the URL); open requests sort by due date.
 * No live updates: it refetches on window focus.
 */
export function DataRequestsPage() {
  const [search, setSearch] = useSearchParams();
  const view = search.get('view') === 'closed' ? 'closed' : 'open';
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const allowed = me.data ? me.data.role === 'owner' || me.data.role === 'admin' : undefined;
  const list = useDataRequests(view, allowed === true);
  // The Open tab's count comes from either view's first page.
  const counts = list.data?.pages[0]?.counts;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const [creating, setCreating] = useState(false);
  const [toast] = useToast();
  const navigate = useNavigate();
  const forbidden =
    allowed === false || (list.error instanceof ApiError && list.error.status === 403);

  const header = (
    <>
      <Breadcrumb current="Data requests" />
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Data requests</h1>
          <p className="page-lede">
            PDPA gives customers the right to see, correct or delete their data. Each request is due
            30 days after you receive it.
          </p>
        </div>
        {allowed && <Button onClick={() => setCreating(true)}>New request</Button>}
      </div>
    </>
  );

  if (forbidden)
    return (
      <div className="dsr-page">
        {header}
        <EmptyState title="You don't have access to this page">
          Only the Owner and Admins can handle data requests.
        </EmptyState>
      </div>
    );

  return (
    <div className="dsr-page">
      {header}
      <nav className="tabs dsr-tabs" aria-label="Request status">
        {(['open', 'closed'] as const).map((v) => (
          <Link
            key={v}
            className="tabs__tab"
            to={v === 'closed' ? '?view=closed' : '?'}
            aria-current={view === v ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setSearch(v === 'closed' ? { view: 'closed' } : {}, { replace: true });
            }}
          >
            {v === 'open' ? 'Open' : 'Closed'}
            {v === 'open' && counts && (
              <span className="count-pill count-pill--neutral">
                {counts.open}
                <span className="sr-only"> open requests</span>
              </span>
            )}
          </Link>
        ))}
      </nav>

      {(list.isPending || me.isPending) && (
        <div className="fact-table" aria-busy="true" aria-label="Loading data requests">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      )}
      {list.isError && (
        <ErrorState
          title="Couldn't load data requests"
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {list.isSuccess && items.length === 0 && view === 'open' && (
        <EmptyState
          title="No open requests"
          action={<Button onClick={() => setCreating(true)}>New request</Button>}
        >
          When a customer asks for their data, log it here. Requests from chats appear on their own.
        </EmptyState>
      )}
      {list.isSuccess && items.length === 0 && view === 'closed' && (
        <EmptyState title="No closed requests yet" />
      )}
      {items.length > 0 && (
        <>
          <div className="table-scroll dsr-table-wrap">
            <table className="fact-table dsr-table" data-testid="dsr-table">
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">Type</th>
                  <th scope="col">Received</th>
                  <th scope="col">Due</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <RequestRow key={r.id} r={r} />
                ))}
              </tbody>
            </table>
          </div>
          <ul className="dsr-cards" data-testid="dsr-cards">
            {items.map((r) => (
              <li key={r.id} className="dsr-card">
                <Link
                  className="dsr-card__link"
                  to={`/settings/privacy/requests/${r.id}`}
                  aria-label={rowLabel(r)}
                >
                  <span className="dsr-card__line">
                    <span className="dsr-ref">{r.ref}</span>
                    <DueChip r={r} />
                  </span>
                  <span className="dsr-card__line dsr-card__meta">
                    {TYPE_LABEL[r.type]} · <StatusChip status={r.status} /> · {dsrDay(r.receivedOn)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {list.hasNextPage && (
        <div className="load-more">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            aria-busy={list.isFetchingNextPage || undefined}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      {allowed && (
        <RequestFormDialog
          open={creating}
          onOpenChange={setCreating}
          onSaved={(d) =>
            void navigate(`/settings/privacy/requests/${d.id}`, {
              state: { toast: `Request logged. Due ${dsrDay(d.dueOn)}.` },
            })
          }
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function RequestRow({ r }: { r: DsrSummary }) {
  return (
    <tr className="fact-row dsr-row" data-testid="dsr-row" data-status={r.status}>
      <td className="fact-row__title">
        <Link to={`/settings/privacy/requests/${r.id}`} aria-label={rowLabel(r)}>
          <span className="dsr-ref">{r.ref}</span>
        </Link>
        <span className="dsr-row__who">{r.requesterLabel}</span>
      </td>
      <td>{TYPE_LABEL[r.type]}</td>
      <td className="fact-row__meta">{dsrDay(r.receivedOn)}</td>
      <td>
        <DueChip r={r} />
      </td>
      <td>
        <StatusChip status={r.status} />
      </td>
    </tr>
  );
}
