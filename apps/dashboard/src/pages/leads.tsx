import type { LeadRow, LeadScore } from '@kaki/contracts';
import { Button, EmptyState, ErrorState } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api.ts';
import { useToast } from '../lib/form.ts';
import { rowTime } from '../lib/inbox.ts';
import {
  exportTitle,
  leadsQueryOf,
  leadsSearchOf,
  SCORE_LABEL,
  SOURCE_LABEL,
  STATUS_TABS,
  tabCount,
  useLeads,
  type LeadsFilter,
} from '../lib/leads.ts';
import { Glyph } from './conversation-parts.tsx';
import { ExportDialog, ScoreChip, StatusChip, WithdrawnChip } from './leads-parts.tsx';

/**
 * `/leads`: SCR-APP-032 Leads (LED-05, LED-08; FEAT-050 ui-design). Chat and contact-form
 * leads with status tabs, a score filter and "Load more"; Owner and Admin export the CSV.
 * No live updates (D6): it refetches on window focus and after a status change.
 */
export function LeadsPage() {
  const [search, setSearch] = useSearchParams();
  const filter = leadsQueryOf(search);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const canExport = me.data?.role === 'owner' || me.data?.role === 'admin';
  const list = useLeads(filter);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = list.data?.pages[0]?.counts;
  const [exporting, setExporting] = useState(false);
  const exportButton = useRef<HTMLButtonElement>(null);
  const [toast, setToast] = useToast();
  const now = new Date();

  const go = (f: LeadsFilter) => setSearch(leadsSearchOf(f), { replace: true });
  const noLeads = counts ? tabCount(counts, 'all') === 0 : false;

  return (
    <div className="leads">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="page-title">Leads</h1>
          <p className="page-lede">
            People who left their details in chat or on your contact form.
          </p>
        </div>
        {canExport && (
          <Button ref={exportButton} variant="secondary" onClick={() => setExporting(true)}>
            <Glyph name="download" /> Export CSV
          </Button>
        )}
      </div>
      <div className="leads-filters">
        <nav className="tabs leads-tabs" aria-label="Lead status">
          {STATUS_TABS.map((t) => (
            <Link
              key={t.value}
              className="tabs__tab"
              to={`/leads${leadsSearchOf({ ...filter, status: t.value })}`}
              aria-current={filter.status === t.value ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                go({ ...filter, status: t.value });
              }}
            >
              {t.label}
              {counts && (
                <span className="count-pill count-pill--neutral">
                  {tabCount(counts, t.value)}
                  <span className="sr-only"> leads</span>
                </span>
              )}
            </Link>
          ))}
        </nav>
        <label className="field field--inline leads-score">
          <span className="field__label">Score</span>
          <select
            className="input"
            value={filter.score ?? ''}
            onChange={(e) =>
              go({ ...filter, score: (e.target.value || undefined) as LeadScore | undefined })
            }
          >
            <option value="">Any</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
          </select>
        </label>
      </div>

      {list.isPending && (
        <div className="fact-table" aria-busy="true" aria-label="Loading leads">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      )}
      {list.isError && (
        <ErrorState
          title="Couldn't load leads"
          action={
            <Button variant="secondary" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {list.isSuccess && items.length === 0 && noLeads && !filter.score && (
        <EmptyState
          title="No leads yet"
          action={<Link to="/settings/leads">Check lead settings</Link>}
        >
          When a visitor leaves their details, they appear here.
        </EmptyState>
      )}
      {list.isSuccess && items.length === 0 && !(noLeads && !filter.score) && (
        <EmptyState
          title={`No ${filter.score ? `${SCORE_LABEL[filter.score]} ` : ''}leads in ${
            STATUS_TABS.find((t) => t.value === filter.status)?.label ?? 'Open'
          }`}
          action={
            filter.score ? (
              <Button variant="secondary" onClick={() => go({ ...filter, score: undefined })}>
                Clear score filter
              </Button>
            ) : undefined
          }
        />
      )}
      {items.length > 0 && (
        <table className="fact-table lead-table" data-testid="lead-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Contact</th>
              <th scope="col">Need</th>
              <th scope="col">Score</th>
              <th scope="col">Status</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <LeadTableRow key={l.id} lead={l} now={now} back={leadsSearchOf(filter)} />
            ))}
          </tbody>
        </table>
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
      {canExport && (
        <ExportDialog
          open={exporting}
          onOpenChange={setExporting}
          title={exportTitle(filter, counts, items.length, list.isSuccess && !list.hasNextPage)}
          filter={filter}
          returnTo={exportButton}
          onToast={setToast}
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

function LeadTableRow({ lead, now, back }: { lead: LeadRow; now: Date; back: string }) {
  const contact = [lead.email, lead.phone].filter(Boolean).join(' · ');
  const need = lead.need?.split('\n')[0] ?? '';
  return (
    <tr className="fact-row lead-row" data-testid="lead-row" data-status={lead.status}>
      <td className="fact-row__title lead-row__name">
        <Link to={`/leads/${lead.id}`} state={{ back }}>
          {lead.name || 'No name given'}
        </Link>
      </td>
      <td className="fact-row__meta lead-row__contact">{contact}</td>
      <td className="fact-row__meta lead-row__need">{need}</td>
      <td className="lead-row__score">
        <ScoreChip scoring={lead.scoring} />
      </td>
      <td className="lead-row__status">
        <StatusChip status={lead.status} />{' '}
        <span className="lead-row__source">{SOURCE_LABEL[lead.source]}</span>
        {lead.consentWithdrawnAt && <WithdrawnChip />}
      </td>
      <td className="fact-row__meta lead-row__updated">{rowTime(lead.updatedAt, now)}</td>
    </tr>
  );
}
