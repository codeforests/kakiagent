import type { ApprovalSummary } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.ts';
import {
  formatSgd,
  KIND_LABEL,
  slaChip,
  STATUS_LABEL,
  useApprovals,
  useNow,
  usePendingApprovals,
  type ApprovalView,
} from '../lib/approvals.ts';
import { rowTime } from '../lib/inbox.ts';
import { approvalEvents, type ApprovalNotice } from '../lib/realtime.ts';
import { Icon } from '../shell/icon.tsx';

/**
 * `/approvals`: SCR-APP-017 Approvals (APR-02, APR-04; FEAT-055 ui-design). Pending (overdue,
 * then urgent, then by due time: the server's order) or decided in the last 30 days. Every
 * member sees it; an Agent without approval rights only reads (D8).
 */
export function ApprovalsPage() {
  const [search, setSearch] = useSearchParams();
  const view: ApprovalView = search.get('view') === 'decided' ? 'decided' : 'pending';
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const count = usePendingApprovals();
  const list = useApprovals(view);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const now = useNow();
  const live = useDecidedElsewhere(view === 'pending' ? items : []);

  return (
    <div className="approvals">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Approvals</h1>
          <p className="page-lede">
            Quotes, discounts and promises your assistant needs you to confirm. Nothing is sent to
            the visitor until someone decides.
          </p>
        </div>
      </div>
      {me.data && !me.data.canApprove && (
        <div className="alert alert--info">
          <p>You can see approvals but not decide them. Ask the Owner for approval rights.</p>
        </div>
      )}
      <nav className="tabs" aria-label="Approvals">
        {(
          [
            ['pending', 'Pending'],
            ['decided', 'Decided'],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={value}
            className="tabs__tab"
            to={value === 'pending' ? '/approvals' : '/approvals?view=decided'}
            aria-current={view === value ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setSearch(value === 'pending' ? {} : { view: value }, { replace: true });
            }}
          >
            {label}
            {value === 'pending' && count.data ? (
              <span className="count-pill count-pill--pending">
                {count.data}
                <span className="sr-only"> waiting</span>
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      <p className="sr-only" aria-live="polite" data-testid="approvals-live">
        {live}
      </p>
      {list.isPending && (
        <ul className="source-list" aria-busy="true" aria-label="Loading approvals">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="skeleton-row" />
          ))}
        </ul>
      )}
      {list.isError && (
        <ErrorState
          title="Couldn't load approvals"
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {list.isSuccess && items.length === 0 && view === 'pending' && (
        <EmptyState
          title="Nothing waiting for approval"
          action={<Link to="/settings/rules">Review your rules</Link>}
        >
          When a visitor asks for a quote, discount or promise, it appears here for you to confirm.
        </EmptyState>
      )}
      {list.isSuccess && items.length === 0 && view === 'decided' && (
        <EmptyState title="No decisions in the last 30 days" />
      )}
      {items.length > 0 && (
        <ul
          className="source-list approval-list"
          aria-label={view === 'pending' ? 'Pending approvals' : 'Decided approvals'}
        >
          {items.map((a) => (
            <ApprovalRow key={a.id} a={a} now={now} />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <div className="load-more">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function ApprovalRow({ a, now }: { a: ApprovalSummary; now: Date }) {
  const pending = a.status === 'pending';
  const sla = pending ? slaChip(a, now) : null;
  const who = a.contactName || 'Website visitor';
  return (
    <li className="source-row approval-row" data-testid="approval-row" data-status={a.status}>
      <div className="approval-row__main">
        <Link className="approval-row__link" to={`/approvals/${a.id}`}>
          {a.headline || KIND_LABEL[a.kind]}
        </Link>
        <span className="approval-row__who">{who}</span>
        <div className="approval-row__chips">
          <span className="chip chip--neutral">
            <Icon name="approvals" size={14} /> {KIND_LABEL[a.kind]}
          </span>
          {sla && <span className={`chip chip--${sla.tone}`}>{sla.text}</span>}
          {pending && a.aboveMaxDiscount && (
            <span className="chip chip--warning">Above your maximum</span>
          )}
          {!pending && (
            <span className={`chip chip--${STATUS_LABEL[a.status].tone}`}>
              {STATUS_LABEL[a.status].label}
            </span>
          )}
        </div>
      </div>
      <div className="approval-row__side">
        <span className="approval-row__total">
          {a.totalCents === null ? 'Price to set' : formatSgd(a.totalCents)}
        </span>
        <span className="source-row__meta">
          {/* The summary carries no decider (contract §3): the page shows who decided. */}
          Asked {rowTime(a.createdAt, now)}
        </span>
      </div>
    </li>
  );
}

/**
 * The polite note when a row on screen is decided by someone else (ui-design SCR-APP-017):
 * "Approval for Website visitor was decided by Mei Ling". Not `role="status"` (code-map pitfall).
 */
function useDecidedElsewhere(visible: ApprovalSummary[]): string {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const rows = useRef(visible);
  useEffect(() => {
    rows.current = visible;
  });
  useEffect(() => {
    const on = (e: Event) => {
      const { id, status } = e as ApprovalNotice;
      const row = rows.current.find((r) => r.id === id);
      if (!row || status === 'pending') return;
      const who = row.contactName || 'Website visitor';
      void queryClient
        .fetchQuery({ queryKey: ['approval', id], queryFn: () => api.approval(id) })
        .then((d) => {
          const me = queryClient.getQueryData<{ user: { id: string } }>(['me'])?.user.id;
          if (d.decision?.by?.userId === me) return;
          setNote(
            d.decision?.by
              ? `Approval for ${who} was decided by ${d.decision.by.name}`
              : `Approval for ${who} was decided`,
          );
        })
        .catch(() => setNote(`Approval for ${who} was decided`));
    };
    approvalEvents.addEventListener('approval', on);
    return () => approvalEvents.removeEventListener('approval', on);
  }, [queryClient]);
  return note;
}
